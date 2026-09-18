/**
 * The plugin surface as the loader sees it: named exports only, one `ctx.compaction` service, the
 * settings namespace, and the frozen "disabled by default" shape.
 *
 * @module @sol-pi-port/dsh-context-compact/test/plugin
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CompactionEngine } from "@deepseek-ai/dsh-compaction";
import * as plugin from "../lib/index.js";
import { CONTEXT_COMPACT_NAMESPACE, DEFAULT_THRESHOLD_RATIO, resolvePolicy } from "../lib/settings.js";
import {
	appendUser,
	buildConversation,
	cleanupTempDirs,
	closeTurn,
	hostAuditPath,
	makeAgent,
	mountHost,
	newSession,
	snapshotFile,
	tempDir,
} from "./helpers.js";

const hostAuditBefore = await snapshotFile(hostAuditPath());

after(async () => {
	await cleanupTempDirs();
	assert.deepEqual(await snapshotFile(hostAuditPath()), hostAuditBefore, "the suite must never write to the developer's real audit file");
});

describe("plugin surface", () => {
	it("is a named-export namespace plugin with no default export", () => {
		assert.deepEqual(Object.keys(plugin).sort(), ["ContextCompactEngine", "apply", "inject", "name"]);
		assert.equal("default" in plugin, false, "a default export would make the loader drop the module namespace (DSH postmortem 0001)");
		assert.equal(plugin.name, "context-compact");
		assert.equal(typeof plugin.apply, "function");
	});

	it("declares the services the engine reads and provides one compaction implementation", async () => {
		assert.deepEqual(plugin.ContextCompactEngine.inject, ["llm", "tokenMeter", "sessions"]);
		const host = await mountHost();
		assert.ok(host.engine instanceof CompactionEngine);
		assert.equal(host.engine.constructor.name, "ContextCompactEngine");
		for (const method of ["compactIfNeeded", "compactNow", "compactRegion"]) {
			assert.equal(typeof host.engine[method], "function");
		}
	});

	it("mounts through the getter path cordis uses for service plugins", async () => {
		const host = await mountHost();
		/* `ctx.get` hands back cordis' service proxy on every access, so identity is not the contract:
		 * the contract is that the getter resolves a working engine. */
		const engine = host.ctx.get("compaction");
		assert.notEqual(engine, undefined);
		assert.equal(engine.constructor.name, "ContextCompactEngine");
		assert.equal(typeof engine.compactRegion, "function");
		assert.equal(typeof engine.policySource.read, "function");
	});

	it("leaves the mechanism fully off with no configuration, and says so", async () => {
		const host = await mountHost();
		const policy = host.engine.policySource.read();
		assert.equal(policy.enabled, false);
		assert.equal(policy.archive, true, "evidence preservation is on even while the mechanism is off");
		assert.equal(policy.economics.enabled, false);
		assert.equal(policy.thresholdRatio, DEFAULT_THRESHOLD_RATIO);
		assert.equal(policy.auditPath, undefined);
		assert.equal(host.engine.auditFor().path, hostAuditPath(), "no configured path falls back to the host state directory");
		assert.equal(host.logger.infos.filter((line) => line.includes("automatic compaction is disabled")).length, 1);
		assert.equal(host.ctx.get("compaction") !== undefined, true, "the service must exist so /compact never breaks");
	});

	it("keeps the human /compact command usable while the mechanism is off", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({ config: { auditPath: join(dir, "audit.jsonl") } });
		const result = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.ok(result !== null, "/compact must still compact while automatic triggering is off");
		assert.equal(typeof result.shadowedSeqs.length, "number");
		assert.equal(typeof result.shadowedTokenCount, "number");
		assert.equal(typeof result.summarySeq, "number");
		assert.equal(session.surface.replaceGeneration, 1);
	});

	it("reports a null result for /compact when no useful range exists", async () => {
		const dir = await tempDir();
		const session = newSession();
		appendUser(session, "only one message");
		closeTurn(session);
		const host = await mountHost({ config: { auditPath: join(dir, "audit.jsonl") } });
		assert.equal(await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal), null);
	});
});

describe("settings namespace", () => {
	it("registers efficiency-context-compact over the composition entry and reads the user layer", async () => {
		const dir = await tempDir();
		const host = await mountHost({
			config: { enabled: true, thresholdRatio: 0.5, auditPath: join(dir, "audit.jsonl") },
			settingsLayer: { thresholdRatio: 0.25, maxTokens: 1024 },
		});
		assert.ok(host.settings !== undefined);
		assert.equal(host.settings.registrations.length, 1);
		const registration = host.settings.registrations[0];
		assert.equal(registration.ns, CONTEXT_COMPACT_NAMESPACE);
		assert.equal(registration.options.applies, "live");
		assert.deepEqual(registration.options.base, { enabled: true, thresholdRatio: 0.5, auditPath: join(dir, "audit.jsonl") });
		const policy = host.engine.policySource.read();
		assert.equal(policy.thresholdRatio, 0.25, "the user layer wins over the composition entry");
		assert.equal(policy.maxTokens, 1024);
		assert.equal(policy.enabled, true);
		assert.equal(host.engine.policySource.registered, true);
		assert.equal(host.engine.policySource.describe(), 'settings namespace "efficiency-context-compact"');
	});

	it("falls back to the composition entry when no settings provider is composed", async () => {
		const dir = await tempDir();
		const host = await mountHost({ config: { enabled: true, compactionRetries: 3, auditPath: join(dir, "audit.jsonl") } });
		assert.equal(host.settings, undefined);
		assert.equal(host.engine.policySource.registered, false);
		assert.equal(host.engine.policySource.read().compactionRetries, 3);
		assert.equal(host.engine.policySource.describe(), "composition entry (no settings provider)");
	});
});

describe("policy normalization", () => {
	it("treats a malformed section as fully disabled", () => {
		const policy = resolvePolicy({ enabled: "yes", thresholdRatio: 4, retainRatio: -1, maxTokens: 0 });
		assert.equal(policy.enabled, false, "only a literal true enables the mechanism");
		assert.equal(policy.thresholdRatio, DEFAULT_THRESHOLD_RATIO);
		assert.equal(policy.retainRatio, 0.16);
		assert.equal(policy.maxTokens, 8192);
	});

	it("clamps retainRatio below thresholdRatio and defaults the gate closed", () => {
		const policy = resolvePolicy({ enabled: true, thresholdRatio: 0.5, retainRatio: 0.9 });
		assert.equal(policy.thresholdRatio, 0.5);
		assert.equal(policy.retainRatio, 0.16, "a tail at or above the threshold would make every range empty");
		assert.equal(policy.economics.cacheWriteReadRatio, null);
		assert.deepEqual(resolvePolicy({}).economics, {
			enabled: false,
			remainingRequestScale: 1,
			windowReserveTokens: 16_384,
			firstCompactionRequestScale: 2,
			subsequentCompactionMargin: 1.5,
			cacheWriteReadRatio: null,
		});
	});
});
