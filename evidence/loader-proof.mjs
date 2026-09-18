/**
 * Loader-level proofs for the Phase 4 M1 assembly (zero API, zero network).
 *
 * Three facts are established against the REAL profiles and the REAL loader:
 *   1. the profile entry id `context-compact` is a live loader id (a second insert of the same id is
 *      rejected with "duplicate loader entry id");
 *   2. the INSTALLED bytes of the plugin mount in a real cordis Context inside the profile directory
 *      and report the frozen disabled-by-default shape;
 *   3. (the `eval` profile only) with its own `llm-replay` fixture path unset, the assembled tree gets
 *      all the way to that plugin's documented fail-loud and reports NOTHING about context-compact.
 *
 * The `eval` smoke run is zero-API because that profile's `llm-replay` fails loud before any model
 * call. The `record-eval` profile has NO replay plugin, so running it would be a REAL model call —
 * this script therefore never runs it: its assembly is proven by the dump-config entry, the live
 * loader id, and the installed-bytes mount.
 *
 * The probe file is written inside the profile and removed again; the caller re-runs
 * `evidence/profile-digest.mjs --compare` to prove no residue.
 *
 * Run:  node evidence/loader-proof.mjs
 *
 * @module @sol-pi-port/dsh-context-compact/evidence/loader-proof
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PROFILES = ["eval", "record-eval"];
const scratch = await mkdtemp(join(tmpdir(), "cc-loader-proof-"));
let checks = 0;
let failures = 0;

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function ok(label, condition, detail) {
	checks += 1;
	if (!condition) failures += 1;
	console.log(`${condition ? "  PASS  " : "  FAIL  "}${label}${detail === undefined ? "" : `   [${detail}]`}`);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ code: number, output: string }}
 */
function dsh(args, cwd) {
	try {
		return { code: 0, output: execFileSync("dsh", args, { cwd, encoding: "utf8", timeout: 240000 }).trim() };
	} catch (error) {
		return { code: error.status ?? -1, output: `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`.trim() };
	}
}

const duplicatePatch = join(scratch, "duplicate-id.yml");
await writeFile(duplicatePatch, "- insert:\n    - id: context-compact\n      name: '@sol-pi-port/dsh-context-compact'\n");

console.log("# dsh-context-compact — loader-level assembly proofs");
console.log("");

for (const profile of PROFILES) {
	const dir = join(homedir(), ".dsh", "profiles", profile);
	console.log(`### ${profile}`);

	if (profile === "eval") {
		/* Zero API: this profile's llm-replay refuses to start without a fixture, before any model call. */
		const smoke = dsh(["--profile", profile, "say hi"], dir);
		const llmReplayOnly = smoke.code !== 0 && /llm-replay: a fixture path is required/.test(smoke.output) && !/context-compact/.test(smoke.output);
		ok("the assembled tree loads and stops only at llm-replay's fixture requirement", llmReplayOnly, `exit ${smoke.code}`);
	} else {
		ok("record-eval is never executed here (it has no replay plugin, so a run would be a real API call)", true, "skipped by design");
	}

	const duplicate = dsh(["--profile", profile, "--patch", duplicatePatch, "say hi"], dir);
	ok("re-inserting the id is rejected (the profile entry is a live loader id)", /duplicate loader entry id: context-compact/.test(duplicate.output), `exit ${duplicate.code}`);

	const probePath = join(dir, "cc-m1-probe.mjs");
	await writeFile(probePath, [
		`import { Context, Service } from "@deepseek-ai/cordis";`,
		`import * as plugin from "@sol-pi-port/dsh-context-compact";`,
		`const ctx = new Context();`,
		`Object.defineProperty(ctx, "logger", { value: { warn() {}, info() {} }, configurable: true, writable: true });`,
		`// The plugin declares module-level inject, so cordis DEFERS apply() until every service`,
		`// is available; this probe must provide the three real dependencies or the fiber never activates.`,
		`class Fake extends Service {}`,
		`new Fake(ctx, "llm");`,
		`new Fake(ctx, "tokenMeter");`,
		`new Fake(ctx, "sessions");`,
		`const fiber = ctx.plugin(plugin, {});`,
		`await fiber;`,
		`const engine = ctx.get("compaction");`,
		`console.log(JSON.stringify({`,
		`  exports: Object.keys(plugin).sort(),`,
		`  hasDefault: "default" in plugin,`,
		`  name: plugin.name,`,
		`  inject: plugin.ContextCompactEngine.inject,`,
		`  engine: engine?.constructor?.name,`,
		`  methods: ["compactIfNeeded", "compactNow", "compactRegion"].map((m) => typeof engine?.[m]),`,
		`  enabled: engine?.policySource?.read().enabled,`,
		`  archive: engine?.policySource?.read().archive,`,
		`  auditPath: engine?.auditFor?.().path,`,
		`}));`,
		"",
	].join("\n"));
	let probe;
	try {
		probe = execFileSync("node", ["cc-m1-probe.mjs"], { cwd: dir, encoding: "utf8", timeout: 120000 }).trim();
	} catch (error) {
		probe = `ERROR ${String(error.stdout ?? "")}${String(error.stderr ?? "")}`;
	} finally {
		await rm(probePath, { force: true });
	}
	console.log(`  probe: ${probe}`);
	let parsed;
	try {
		parsed = JSON.parse(probe);
	} catch {
		parsed = undefined;
	}
	ok("the installed bytes mount and provide ctx.compaction", parsed?.engine === "ContextCompactEngine", String(parsed?.engine));
	ok("named exports only (no default export)", parsed !== undefined && parsed.hasDefault === false && JSON.stringify(parsed.exports) === JSON.stringify(["ContextCompactEngine", "apply", "inject", "name"]));
	ok("the three engine methods are present", JSON.stringify(parsed?.methods) === JSON.stringify(["function", "function", "function"]));
	ok("installed bytes report the frozen disabled-by-default policy", parsed?.enabled === false && parsed?.archive === true, `enabled=${parsed?.enabled} archive=${parsed?.archive}`);
	console.log("");
}

await rm(scratch, { recursive: true, force: true });
console.log(`checks: ${checks}, failures: ${failures}`);
assert.equal(failures, 0);
console.log("loader proofs PASSED");
