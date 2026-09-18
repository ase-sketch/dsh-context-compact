/**
 * The compaction transaction: brackets, the durable lock, cancellation, evidence-preserving archive,
 * the tool-result-pruner wiring, and the two automatic triggers.
 *
 * Every case runs against a REAL detached session and a REAL cordis context; only the LLM call is
 * mocked (see helpers.js).
 *
 * @module @sol-pi-port/dsh-context-compact/test/engine
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { ArchiveRefusedError, TargetPressureConfigError, assertCompactionInactive } from "../lib/engine.js";
import { selectCompactableRange } from "../lib/selectors.js";
import {
	FakeLlm,
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
	assert.deepEqual(
		await snapshotFile(hostAuditPath()),
		hostAuditBefore,
		"the suite must never write to the developer's real context-compact audit file",
	);
});

/** One audit line per recorded event, in order. */
async function auditLines(path) {
	const text = await readFile(path, "utf8");
	return text.trim().split("\n").map((line) => JSON.parse(line));
}

/** An LLM double that aborts the caller's signal from inside the stream call. */
class AbortingLlm extends FakeLlm {
	constructor(ctx, options, controller, reason) {
		super(ctx, options);
		this.controller = controller;
		this.reason = reason;
	}

	async *stream(options) {
		this.calls.push(options);
		this.controller.abort(this.reason);
		throw this.reason;
	}
}

