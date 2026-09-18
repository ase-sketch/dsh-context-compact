/**
 * Profile digest tool for the Phase 4 M1 evidence (zero API, read-only).
 *
 * Folds a profile directory into one sha256 exactly the way the earlier phases did: list every file
 * recursively, render `<relpath> <sha256>` lines sorted by LC_ALL=C order, join with a single LF and
 * no trailing newline, then hash the result. The per-file map is kept so a before/after comparison can
 * name the exact bytes that changed instead of only reporting "the hash moved".
 *
 * Usage:
 *   node evidence/profile-digest.mjs --out evidence/profile-hash-before.json
 *   node evidence/profile-digest.mjs --compare <before.json> <after.json>
 *
 * @module @sol-pi-port/dsh-context-compact/evidence/profile-digest
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const PROFILES = {
	headless: join(homedir(), ".dsh", "profiles", "headless"),
	web: join(homedir(), ".dsh", "profiles", "web"),
	eval: join(homedir(), ".dsh", "profiles", "eval"),
	"record-eval": join(homedir(), ".dsh", "profiles", "record-eval"),
};

/**
 * @param {string} dir
 * @returns {Promise<string[]>} relative file paths below `dir`
 */
async function listFiles(dir) {
	const out = [];
	const walk = async (current) => {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) out.push(relative(dir, path));
		}
	};
	await walk(dir);
	return out;
}

/**
 * @param {string} dir
 * @returns {Promise<{ hash: string, count: number, files: Record<string, string> }>}
 */
async function digestProfile(dir) {
	const paths = await listFiles(dir);
	const files = {};
	for (const rel of paths) {
		files[rel] = createHash("sha256").update(await readFile(join(dir, rel))).digest("hex");
	}
	const canonical = Object.keys(files)
		.sort()
		.map((rel) => `${rel} ${files[rel]}`)
		.join("\n");
	return { hash: createHash("sha256").update(canonical).digest("hex"), count: paths.length, files };
}

/**
 * @param {string} dir
 * @returns {Promise<{ hash: string, count: number, files: Record<string, string> }>}
 */
async function digestTree(dir) {
	const paths = await listFiles(dir);
	const files = {};
	for (const rel of paths.sort()) {
		files[rel] = createHash("sha256").update(await readFile(join(dir, rel))).digest("hex");
	}
	const canonical = Object.keys(files).sort().map((rel) => `${rel} ${files[rel]}`).join("\n");
	return { hash: createHash("sha256").update(canonical).digest("hex"), count: paths.length, files };
}

async function snapshot() {
	const out = { profiles: {}, pluginSource: null, evalPatch: null, evalPackage: null, recordEvalPatch: null, recordEvalPackage: null };
	for (const [name, dir] of Object.entries(PROFILES)) out.profiles[name] = await digestProfile(dir);
	out.pluginSource = await digestTree(join(PLUGIN, "lib"));
	out.evalPatch = (await readFile(join(PROFILES.eval, "cordis.patch.yml"))).toString("utf8");
	out.evalPackage = (await readFile(join(PROFILES.eval, "package.json"))).toString("utf8");
	out.recordEvalPatch = (await readFile(join(PROFILES["record-eval"], "cordis.patch.yml"))).toString("utf8");
	out.recordEvalPackage = (await readFile(join(PROFILES["record-eval"], "package.json"))).toString("utf8");
	out.evalPatchSha256 = sha(out.evalPatch);
	out.evalPackageSha256 = sha(out.evalPackage);
	out.recordEvalPatchSha256 = sha(out.recordEvalPatch);
	out.recordEvalPackageSha256 = sha(out.recordEvalPackage);
	out.repo = REPO;
	return out;
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

const args = process.argv.slice(2);
if (args[0] === "--compare") {
	const before = JSON.parse(await readFile(args[1], "utf8"));
	const after = JSON.parse(await readFile(args[2], "utf8"));
	let changedAny = false;
	for (const name of Object.keys(before.profiles)) {
		const a = before.profiles[name];
		const b = after.profiles[name];
		const added = Object.keys(b.files).filter((rel) => a.files[rel] === undefined);
		const removed = Object.keys(a.files).filter((rel) => b.files[rel] === undefined);
		const changed = Object.keys(b.files).filter((rel) => a.files[rel] !== undefined && a.files[rel] !== b.files[rel]);
		const identical = a.hash === b.hash;
		if (!identical) changedAny = true;
		console.log(`${name}: ${identical ? "IDENTICAL" : "CHANGED"} ${a.hash} -> ${b.hash} (files ${a.count} -> ${b.count})`);
		for (const rel of added) console.log(`  [added]   ${rel}`);
		for (const rel of removed) console.log(`  [removed] ${rel}`);
		for (const rel of changed) console.log(`  [changed] ${rel}`);
	}
	console.log(`\npluginSource: ${before.pluginSource.hash} -> ${after.pluginSource.hash}`);
	console.log(`eval patch sha256: ${before.evalPatchSha256} -> ${after.evalPatchSha256}`);
	console.log(`eval package sha256: ${before.evalPackageSha256} -> ${after.evalPackageSha256}`);
	console.log(`record-eval patch sha256: ${before.recordEvalPatchSha256} -> ${after.recordEvalPatchSha256}`);
	console.log(`record-eval package sha256: ${before.recordEvalPackageSha256} -> ${after.recordEvalPackageSha256}`);
	console.log(`\nchangedAny=${changedAny}`);
} else {
	const out = await snapshot();
	const target = args[0] === "--out" ? args[1] : undefined;
	if (target !== undefined) await writeFile(target, `${JSON.stringify(out, null, 2)}\n`);
	for (const [name, value] of Object.entries(out.profiles)) console.log(`${name}: ${value.hash} (${value.count} files)`);
	console.log(`pluginSource(lib): ${out.pluginSource.hash} (${out.pluginSource.count} files)`);
	console.log(`eval patch sha256: ${out.evalPatchSha256}`);
	console.log(`eval package sha256: ${out.evalPackageSha256}`);
	console.log(`record-eval patch sha256: ${out.recordEvalPatchSha256}`);
	console.log(`record-eval package sha256: ${out.recordEvalPackageSha256}`);
	if (target !== undefined) console.log(`written: ${target}`);
}
