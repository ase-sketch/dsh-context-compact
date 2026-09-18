/**
 * M4-B red test: the per-session carried cache-write debt must be reconstructable from the session
 * log alone (phase4-m4-plan.md M4-B, M2 遗留：WeakMap 内存台账重启归零).
 *
 * M2's ledger is a WeakMap keyed by the live session, so a restarted process (or a replay) starts
 * every session at zero debt while the audit line still shows the values the ORIGINAL process used.
 * The three inputs the ledger consumes (`writeTokens`, `archiveTokens`, `memoTokens`) are not derivable
 * from the log's existing fields, so the fix persists exactly what was charged on the
 * `compaction/summary` event — same data source (the session log), no new file.
 *
 * @module @sol-pi-port/dsh-context-compact/test/debt-rebuild
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CompactionDebtLedger } from "../lib/economics.js";
import { FakeLlm, cleanupTempDirs, closeTurn, buildConversation, makeAgent, mountHost, newSession, openStep, startTurn, tempDir } from "./helpers.js";

after(cleanupTempDirs);

/**
 * Parse one audit JSONL file.
 * @param {string} path
 * @returns {Promise<object[]>}
 */
async function auditLines(path) {
	const text = await readFile(path, "utf8");
	return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/** The committed `compaction/summary` event of one session, or undefined. */
function summaryEventOf(session) {
	return session.snapshotEvents().find((event) => event.type === "compaction/summary");
}

/** A compactable session (system head + balanced tool steps + user tail) with its turn closed. */
function sessionWith(steps) {
	const session = newSession("debt-" + String(steps));
	buildConversation(session, { steps });
	closeTurn(session);
	return session;
}

describe("M4-B charge inputs on the durable event (schema extension)", () => {
	it("records the three ledger inputs on the committed compaction/summary event", async () => {
		const dir = await tempDir();
		const session = sessionWith(4);
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 2 } },
		});
		host.meter.perNode = 12_000;
		/* Read-only measurement taken BEFORE the transaction: nothing writes to the surface before the
		 * summarizer runs, so this is the same figure the gate priced. */
		/* The gate prices the pre-call surface: every surface node costs the fixture's flat perNode. */
		const preCallSurfaceTokens = host.meter.perNode * session.surface.nodes.length;
		await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);

		const event = summaryEventOf(session);
		assert.notEqual(event, undefined);
		const charge = event.data.charge;
		assert.notEqual(charge, undefined, "the committed summary event must carry a charge record");
		assert.deepEqual(Object.keys(charge).sort(), ["archiveTokens", "cacheWriteReadRatio", "charged", "memoTokens", "savingTokens", "writeTokens"]);
		assert.equal(charge.charged, true);
		assert.equal(typeof charge.writeTokens, "number");
		assert.equal(typeof charge.archiveTokens, "number");
		assert.equal(typeof charge.memoTokens, "number");
		assert.equal(typeof charge.savingTokens, "number");
		assert.equal(charge.cacheWriteReadRatio, 2);
		/* Every number must survive the log round trip unchanged: that is what makes the log a faithful
		 * source for a restarted process. */
		assert.equal(charge.writeTokens, preCallSurfaceTokens, "writeTokens is the pre-call surface price the gate used");
		assert.equal(charge.archiveTokens, host.meter.perNode * event.data.shadowedSeqs.length, "archiveTokens is the route price of exactly the shadowed span");
		assert.equal(charge.savingTokens, Math.max(0, charge.archiveTokens - charge.memoTokens));
		assert.ok(charge.memoTokens > 0 && charge.memoTokens < charge.archiveTokens);

		/* Independent cross-check: the audit line is written by a different code path and must agree. */
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.status, "committed");
		assert.equal(charge.writeTokens, line.gate.writeTokens);
		assert.equal(charge.archiveTokens, line.gate.archiveTokens);
		assert.equal(charge.memoTokens, line.gate.memoTokens);

		/* And the record describes the charge the ledger actually took: replaying exactly this record
		 * through a standalone ledger reproduces the engine's live state. */
		const expected = new CompactionDebtLedger();
		expected.charge(session, { writeTokens: charge.writeTokens, savingTokens: charge.savingTokens, cacheWriteReadRatio: charge.cacheWriteReadRatio });
		assert.deepEqual(host.engine.debt.pending(session), expected.pending(session));
		assert.ok(host.engine.debt.pending(session).carriedDebtTokens > 0, "ratio 2 on a positive write cost must leave debt behind");
	});

	it("records charged:false when the economic gate is switched off", async () => {
		const dir = await tempDir();
		const session = sessionWith(4);
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: false } },
		});
		host.meter.perNode = 12_000;
		await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);

		const charge = summaryEventOf(session).data.charge;
		assert.notEqual(charge, undefined, "even an ungated commit records the decision, so a rebuild can tell it apart");
		assert.equal(charge.charged, false, "an ungated compaction charges the ledger nothing");
		assert.equal(charge.cacheWriteReadRatio, null, "with the gate off there is no configured ratio to record");
		assert.equal(typeof charge.archiveTokens, "number", "the span price is measurable regardless of the gate");
		assert.equal(charge.writeTokens, null);
		assert.equal(charge.memoTokens, null);
		assert.deepEqual(host.engine.debt.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});
});