describe("manual compaction (/compact)", () => {
	it("appends one bracketed transaction, archives the shadowed region, and replaces the span", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const surfaceBefore = [...session.surface.nodes];
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });

		const result = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.ok(result !== null, "a useful range exists and compaction must not be a no-op");

		const events = session.snapshotEvents();
		const startIndex = events.findIndex((event) => event.type === "compaction/start");
		assert.deepEqual(
			events.slice(startIndex).map((event) => event.type),
			["compaction/start", "compaction/summary", "user/message", "compaction/end"],
			"the transaction must be exactly one closed bracket",
		);
		const start = events[startIndex];
		const end = events.at(-1);
		assert.equal(result.startSeq, start.seq);
		assert.equal(result.summarySeq, start.seq + 1);
		assert.equal(result.endSeq, start.seq + 3);
		assert.equal(end.data.compactionId, start.data.compactionId);
		assert.equal(end.data.turn, start.data.turn);
		assert.equal(end.data.error, undefined, "a successful bracket carries no error");
		assert.equal(start.data.turn, null, "a manual bracket is standalone");

		const replacement = events.find((event) => event.type === "user/message" && isReplacementSurfaceEvent(event));
		assert.ok(isCompactCheckpointSource(replacement.data.source), "the replacement must be a backend-independent compaction checkpoint");
		assert.deepEqual(replacement.surfaceOp, { op: "replace", startSeq: result.shadowedRange.start, endSeq: result.shadowedRange.end });
		assert.deepEqual(replacement.sourceEventSeqs, [start.seq, result.summarySeq, ...result.shadowedSeqs]);
		assert.deepEqual(session.surface.nodes, [surfaceBefore[0], replacement.seq, surfaceBefore.at(-1)], "the system head and the recent tail stay verbatim");
		assert.equal(session.surface.replaceGeneration, 1);

		assert.equal(host.spill.calls.length, 1, "the shadowed 原文 is archived exactly once");
		const archiveCall = host.spill.calls[0];
		assert.match(archiveCall.suggestedName, /^compaction-[0-9a-f-]+\.jsonl$/);
		assert.equal(archiveCall.source.kind, "session-reference");
		const archiveLines = archiveCall.content.trim().split("\n");
		assert.equal(archiveLines.length, result.shadowedSeqs.length + 1, "one provenance header plus one line per shadowed event");
		const archiveHeader = JSON.parse(archiveLines[0]);
		assert.deepEqual(archiveHeader.shadowedSeqs, result.shadowedSeqs);
		assert.equal(archiveHeader.compactionId, start.data.compactionId);
		assert.equal(JSON.parse(archiveLines[1]).seq, result.shadowedSeqs[0]);
		assert.equal(host.sessions.flushes.length, 1, "the manual path runs the durability checkpoint");

		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.length, 1);
		assert.equal(lines[0].status, "committed");
		assert.equal(lines[0].trigger, "manual");
		assert.equal(lines[0].events.startSeq, result.startSeq);
	});

	it("never starts the range on the system head and keeps a priced tail", async () => {
		const dir = await tempDir();
		const session = newSession();
		const { stepSeqs } = buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const result = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.ok(result.shadowedRange.start > session.surface.nodes[0], "surface node 0 is the protected system prompt");
		assert.equal(result.shadowedSeqs.at(-1), stepSeqs.at(-1).toolResult, "the trailing user message is retained verbatim");
	});

	it("returns null when no safe useful range exists", async () => {
		const dir = await tempDir();
		const session = newSession();
		appendUser(session, "only one message");
		closeTurn(session);
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const result = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.equal(result, null);
		assert.equal(host.spill.calls.length, 0, "a no-op writes nothing, including no archive");
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/start"), false);
	});

	it("classifies a non-idle agent as busy", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 2 });
		closeTurn(session);
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session, { maintenanceThrows: new Error("agent is running") });
		/* The host rejects a non-idle `runMaintenance` SYNCHRONOUSLY, and `compactNow` classifies exactly
		 * that rejection; the human command adapter awaits it inside its own try/catch. */
		assert.throws(
			() => host.engine.compactNow(agent.agent, new AbortController().signal),
			(error) => {
				assert.equal(error.code, "busy");
				assert.match(error.message, /idle agent/);
				return true;
			},
		);
	});

	it("classifies an unmatched durable compaction lock as busy", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 2 });
		session.append("compaction/start", { compactionId: "lock-holder", turn: 1 });
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const surfaceBefore = [...session.surface.nodes];
		await assert.rejects(
			() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal),
			(error) => {
				assert.equal(error.code, "busy");
				assert.match(error.message, /already in progress/);
				return true;
			},
		);
		assert.deepEqual([...session.surface.nodes], surfaceBefore);
		assert.equal(session.surface.replaceGeneration, 0);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].status, "refused");
		assert.equal(lines[0].reason, "busy");
	});

	it("treats a compaction start before the latest seed boundary as stale", () => {
		assert.throws(() => assertCompactionInactive({ seq: 5 }, undefined, "unit"), { code: "busy" });
		assert.doesNotThrow(() => assertCompactionInactive({ seq: 5 }, 7, "unit"));
		assert.doesNotThrow(() => assertCompactionInactive(undefined, undefined, "unit"));
	});

	it("preserves the caller's abort reason and closes the bracket with an error", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const surfaceBefore = [...session.surface.nodes];
		const controller = new AbortController();
		const reason = new Error("unit-test cancellation");
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new AbortingLlm(ctx, {}, controller, reason),
		});

		await assert.rejects(
			() => host.engine.compactNow(makeAgent(session).agent, controller.signal),
			(error) => {
				assert.equal(error, reason, "an aborted request preserves its exact abort reason");
				return true;
			},
		);
		const types = session.snapshotEvents().map((event) => event.type);
		assert.ok(types.includes("compaction/start"));
		assert.equal(types.includes("compaction/summary"), false, "no summary lands for a cancelled attempt");
		const end = session.snapshotEvents().at(-1);
		assert.equal(end.type, "compaction/end");
		assert.match(end.data.error, /unit-test cancellation/);
		assert.deepEqual([...session.surface.nodes], surfaceBefore, "a cancelled attempt changes no surface");
		assert.equal(session.surface.replaceGeneration, 0);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].status, "failed");
		assert.equal(lines[0].stage, "summary");
	});

	it("refuses a summary that is not smaller than the shadowed content", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			meter: undefined,
			llmFactory: (ctx) => new FakeLlm(ctx, { summaryText: "x".repeat(4000) }),
		});
		host.meter.perNode = 10;
		await assert.rejects(
			() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal),
			(error) => {
				assert.equal(error.code, "summary");
				assert.match(error.cause.message, /not smaller than the shadowed content/);
				return true;
			},
		);
		assert.equal(session.surface.replaceGeneration, 0);
	});

	it("classifies a pre-aborted manual request before any write", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const controller = new AbortController();
		const reason = new Error("pre-aborted");
		controller.abort(reason);
		/* `compactNow` checks the caller's signal synchronously and before any write — the human command
		 * adapter awaits inside its own try/catch, so a synchronous throw is its contract too. */
		assert.throws(
			() => host.engine.compactNow(makeAgent(session).agent, controller.signal),
			(error) => {
				assert.equal(error, reason);
				return true;
			},
		);
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/start"), false);
	});
});

