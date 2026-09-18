/**
 * The economic gate as a DECISION, and the todo-aligned range selection it feeds
 * (phase4-m2-plan.md D1–D7; M2-G1/G2/G4/G7).
 *
 * Everything here runs on real sessions, the real surface fold, the real cordis context and real
 * tool-pairing checks; the only double is the deterministic `FakeLlm` (zero API calls).
 *
 * @module @sol-pi-port/dsh-context-compact/test/gate
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { CompactionDebtLedger, incrementalCacheCostRatio } from "../lib/economics.js";
import { TodoTracker, surfaceTailAt } from "../lib/todo-tracker.js";
import { countCommittedCompactions } from "../lib/engine.js";
import { alignRangeToHint, selectCompactableRange } from "../lib/selectors.js";
import {
	FakeLlm,
	appendSystem,
	appendTodo,
	appendToolStep,
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

/** One audit line per recorded event, in order. */
async function auditLines(path) {
	const text = await readFile(path, "utf8");
	return text.trim().split("\n").map((line) => JSON.parse(line));
}

/** Append one durable closed compaction bracket (a historical compaction, no surface effect). */
function appendHistoricalCompaction(session, index, { error } = {}) {
	const compactionId = `historical-${index}`;
	session.append("compaction/start", { compactionId, turn: 1 });
	session.append("compaction/end", { compactionId, turn: 1, ...(error === undefined ? {} : { error }) });
}

/** A session with one completed plan boundary and one open step, plus enough pressure to trigger. */
function withTodoHistory(session, { steps = 3, windowTokens = 200_000, perNode = 12_000, retention = 0.16 } = {}) {
	appendSystem(session);
	appendTodo(session, [
		{ content: "alpha", status: "in_progress" },
		{ content: "beta", status: "pending" },
	]);
	for (let index = 0; index < steps; index += 1) {
		appendUser(session, `work on node ${index}`);
		appendToolStep(session, { callId: `call-${index}`, result: "x".repeat(2_000) });
		if (index === 0) appendTodo(session, [{ content: "alpha", status: "completed" }, { content: "beta", status: "in_progress" }]);
	}
	appendUser(session, "final tail");
	return { retentionTokens: Math.floor(windowTokens * retention), perNode };
}

/**
 * A session whose plan keeps a wide horizon open: one step turns completed while several stay
 * pending, which is what lets a later decision find enough remaining requests to be worth its
 * cache-write (the vendored `carriedDebtGateOpen` test).
 */
function withWideTodoHistory(session, { steps = 5 } = {}) {
	const list = (completed) => [
		{ content: "alpha", status: completed ? "completed" : "in_progress" },
		{ content: "beta", status: completed ? "in_progress" : "pending" },
		{ content: "gamma", status: "pending" },
		{ content: "delta", status: "pending" },
		{ content: "epsilon", status: "pending" },
		{ content: "zeta", status: "pending" },
	];
	appendSystem(session);
	appendTodo(session, list(false));
	for (let index = 0; index < steps; index += 1) {
		appendUser(session, `work on node ${index}`);
		appendToolStep(session, { callId: `call-${index}` });
		if (index === 0) appendTodo(session, list(true));
	}
	appendUser(session, "final tail");
}