describe("M4-B rebuild from the session log (M4-G2)", () => {
	it("reproduces the live carriedDebt from the log alone on a second engine instance", async () => {
		const dir = await tempDir();
		const session = sessionWith(4);
		const config = { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 2 } };
		const live = await mountHost({ config });
		live.meter.perNode = 12_000;
		await live.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		const liveState = live.engine.debt.pending(session);
		assert.ok(liveState.carriedDebtTokens > 0, "the fixture must produce real debt, or the test proves nothing");

		/* A JSON round trip makes the input a pure LOG: no live object identity, no WeakMap reachable. */
		const log = JSON.parse(JSON.stringify(session.snapshotEvents()));
		const restarted = await mountHost({ config });
		restarted.meter.perNode = 12_000;
		assert.deepEqual(restarted.engine.debt.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 }, "a fresh engine starts at zero debt");
		assert.equal(restarted.engine.debt.rebuild(session, log), 1, "one committed, charged compaction was replayed");
		assert.deepEqual(restarted.engine.debt.pending(session), liveState, "the rebuilt ledger must equal the live one field for field");
	});

	it("reports zero for a log whose only compaction was ungated, and equals the live ledger", async () => {
		const dir = await tempDir();
		const session = sessionWith(4);
		const config = { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: false } };
		const live = await mountHost({ config });
		live.meter.perNode = 12_000;
		await live.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		const log = JSON.parse(JSON.stringify(session.snapshotEvents()));
		const restarted = await mountHost({ config });
		restarted.meter.perNode = 12_000;
		/* An ungated commit charges nothing live, so the rebuild must skip it rather than charge zero
		 * through the ledger (which would still retire the previous step's saving). */
		assert.equal(restarted.engine.debt.rebuild(session, log), 0);
		assert.deepEqual(restarted.engine.debt.pending(session), live.engine.debt.pending(session));
	});

	it("reproduces the retirement of an earlier charge across two committed compactions", async () => {
		const dir = await tempDir();
		const session = sessionWith(4);
		const config = { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 2 } };
		const live = await mountHost({ config });
		live.meter.perNode = 6_000;
		await live.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		/* The first charge leaves debt AND a per-step saving; the second charge must RETIRE a slice of the
		 * earlier debt before it adds its own cost, which is the only path where the order of the two
		 * ledger operations is observable. */
		buildConversation(session, { steps: 4 });
		await live.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.equal(session.snapshotEvents().filter((event) => event.type === "compaction/summary").length, 2, "the fixture must commit twice");
		const liveState = live.engine.debt.pending(session);
		assert.ok(liveState.carriedDebtTokens > 0 && liveState.cacheDebtRepaymentTokens > 0);

		const log = JSON.parse(JSON.stringify(session.snapshotEvents()));
		const restarted = await mountHost({ config });
		restarted.meter.perNode = 6_000;
		assert.equal(restarted.engine.debt.rebuild(session, log), 2, "both charged compactions are replayed, in log order");
		assert.deepEqual(restarted.engine.debt.pending(session), liveState, "a rebuilt ledger that forgot to retire would carry more debt than the live one");
	});