describe("evidence preservation (archive before replace)", () => {
	it("refuses to compact when no spillStore is composed", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const surfaceBefore = [...session.surface.nodes];
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") }, spill: null });
		await assert.rejects(
			() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal),
			(error) => {
				assert.equal(error.code, "summary");
				assert.ok(error.cause instanceof ArchiveRefusedError);
				assert.match(error.cause.message, /no spillStore is composed/);
				return true;
			},
		);
		assert.deepEqual([...session.surface.nodes], surfaceBefore);
		assert.equal(session.surface.replaceGeneration, 0);
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/summary"), false);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].status, "failed");
		assert.equal(lines[0].stage, "archive");
		assert.equal(lines[0].archive.status, "refused");
	});

	it("refuses to compact when the spill backend rejects the write", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const surfaceBefore = [...session.surface.nodes];
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") }, spillOptions: { fail: true } });
		await assert.rejects(
			() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal),
			(error) => {
				assert.equal(error.code, "summary");
				assert.match(error.cause.message, /rejected the archive write/);
				return true;
			},
		);
		assert.equal(host.spill.calls.length, 1);
		assert.deepEqual([...session.surface.nodes], surfaceBefore);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].archive.status, "refused");
		assert.match(lines[0].archive.reason, /rejected the archive write/);
	});

	it("skips the archive only when the policy turns it off explicitly", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({ config: { enabled: true, archive: false, auditPath: join(dir, "audit.jsonl") } });
		const result = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.ok(result !== null);
		assert.equal(host.spill.calls.length, 0);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].archive.status, "skipped");
		assert.equal(lines[0].status, "committed");
	});
});

describe("explicit compactRegion", () => {
	it("rejects an unbalanced, missing, or reversed range before writing anything", async () => {
		const dir = await tempDir();
		const session = newSession();
		const { stepSeqs } = buildConversation(session, { steps: 2 });
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session).agent;
		const nodes = session.surface.nodes;
		const signal = new AbortController().signal;

		await assert.rejects(() => host.engine.compactRegion(stepSeqs[0].assistant, stepSeqs[0].assistant, agent, signal), /not a balanced boundary/);
		await assert.rejects(() => host.engine.compactRegion(9999, nodes.at(-1), agent, signal), /not found in surface/);
		await assert.rejects(() => host.engine.compactRegion(nodes.at(-1), nodes[1], agent, signal), /is after end seq/);
		assert.equal(session.surface.replaceGeneration, 0);
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/start"), false);

		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.length, 3);
		for (const line of lines) {
			assert.equal(line.status, "refused");
			assert.equal(line.reason, "unbalanced-or-missing-range");
		}
	});

	it("compacts a forced balanced region inside an open turn and records the forced gate", async () => {
		const dir = await tempDir();
		const session = newSession();
		const { stepSeqs } = buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session).agent;
		/* `session.surface.nodes` is the LIVE array; copy it before the replacement mutates it. */
		const nodesBefore = [...session.surface.nodes];
		const start = nodesBefore[1];
		const end = stepSeqs[1].toolResult;
		const result = await host.engine.compactRegion(start, end, agent, new AbortController().signal);
		assert.deepEqual(result.shadowedSeqs, nodesBefore.slice(nodesBefore.indexOf(start), nodesBefore.indexOf(end) + 1));
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].trigger, "compactRegion");
		assert.equal(lines[0].gate.reason, "forced-region");
		assert.equal(lines[0].turn, 1, "an automatic bracket is enclosed in the open turn");
	});
});

describe("tool-result-pruner wiring", () => {
	it("calls the pruner exactly once on the pressure path and re-measures afterwards", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 10_000 }),
			prunerOptions: { onPrune: () => { host.meter.perNode = 1; } },
		});
		host.meter.perNode = 1_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.equal(host.pruner.sessions.length, 1, "the pruner never listens for events; the backend must call it");
		assert.equal(result, null, "the prune removed enough pressure that no compaction was needed");
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/start"), false);
	});

	it("compacts when pressure stays above the threshold after pruning", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 10_000 }),
		});
		host.meter.perNode = 1_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.ok(result !== null);
		assert.equal(host.pruner.sessions.length, 1);
		assert.equal(host.meter.measureCalls >= 4, true, "measure before and after the prune, then once per attempt");
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].trigger, "pressure");
		assert.equal(lines[0].status, "committed");
		assert.equal(lines[0].turn, 1);
	});
});