describe("carried cache-write debt ledger (D3)", () => {
	it("prices the incremental cache-write ratio and refuses to guess one", () => {
		assert.equal(incrementalCacheCostRatio(2), 1);
		assert.equal(incrementalCacheCostRatio(1), 0, "a write that costs the same as a read has no excess cost");
		assert.equal(incrementalCacheCostRatio(0.5), 0, "the vendored clamp keeps a cheaper write from becoming a credit");
		assert.equal(incrementalCacheCostRatio(null), null, "an unknown price is never folded into a number");
		assert.equal(incrementalCacheCostRatio(undefined), null);
	});

	it("projects the same debt twice without consuming it", () => {
		const ledger = new CompactionDebtLedger();
		const session = {};
		ledger.charge(session, { writeTokens: 1_000, savingTokens: 500, cacheWriteReadRatio: 2 });
		const first = ledger.pending(session);
		const second = ledger.pending(session);
		assert.deepEqual(first, { carriedDebtTokens: 500, cacheDebtRepaymentTokens: 500 }, "1000 written tokens at ratio 2 cost 1000, retired 500 at a time");
		assert.deepEqual(second, first, "projecting is read-only: a second evaluation of the same step must agree with the first");
	});

	it("retires one slice per charge and carries the remainder", () => {
		const ledger = new CompactionDebtLedger();
		const session = {};
		ledger.charge(session, { writeTokens: 2_000, savingTokens: 300, cacheWriteReadRatio: 2 });
		assert.deepEqual(ledger.pending(session), { carriedDebtTokens: 1_700, cacheDebtRepaymentTokens: 300 });
		ledger.charge(session, { writeTokens: 0, savingTokens: 100, cacheWriteReadRatio: 2 });
		assert.deepEqual(ledger.pending(session), { carriedDebtTokens: 1_600, cacheDebtRepaymentTokens: 100 }, "the next charge retires the older slice first (2000 - 300), then this step retires 100 of what is left");
	});

	it("charges nothing when no cache ratio is known", () => {
		const ledger = new CompactionDebtLedger();
		const session = {};
		ledger.charge(session, { writeTokens: 1_000_000, savingTokens: 10, cacheWriteReadRatio: null });
		assert.deepEqual(ledger.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});

	it("drops a session's debt on clear", () => {
		const ledger = new CompactionDebtLedger();
		const session = {};
		ledger.charge(session, { writeTokens: 1_000, savingTokens: 10, cacheWriteReadRatio: 2 });
		ledger.clear(session);
		assert.deepEqual(ledger.pending(session), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});
});

describe("priorCompactionCount from the durable log (D3)", () => {
	it("counts only closed transactions without an error", () => {
		const session = newSession("count-log");
		buildConversation(session, { steps: 2 });
		assert.equal(countCommittedCompactions(session), 0);
		appendHistoricalCompaction(session, 1);
		appendHistoricalCompaction(session, 2, { error: "summarizer exploded" });
		appendHistoricalCompaction(session, 3);
		assert.equal(countCommittedCompactions(session), 2, "a closed bracket WITH an error is a failed attempt, not a committed compaction");
	});

	it("reports the count of two historical compactions to a later decision", async () => {
		const dir = await tempDir();
		const session = newSession("count-live");
		withTodoHistory(session, { steps: 5, perNode: 10_000 });
		appendHistoricalCompaction(session, 1);
		appendHistoricalCompaction(session, 2);
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.gate.priorCompactionCount, 2, "the count is read from the log, so it is the same number a replay would see");
	});
});

describe("pressure veto (D1/D2, M2-G1)", () => {
	it("vetoes a pressure compaction when no todo data means no horizon", async () => {
		const dir = await tempDir();
		const session = newSession("veto-pressure");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 16_000;
		const eventsBefore = session.snapshotEvents().map((event) => event.type);
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);

		assert.equal(result, null, "a refused pressure compaction returns null");
		assert.equal(session.surface.replaceGeneration, 0);
		assert.deepEqual(session.snapshotEvents().map((event) => event.type), eventsBefore, "a deferred decision appends NO session event");
		assert.equal(host.llm.calls.length, 0, "the summarization call is never paid for");
		assert.equal(host.spill.calls.length, 0, "nothing is archived because nothing is replaced");

		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.status, "deferred");
		assert.equal(line.trigger, "pressure");
		assert.equal(line.turn, 1);
		assert.equal(line.gate.compact, false);
		assert.equal(line.gate.reason, "horizon_unavailable", "no todo data is the fail-closed horizon reading (D4)");
		assert.equal(line.gate.completedBoundaryRequestCounts, null);
		assert.equal(line.gate.remainingBoundaries, null);
		assert.ok(line.shadowedSeqs.length > 0, "the refused span is still recorded");
		assert.equal(host.logger.infos.filter((info) => info.includes("deferred")).length, 1, "the refusal is stated in the log");
		assert.equal(host.logger.warnings.length, 0, "a refusal is not a failure");
	});

	it("still runs when the window itself is at risk, even with no horizon", async () => {
		const dir = await tempDir();
		const session = newSession("veto-window");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 10_000 }),
		});
		host.meter.perNode = 1_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.ok(result !== null, "window protection outranks the missing horizon");
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.status, "committed");
		assert.equal(line.gate.reason, "window_protection");
	});

	it("vetoes when no cache ratio is configured, and never invents one", async () => {
		const dir = await tempDir();
		const session = newSession("veto-cache-ratio");
		withTodoHistory(session, { steps: 5, perNode: 10_000 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.equal(result, null);
		assert.equal(session.surface.replaceGeneration, 0);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.status, "deferred");
		assert.equal(line.gate.reason, "cache_ratio_unavailable");
		assert.equal(line.gate.cacheWriteReadRatio, null);
		assert.equal(line.gate.incrementalCacheCostRatio, null);
	});

	it("lets the compaction run when the horizon authorizes it", async () => {
		const dir = await tempDir();
		const session = newSession("allow-pressure");
		withTodoHistory(session, { steps: 5, perNode: 10_000 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.ok(result !== null, "an available horizon with a zero breakeven allows the compaction");
		assert.equal(session.surface.replaceGeneration, 1);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.status, "committed");
		assert.equal(line.gate.compact, true);
		assert.equal(line.gate.reason, "economic");
	});

	it("never vetoes the context-overflow recovery, even when the gate says no", async () => {
		const dir = await tempDir();
		const session = newSession("overflow-veto");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, maxOverflowRetries: 1, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 16_000;
		const agent = makeAgent(session).agent;
		const payload = { agent, turn: 1, step: 1, provider: "mock-provider", failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, retryPolicy: undefined, signal: new AbortController().signal };
		const outcome = await host.ctx.waterfall("agent/request-error", payload, async () => "next");
		assert.deepEqual(outcome, { kind: "retry" }, "overflow recovery is a correctness obligation (D1)");
		assert.equal(session.surface.replaceGeneration, 1, "the reduction landed although the gate declined");
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.status, "committed");
		assert.equal(line.trigger, "context-overflow");
		assert.equal(line.gate.compact, false, "the recorded verdict is the truth even where the verdict has no authority");
		assert.equal(line.gate.reason, "horizon_unavailable");
	});

	it("leaves manual compaction and a forced compactRegion untouched", async () => {
		const dir = await tempDir();
		const session = newSession("manual-veto");
		buildConversation(session, { steps: 4 });
		closeTurn(session);
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 12_000;
		const manual = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.ok(manual !== null, "the human /compact command is a capability, not an economic decision");

		const second = newSession("region-veto");
		const { stepSeqs } = buildConversation(second, { steps: 4 });
		const regionHost = await mountHost({
			config: { enabled: true, auditPath: join(dir, "region.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		regionHost.meter.perNode = 12_000;
		const nodes = second.surface.nodes;
		const region = await regionHost.engine.compactRegion(nodes[1], stepSeqs[1].toolResult, makeAgent(second).agent, new AbortController().signal);
		assert.ok(region !== null, "an explicitly requested region is not gated");

		const manualLines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(manualLines[0].gate.reason, "explicit-manual");
		assert.equal(manualLines[0].status, "committed");
		assert.equal(manualLines[0].gate.archiveTokens > 0, true, "even an ungated compaction is PRICED, so its cost can be carried forward");
		const regionLines = await auditLines(join(dir, "region.jsonl"));
		assert.equal(regionLines[0].gate.reason, "forced-region");
		assert.equal(regionLines[0].status, "committed");
		assert.equal(regionLines[0].gate.archiveTokens > 0, true);

		/* D3/Q2: the cache-write is paid whichever path triggered it, so an ungated path must still
		 * leave debt behind for the next pressure decision to face. */
		const policy = host.engine.policySource.read();
		assert.equal(policy.economics.cacheWriteReadRatio, 1, "ratio 1 means no excess cost, so charge a ratio-2 host to observe the debt");
		const charging = await mountHost({
			config: { enabled: true, auditPath: join(dir, "charging.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 2 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		const third = newSession("manual-debt");
		buildConversation(third, { steps: 4 });
		closeTurn(third);
		charging.meter.perNode = 12_000;
		await charging.engine.compactNow(makeAgent(third).agent, new AbortController().signal);
		const carried = charging.engine.debt.pending(third);
		assert.ok(carried.carriedDebtTokens > 0, "a manual compaction's cache-write becomes carried debt");
		assert.ok(carried.cacheDebtRepaymentTokens > 0, "and its per-step saving is what retires it");
	});

	it("reports a compaction that already committed when a later attempt is deferred (D2)", async () => {
		const dir = await tempDir();
		const session = newSession("retry-deferred");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }, { content: "beta", status: "pending" }]);
		appendUser(session, "work 0");
		appendToolStep(session, { callId: "call-0" });
		appendUser(session, "work 1");
		appendToolStep(session, { callId: "call-1" });
		appendTodo(session, [{ content: "alpha", status: "completed" }, { content: "beta", status: "in_progress" }]);
		appendUser(session, "work 2");
		appendToolStep(session, { callId: "call-2" });
		appendUser(session, "final tail");
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 2, thresholdRatio: 0.2, retainRatio: 0.15, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 2 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.ok(result !== null, "the first attempt's committed result is not swallowed (Q5 verdict b)");
		assert.equal(session.snapshotEvents().filter((event) => event.type === "compaction/start").length, 1, "exactly one transaction landed");
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.length, 2);
		assert.equal(lines[0].status, "committed");
		assert.equal(lines[1].status, "deferred");
		assert.equal(lines[1].gate.reason, "deferred_economic", "the retry is refused on its own economics, not on the first attempt's failure");
		assert.equal(lines[1].gate.priorCompactionCount, 1, "the second attempt sees the first one's committed bracket");
		assert.ok(lines[1].gate.carriedDebtTokens > 0, "and it carries the first attempt's cache-write debt");
		assert.equal(lines[1].todoHint, undefined, "the committed attempt consumed the hint: it is not offered again to a later decision");
	});
});

describe("real gate inputs (D3/D4, M2-G2)", () => {
	it("reports the horizon the todo tracker observed, without synthesizing anything", async () => {
		const dir = await tempDir();
		const session = newSession("horizon-exact");
		withTodoHistory(session, { steps: 5, perNode: 10_000 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(line.gate.completedBoundaryRequestCounts, [1], "one request was spent on the completed step");
		assert.equal(line.gate.remainingBoundaries, 1, "the still-open plan step");
		assert.equal(line.gate.requestsPerBoundaryMean, 1);
		assert.equal(line.gate.expectedRemainingRequests, 2, "1 + floor(mean 1 x remaining 1 x scale 1)");
		assert.equal(line.gate.averageContextTokenIncrement, null, "M2 keeps the per-step increment unavailable (plan §0)");
		assert.equal(line.gate.windowRequestUpperBound, null, "no increment means no window-derived upper bound");
	});

	it("treats a plan with no completed boundary as an empty sample, not as a missing horizon", async () => {
		const dir = await tempDir();
		const session = newSession("horizon-empty-sample");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }, { content: "beta", status: "pending" }]);
		for (let index = 0; index < 3; index += 1) {
			appendUser(session, `work ${index}`);
			appendToolStep(session, { callId: `call-${index}` });
		}
		appendUser(session, "tail");
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 16_000;
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(line.gate.completedBoundaryRequestCounts, [], "todo data exists, so the sample is empty rather than absent");
		assert.equal(line.gate.remainingBoundaries, 2);
		assert.equal(line.gate.expectedRemainingRequests, 1, "an empty sample is discounted to 1 rather than treated as infinity");
		assert.notEqual(line.gate.reason, "horizon_unavailable", "the fail-closed horizon reading belongs to a session with no todo data at all");
		assert.equal(line.gate.reason, "economic", "the tiny horizon still clears a zero breakeven");
	});

	it("carries the charge of a committed compaction into the next decision", async () => {
		const dir = await tempDir();
		const session = newSession("debt-exact");
		withWideTodoHistory(session, { steps: 5, perNode: 10_000 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 2 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		const committed = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.ok(committed !== null, "the fixture must let the first compaction through, otherwise the debt never exists");
		const [first] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(first.gate.carriedDebtTokens, 0, "the first compaction has no debt behind it");
		assert.equal(first.gate.cacheDebtRepaymentTokens, 0);
		assert.equal(first.gate.writeTokens, 170_000, "the summarization call is priced by the meter's whole surface");
		assert.equal(first.gate.archiveTokens, 30_000, "the shadowed plan-bounded span");
		assert.equal(first.gate.memoTokens, 96);

		/* 170000 written x (ratio 2 - 1) = 170000 of debt; one step retires the 29904-token saving. */
		const projected = host.engine.debt.pending(session);
		assert.deepEqual(projected, { carriedDebtTokens: 140_096, cacheDebtRepaymentTokens: 29_904 }, "one step retires min(debt, per-step saving) and carries the rest");

		/* Put the session back above the threshold so the NEXT decision really has to face the debt. */
		host.meter.perNode = 20_000;
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.length, 2, "the second call must reach a decision, otherwise it says nothing about the debt");
		const last = lines.at(-1);
		assert.equal(last.gate.carriedDebtTokens, projected.carriedDebtTokens, "the next decision carries exactly the projected debt");
		assert.equal(last.gate.cacheDebtRepaymentTokens, projected.cacheDebtRepaymentTokens);
		assert.equal(last.gate.incrementalCacheCostRatio, 1);
	});
});

describe("todo-aligned range selection (D6, M2-G4)", () => {
	it("aligns the range end to a candidate when the pairing check allows it", async () => {
		const dir = await tempDir();
		const session = newSession("align-used");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }, { content: "beta", status: "pending" }]);
		appendUser(session, "work 0");
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [{ content: "alpha", status: "completed" }, { content: "beta", status: "in_progress" }]);
		appendUser(session, "work 1");
		appendToolStep(session, { callId: "call-1" });
		appendUser(session, "work 2");
		appendToolStep(session, { callId: "call-2" });
		appendUser(session, "final tail");
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 16_000;
		const candidate = host.engine.todoTracker.observe(session).candidates.at(-1);
		const unaligned = selectCompactableRange(session, host.meter.measure(session), Math.floor(200_000 * 0.16));
		assert.notEqual(unaligned.end, candidate.endSeq, "the fixture must make the alignment change the cut");
		assert.ok(session.surface.nodes.includes(candidate.endSeq));
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.todoHint.used, true);
		assert.equal(line.todoHint.selectedEnd, unaligned.end);
		assert.equal(line.todoHint.alignedEnd, candidate.endSeq);
		assert.equal(line.shadowedRange.end, candidate.endSeq, "the cut lands on the plan boundary");
		assert.equal(line.todoHint.content, "alpha");
	});

	it("aligns the cut even while the economic gate is switched off", async () => {
		/* The todo signal is a RANGE-PLANNING hint (C7 "信号仅作提示"), not an economic feature: it is a
		 * property of the pressure selection path and does not depend on the gate being enabled. This
		 * test pins that reading so a later refactor cannot quietly couple the two. */
		const dir = await tempDir();
		const session = newSession("align-gate-off");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }, { content: "beta", status: "pending" }]);
		appendUser(session, "work 0");
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [{ content: "alpha", status: "completed" }, { content: "beta", status: "in_progress" }]);
		appendUser(session, "work 1");
		appendToolStep(session, { callId: "call-1" });
		appendUser(session, "work 2");
		appendToolStep(session, { callId: "call-2" });
		appendUser(session, "final tail");
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 16_000;
		const candidate = host.engine.todoTracker.observe(session).candidates.at(-1);
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.ok(result !== null);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(line.gate, { enabled: false, evaluated: false }, "the gate was never consulted");
		assert.equal(line.todoHint.used, true, "the hint still moved the cut");
		assert.equal(line.shadowedRange.end, candidate.endSeq);
		assert.equal(result.shadowedRange.end, candidate.endSeq);
	});

	it("changes nothing when no todo candidate exists", async () => {
		const dir = await tempDir();
		const session = newSession("align-none");
		buildConversation(session, { steps: 6 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 16_000;
		const before = selectCompactableRange(session, host.meter.measure(session), Math.floor(200_000 * 0.16));
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		const [line] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(line.todoHint, undefined, "without a hint the audit line keeps the M1 shape");
		assert.deepEqual(line.shadowedRange, { start: before.start, end: before.end }, "the unaligned selection is byte-for-byte unchanged");
	});

	it("resolves a resumed session's todo anchor in SURFACE order, not by searching sorted seqs", async () => {
		const dir = await tempDir();
		let transitionSeq = -1;
		const session = newSession("align-resumed");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }, { content: "beta", status: "pending" }]);
		for (let index = 0; index < 5; index += 1) {
			appendUser(session, `work ${index}`);
			appendToolStep(session, { callId: `call-${index}` });
			if (index === 0) {
				appendTodo(session, [{ content: "alpha", status: "completed" }, { content: "beta", status: "in_progress" }]);
				transitionSeq = session.seq - 1;
			}
		}
		appendUser(session, "final tail");
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		host.meter.perNode = 10_000;
		await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.equal(session.surface.replaceGeneration, 1);
		const nodes = session.surface.nodes;
		assert.ok(!nodes.every((seq, index) => index === 0 || seq > nodes[index - 1]), "a replacement puts a late seq at the front of the surface");
		/* The transition happened BEFORE the compaction, so a resumed tracker must re-fold the whole
		 * log. Its anchor is the last node AT OR BEFORE the write IN SURFACE ORDER: reading the surface
		 * as a sorted seq list would return the system head instead. */
		const resumed = new TodoTracker({ logger: host.logger }).observe(session);
		assert.equal(resumed.candidates.length, 1);
		const anchor = resumed.candidates[0].endSeq;
		assert.ok(nodes.includes(anchor), "the anchor must be a node that is still on the surface");
		assert.ok(session.eventAt(anchor).seq <= resumed.candidates[0].todoSeq, "and it must not be a node the write never preceded");

		/* The replaced span reached up to surface position 1, so a target INSIDE it has exactly one
		 * honest answer in surface order (the node that follows it) and a different one under a
		 * sorted-seq search (the system head at position 0). */
		const firstRetained = nodes[2];
		assert.equal(surfaceTailAt(session, firstRetained), firstRetained, "surface order keeps the node itself");
		assert.equal(session.eventAt(firstRetained).seq > session.eventAt(nodes[0]).seq, true);
	});

	it("refuses a hint that would split a tool-call pair", () => {
		const session = newSession("align-pairing");
		const { stepSeqs } = buildConversation(session, { steps: 3 });
		const nodes = session.surface.nodes;
		const range = { start: nodes[1], end: nodes.at(-1) };
		const unbalanced = alignRangeToHint(session, range, stepSeqs[1].assistant);
		assert.deepEqual(unbalanced, range, "an assistant tool-call node is not a balanced boundary");
		assert.equal(toolPairingBalancedAfter(session, stepSeqs[1].assistant), false);
		assert.deepEqual(alignRangeToHint(session, range, stepSeqs[1].toolResult), { start: nodes[1], end: stepSeqs[1].toolResult });
	});

	it("ignores a hint outside the selected range and a missing one", () => {
		const session = newSession("align-outside");
		const { stepSeqs } = buildConversation(session, { steps: 4 });
		const nodes = session.surface.nodes;
		const range = { start: nodes[1], end: stepSeqs[1].toolResult };
		assert.deepEqual(alignRangeToHint(session, range, stepSeqs[3].toolResult), range, "a boundary beyond the range cannot widen it");
		assert.deepEqual(alignRangeToHint(session, range, nodes[1]), range, "the range start is not an interior cut");
		assert.equal(alignRangeToHint(session, range, null), range, "no hint means the caller's range object is returned as-is");
		assert.equal(alignRangeToHint(session, range, 999_999), range, "a seq that is not on the surface is ignored");
	});
});

describe("fail-closed behaviour (M2-G7)", () => {
	it("still writes nothing when the archive is refused", async () => {
		const dir = await tempDir();
		const session = newSession("failclosed-archive");
		withTodoHistory(session, { steps: 5, perNode: 10_000 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
			spillOptions: { fail: true },
		});
		host.meter.perNode = 10_000;
		const surfaceBefore = [...session.surface.nodes];
		const outcome = await host.engine
			.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal)
			.then(() => "resolved", (error) => error);
		assert.ok(outcome instanceof Error, "a refused archive still fails the transaction");
		assert.deepEqual([...session.surface.nodes], surfaceBefore);
		assert.equal(session.surface.replaceGeneration, 0);
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/summary"), false);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.at(-1).status, "failed");
		assert.equal(lines.at(-1).stage, "archive");
		assert.equal(lines.at(-1).archive.status, "refused");
		assert.equal(lines.filter((line) => line.status === "deferred").length, 0, "the gate allowed this one; the archive is what refused");
	});
});