describe("M4-B lazy wiring: a restarted engine restores on its first evaluation", () => {
	/**
	 * One session on which a CHARGED compaction has already committed, plus the ledger state that commit
	 * produced. The session object is then handed to a second, freshly mounted engine — exactly the
	 * restart shape, because the ledger is a per-instance WeakMap.
	 *
	 * @param {string} dir temp directory holding the audit files
	 * @returns {Promise<{ session: object, restarted: object, liveState: object, auditFile: string }>}
	 */
	async function chargedThenRestarted(dir) {
		const session = newSession("debt-lazy");
		buildConversation(session, { steps: 4 });
		closeTurn(session);
		const llmFactory = (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 });
		const live = await mountHost({
			config: { enabled: true, auditPath: join(dir, "live.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 3 } },
			llmFactory,
		});
		live.meter.perNode = 12_000;
		await live.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		const liveState = live.engine.debt.pending(session);
		assert.ok(liveState.carriedDebtTokens > 0, "the fixture must leave real debt in the log, or the test proves nothing");

		/* The pressure path needs an open turn: an automatic bracket must be enclosed in one. */
		startTurn(session, 2);
		openStep(session);

		const restarted = await mountHost({
			config: { enabled: true, thresholdRatio: 0.01, retainRatio: 0.001, auditPath: join(dir, "restarted.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 3 } },
			llmFactory,
		});
		restarted.meter.perNode = 12_000;
		return { session, restarted, liveState, auditFile: join(dir, "restarted.jsonl") };
	}

	it("carries the log's debt on the first gate evaluation after a restart, instead of zero", async () => {
		const dir = await tempDir();
		const { session, restarted, liveState, auditFile } = await chargedThenRestarted(dir);
		/* The state genuinely is absent until something asks for it: this is a restart, not a shared ledger. */
		assert.deepEqual(restarted.engine.debt.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });

		/* No todo ⇒ no horizon ⇒ the pressure gate vetoes and records a deferred line carrying the debt
		 * inputs the decision actually used. */
		await restarted.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const lines = await auditLines(auditFile);
		assert.equal(lines.length, 1, "the vetoed attempt still records exactly one decision");
		assert.equal(lines[0].status, "deferred");
		assert.equal(lines[0].gate.carriedDebtTokens, liveState.carriedDebtTokens, "the first decision after a restart must carry the debt the log records, not zero");
		assert.equal(lines[0].gate.cacheDebtRepaymentTokens, liveState.cacheDebtRepaymentTokens);
	});

	it("does not re-derive the ledger once it holds state", async () => {
		const dir = await tempDir();
		const { session, restarted, liveState, auditFile } = await chargedThenRestarted(dir);
		await restarted.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.equal((await auditLines(auditFile)).length, 1);

		/* Write state the log cannot explain, then evaluate again. A second restore would wipe it. */
		restarted.engine.debt.charge(session, { writeTokens: 999_999, savingTokens: 1, cacheWriteReadRatio: 2 });
		const mutated = restarted.engine.debt.pending(session);
		assert.notEqual(mutated.carriedDebtTokens, liveState.carriedDebtTokens, "the mutation must be distinguishable from what the log would rebuild");

		await restarted.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const lines = await auditLines(auditFile);
		assert.equal(lines.length, 2, "the second evaluation also records its decision");
		assert.equal(lines[1].gate.carriedDebtTokens, mutated.carriedDebtTokens, "the live ledger must survive: the log is consulted only when there is no state");
	});

	it("keeps a fresh session at zero (a log with no charged compaction restores nothing)", async () => {
		const dir = await tempDir();
		const session = newSession("debt-lazy-empty");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, thresholdRatio: 0.01, retainRatio: 0.001, auditPath: join(dir, "fresh.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 3 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 12_000;
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const [line] = await auditLines(join(dir, "fresh.jsonl"));
		assert.equal(line.gate.carriedDebtTokens, 0, "a session with nothing charged in its log carries nothing");
		assert.deepEqual(host.engine.debt.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});
});

	it("is idempotent and ignores a log with no charge record", async () => {
		const dir = await tempDir();
		const session = sessionWith(4);
		const config = { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 3 } };
		const host = await mountHost({ config });
		host.meter.perNode = 12_000;
		await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		const log = JSON.parse(JSON.stringify(session.snapshotEvents()));
		const before = host.engine.debt.pending(session);
		assert.ok(before.carriedDebtTokens > 0);
		assert.equal(host.engine.debt.rebuild(session, log), 1);
		assert.deepEqual(host.engine.debt.pending(session), before, "a rebuild replaces the state instead of charging twice");

		/* An M2-era log: the summary event exists, the charge record does not. */
		const stripped = log.map((event) => (event.type === "compaction/summary" ? { ...event, data: { ...event.data, charge: undefined } } : event));
		assert.equal(host.engine.debt.rebuild(session, stripped), 0, "an older log rebuilds to zero rather than inventing debt");
		assert.deepEqual(host.engine.debt.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});
});