describe("automatic triggers", () => {
	it("does no work at all while the mechanism is disabled", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session).agent;
		const result = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		assert.equal(result, null);
		assert.equal(host.meter.measureCalls, 0, "a disabled engine does not even measure");
		assert.equal(host.llm.resolveCalls, 0);
		assert.equal(session.surface.replaceGeneration, 0);

		/* Structural proof of "off = zero listeners": a real waterfall dispatch never reaches the engine. */
		let reached = 0;
		host.engine.compactIfNeeded = async () => {
			reached += 1;
			return null;
		};
		const next = async () => "next";
		const signal = new AbortController().signal;
		assert.equal(await host.ctx.waterfall("agent/pre-step", { agent, messages: [], turn: 1, step: 1, signal }, next), "next");
		assert.equal(reached, 0);
		assert.equal(await host.ctx.waterfall("agent/request-error", { agent, turn: 1, step: 1, provider: "mock-provider", failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal }, next), "next");
		assert.equal(reached, 0);
	});

	it("registers the pre-step listener and compacts once pressure crosses the threshold", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 10_000 }),
		});
		host.meter.perNode = 1_000;
		const agent = makeAgent(session).agent;
		const next = async () => "next";
		const outcome = await host.ctx.waterfall("agent/pre-step", { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, next);
		assert.equal(outcome, "next");
		assert.equal(session.surface.replaceGeneration, 1);
		assert.equal(host.logger.warnings.length, 0);
		assert.equal(host.logger.infos.filter((line) => line.includes("compaction (step pressure)")).length, 1);
	});

	it("does nothing below the pressure threshold", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 1_000_000 }),
		});
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		assert.equal(result, null);
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/start"), false);
	});

	it("warns once per unroutable target and keeps the turn alive", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: null }),
		});
		host.meter.perNode = 1_000_000;
		const agent = makeAgent(session).agent;
		const next = async () => "next";
		for (let index = 0; index < 3; index += 1) {
			assert.equal(await host.ctx.waterfall("agent/pre-step", { agent, messages: [], turn: 1, step: index + 1, signal: new AbortController().signal }, next), "next");
		}
		assert.equal(host.logger.warnings.filter((line) => line.includes("step compaction failed")).length, 1, "one warning per target, not one per step");
		assert.equal(session.surface.replaceGeneration, 0);
		await assert.rejects(
			() => host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal),
			(error) => {
				assert.ok(error instanceof TargetPressureConfigError);
				assert.equal(error.targetKey, "mock-provider/mock-model-1");
				return true;
			},
		);
	});

	it("throws when pressure is still above the threshold after the configured attempts", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 10_000 }),
		});
		host.meter.perNode = 1_000_000;
		await assert.rejects(
			() => host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal),
			/still above threshold after 1 compaction attempts/,
		);
		assert.equal(session.surface.replaceGeneration, 1, "the one allowed attempt still landed");
	});
});

