/**
 * Composition-level regression: the plugin as the LOADER mounts it, driven through the real
 * cordis event path. Phase 4 M3 postmortem (eval/compact-arms/m3-zero-trigger-diagnosis.md).
 *
 * WHY THIS FILE EXISTS
 * The 88-test suite mounted the plugin with `ctx.plugin(plugin, config)` but then exercised the
 * engine by calling its methods DIRECTLY. None of those tests dispatched `agent/pre-step`, which is
 * the only path that reads `ctx.tokenMeter` through the plugin FIBER. So a missing module-level
 * `inject` export went unnoticed: `ContextCompactEngine.inject` (a CLASS STATIC field) is invisible
 * to `Inject.resolve(plugin.inject)` in cordis/lib/index.js, the fiber's inject map stayed empty,
 * every `ctx.tokenMeter` read inside `compactIfNeeded` threw
 * `cannot get property "tokenMeter" without inject`, and `registerAutomaticCompaction` swallowed it.
 * Result in production: the mechanism silently did nothing, with zero session events and zero audit
 * lines -- while all 88 tests stayed green.
 *
 * WHAT THESE TESTS PIN, AND WHAT THEY CANNOT
 * 1. **The contract** (authoritative guard): the module namespace exports `inject`, resolved through
 *    cordis' OWN resolver `Inject.resolve(plugin.inject)`. This is red without the export and green
 *    with it -- verified by removing the line and re-running.
 * 2. **The behaviour**: dispatching `agent/pre-step` on a mounted composition must not throw.
 *
 * Honest limitation: (2) does NOT go red in the unit harness. The production throw needs the
 * loader's fiber topology -- `token-meter` is provided by a SIBLING entry fiber, so the ancestor
 * walk in cordis' service resolver (`fiber = fiber.parent.fiber`) never reaches its per-fiber
 * store and the read fails. This harness registers services on the context the plugin fiber can
 * reach, so the read succeeds either way. Reproducing the loader's exact fiber graph in-process was
 * attempted and abandoned as not worth the complexity; the behavioural red is covered by the REAL
 * recording instead: the M3 probe showed 26/27 `compactIfNeeded` calls throwing
 * `without inject` with ZERO compaction events, and 0 throws with 28 events after the fix
 * (eval/compact-arms/m3-zero-trigger-diagnosis.md §2.2). Test (2) is kept as a cheap
 * regression net for the path itself, not as the guard for this bug.
 *
 * @module @sol-pi-port/dsh-context-compact/test/composition
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Context, Inject } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";
import {
	FakeLlm,
	FakePruner,
	FakeSessions,
	FakeSpillStore,
	FakeTokenMeter,
	buildConversation,
	cleanupTempDirs,
	closeTurn,
	hostAuditPath,
	newSession,
	silentLogger,
	snapshotFile,
} from "./helpers.js";

const hostAuditBefore = await snapshotFile(hostAuditPath());

after(async () => {
	await cleanupTempDirs();
	assert.deepEqual(await snapshotFile(hostAuditPath()), hostAuditBefore, "this suite must never write to the developer's real audit file");
});

/**
 * Mount the plugin MODULE through cordis' real plugin path on a real Context.
 *
 * @param {object} [config] the plugin's composition entry
 * @returns {Promise<{ ctx: object, engine: object, logger: object, meter: object, llm: object }>} the composition
 */
async function mountComposition(config = {}) {
	const ctx = new Context();
	/* These doubles extend cordis' Service, so constructing them registers them on the root
	 * context -- the same way the base bundle's real services are registered. */
	new FakeSessions(ctx);
	const llm = new FakeLlm(ctx);
	const meter = new FakeTokenMeter(ctx);
	new FakeSpillStore(ctx);
	new FakePruner(ctx);
	const logger = silentLogger();
	Object.defineProperty(ctx, "logger", { value: logger, configurable: true, writable: true });
	await ctx.plugin(plugin, config);
	return { ctx, engine: ctx.get("compaction"), logger, meter, llm };
}

/**
 * Run the pressure check exactly the way the host does: dispatch `agent/pre-step`.
 * A thrown error is captured rather than propagated, because the real listener catches engine
 * failures and only warns -- which is precisely the silence that hid the bug.
 *
 * @param {object} ctx mounted composition
 * @param {object} session session with an open step
 * @returns {Promise<{ threw: string|null, result: unknown }>} the observed outcome
 */
async function dispatchPreStep(ctx, session) {
	const signal = new AbortController().signal;
	let threw = null;
	let result = null;
	try {
		result = await ctx.events.waterfall("agent/pre-step", { agent: { session, options: {} }, turn: 1, step: 1, signal }, () => Promise.resolve({ kind: "enter" }));
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	return { threw, result };
}

describe("composition-level loader contract", () => {
	it("exports a module-level inject declaration for the loader", () => {
		/* cordis reads `plugin.inject` off the MODULE NAMESPACE. A class static field of the same
		 * name does not satisfy it -- that is the whole bug this file guards. */
		assert.deepEqual(plugin.inject, ["llm", "tokenMeter", "sessions"], "the module namespace must declare inject for the loader fiber");
	});

	it("declares every service the engine reads, through the loader's own resolver", () => {
		/* This is the loader's exact call (cordis/lib/index.js: `Inject.resolve(plugin.inject)`).
		 * Asserting through the real resolver -- not through a hand-written array comparison --
		 * is what makes the regression survive a refactor of how inject is spelled. */
		const resolved = Inject.resolve(plugin.inject);
		assert.deepEqual(Object.keys(resolved).sort(), ["llm", "sessions", "tokenMeter"]);
	});

	it("resolves ctx.tokenMeter from inside the mounted plugin fiber", async () => {
		const { ctx } = await mountComposition({ enabled: true, thresholdRatio: 0.2, retainRatio: 0.08 });
		const engine = ctx.get("compaction");
		assert.notEqual(engine, undefined, "the service must be provided");
		/* The read that threw in production: the engine's OWN ctx, reached through the fiber the
		 * loader created. */
		const meter = engine.ctx.tokenMeter;
		assert.notEqual(meter, undefined, "ctx.tokenMeter must resolve inside the plugin fiber");
		assert.equal(typeof meter.measure, "function");
	});

	it("keeps the class-level inject declaration for direct construction", () => {
		/* The class static field is a DIFFERENT contract from the module export: it documents what
		 * `new ContextCompactEngine(ctx)` needs. Both must exist. */
		assert.deepEqual(plugin.ContextCompactEngine.inject, ["llm", "tokenMeter", "sessions"]);
	});

	it("runs the pressure check on agent/pre-step without the engine throwing", async () => {
		const { ctx, logger } = await mountComposition({ enabled: true, thresholdRatio: 0.2, retainRatio: 0.08 });
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const { threw } = await dispatchPreStep(ctx, session);
		assert.equal(threw, null, "the pressure check must not throw: " + String(threw));
		/* Redundant with the assertion above on purpose: the production symptom was this exact
		 * warning, emitted because the listener swallows the engine error. */
		const injectWarnings = logger.warnings.filter((line) => line.includes("without inject"));
		assert.deepEqual(injectWarnings, [], 'no "without inject" warning may be emitted');
	});

	it("does not register an automatic listener while disabled (frozen default)", async () => {
		const { ctx, logger } = await mountComposition({});
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		await dispatchPreStep(ctx, session);
		assert.equal(logger.infos.filter((line) => line.includes("automatic compaction is disabled")).length, 1);
		assert.equal(ctx.get("compaction") !== undefined, true, "the service must exist so /compact never breaks");
	});
});