describe("context-overflow recovery", () => {
	const overflowPayload = (agent, signal) => ({
		agent,
		turn: 1,
		step: 1,
		provider: "mock-provider",
		failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
		retryPolicy: undefined,
		signal,
	});

	it("forces one balanced reduction and asks the loop to retry, within the budget", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, maxOverflowRetries: 1, auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session).agent;
		const next = async () => "next";
		const signal = new AbortController().signal;
		assert.deepEqual(await host.ctx.waterfall("agent/request-error", overflowPayload(agent, signal), next), { kind: "retry" });
		assert.equal(session.surface.replaceGeneration, 1);
		assert.deepEqual(await host.ctx.waterfall("agent/request-error", overflowPayload(agent, signal), next), "next", "the retry budget is durable per agent");
		assert.equal(session.surface.replaceGeneration, 1);
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines[0].trigger, "context-overflow");
	});

	it("does not retry when the budget is zero", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, maxOverflowRetries: 0, auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session).agent;
		assert.equal(await host.ctx.waterfall("agent/request-error", overflowPayload(agent, new AbortController().signal), async () => "next"), "next");
		assert.equal(session.surface.replaceGeneration, 0);
	});

	it("does not retry when the surface generation did not advance", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, maxOverflowRetries: 1, auditPath: join(dir, "audit.jsonl") } });
		let calls = 0;
		host.engine.compactIfNeeded = async () => {
			calls += 1;
			return { shadowedSeqs: [], shadowedRange: { start: 0, end: 0 }, shadowedTokenCount: 0 };
		};
		const agent = makeAgent(session).agent;
		assert.equal(await host.ctx.waterfall("agent/request-error", overflowPayload(agent, new AbortController().signal), async () => "next"), "next");
		/* No durable progress means the recovery simply delegates: the original request error stands and
		 * no warning is emitted (basic's behavior, preserved). */
		assert.equal(calls, 1);
		assert.equal(host.logger.warnings.length, 0);
	});

	it("retries after durable progress even when the attempt itself failed", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, maxOverflowRetries: 1, auditPath: join(dir, "audit.jsonl") } });
		host.engine.compactIfNeeded = async (agent, _trigger, signal) => {
			const range = selectCompactableRange(agent.session, host.meter.measure(agent.session), 0);
			await host.engine.compactRegion(range.start, range.end, agent, signal);
			throw new Error("summarizer exploded after the replacement landed");
		};
		const agent = makeAgent(session).agent;
		const signal = new AbortController().signal;
		assert.deepEqual(await host.ctx.waterfall("agent/request-error", overflowPayload(agent, signal), async () => "next"), { kind: "retry" });
		assert.equal(host.logger.warnings.filter((line) => line.includes("retrying from the replacement surface")).length, 1);
	});

	it("ignores other failure codes and an aborted signal", async () => {
		const dir = await tempDir();
		const session = newSession();
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, auditPath: join(dir, "audit.jsonl") } });
		const agent = makeAgent(session).agent;
		const other = { ...overflowPayload(agent, new AbortController().signal), failure: { code: "SOMETHING_ELSE" } };
		assert.equal(await host.ctx.waterfall("agent/request-error", other, async () => "next"), "next");
		const controller = new AbortController();
		controller.abort(new Error("turn cancelled"));
		assert.equal(await host.ctx.waterfall("agent/request-error", overflowPayload(agent, controller.signal), async () => "next"), "next");
		assert.equal(session.surface.replaceGeneration, 0);
	});
});

describe("summarization call", () => {
	it("reuses the session system prefix and tools, and records llm-replay provenance", async () => {
		const dir = await tempDir();
		const session = newSession("session-summarize", { tools: [{ name: "read", description: "read a file", parameters: {} }] });
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({ config: { enabled: true, maxTokens: 512, auditPath: join(dir, "audit.jsonl") } });
		const surfaceBefore = [...session.surface.nodes];
		await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);

		assert.equal(host.llm.calls.length, 1);
		const call = host.llm.calls[0];
		assert.equal(call.provider, "mock-provider");
		assert.equal(call.model, "mock-model-1");
		assert.equal(call.purpose, "compaction");
		assert.equal(call.maxTokens, 512);
		assert.equal(call.sessionId, "session-summarize");
		assert.equal(call.messages[0].role, "system", "the conversation's own system prompt leads the call so the KV prefix is reused");
		assert.equal(call.messages.at(-1).source.plugin, "dsh-context-compact");
		assert.match(call.messages.at(-1).content[0].text, /^You are now acting as a compaction engine/);
		assert.deepEqual(call.tools, [{ name: "read", description: "read a file", parameters: {} }]);

		const summaryEvent = session.snapshotEvents().find((event) => event.type === "compaction/summary");
		assert.equal(summaryEvent.data.llmStreamCall, true);
		assert.deepEqual(summaryEvent.data.rawOutput, [{ type: "text", text: host.llm.summaryText }]);
		assert.deepEqual(summaryEvent.data.usage, { inputTokens: 111, cacheReadTokens: 222, cacheWriteTokens: 333, outputTokens: 44 });
		assert.equal(summaryEvent.data.provider, "mock-provider");
		assert.equal(summaryEvent.data.model, "mock-model-1");
		assert.equal(summaryEvent.data.maxTokens, 512);
		assert.deepEqual(summaryEvent.data.shadowedRange, { start: surfaceBefore[1], end: surfaceBefore.at(-2) });
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(lines[0].summary.usage, { inputTokens: 111, cacheReadTokens: 222, cacheWriteTokens: 333, outputTokens: 44 });
	});
});
