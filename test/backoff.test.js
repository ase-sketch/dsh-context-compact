/**
 * Failed-region backoff (M4-D): a selection whose summarization was paid for and rejected must not
 * be retried unchanged while the surface has not moved.
 *
 * Evidence this closes: the 2026-09-16 19:02 compact-arm re-record spent 16 rejected summarizer
 * calls, EVERY one of them stage:`summary` "not smaller than the shadowed content", several of them
 * on the byte-identical single-node range (287-287 twice, 395-395 three times, 426-426 twice).
 * Retrying an unchanged selection buys the same rejection at full price.
 *
 * Everything here runs on real sessions, the real surface fold, the real cordis context and real
 * tool-pairing checks; the only double is the deterministic `FakeLlm` (zero API calls).
 *
 * @module @sol-pi-port/dsh-context-compact/test/backoff
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import {
	FAILED_RANGE_BACKOFF_REASON,
	FAILED_RANGE_GROWTH_CAP_TOKENS,
	FAILED_RANGE_GROWTH_MARGIN,
	failedRangeKey,
	isBackedOff,
} from "../lib/engine.js";
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
	assert.deepEqual(await snapshotFile(hostAuditPath()), hostAuditBefore, "the suite must never write to the developer's real audit file");
});

/** One audit line per recorded event, in order. */
async function auditLines(path) {
	const text = await readFile(path, "utf8");
	return text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

const WINDOW = 25_000;
const PER_NODE = 5_000;
/** +12% on the surface price with the selected span byte-identical: releases the backoff. */
const GROWN_PER_NODE = 5_600;
/** A summary far larger than any shadowed span in this suite: the recorded `summary` failure class. */
const BIG_SUMMARY = "x".repeat(400_000);

const agentOf = (session) => makeAgent(session).agent;

/**
 * Mount an enabled pressure engine whose summarizer always produces a summary that cannot be
 * smaller than the shadowed range, i.e. the `stage:"summary"` failure the recording is made of.
 */
async function mountRejectingEngine(dir, id = "backoff-same-range") {
	const session = newSession(id);
	buildConversation(session, { steps: 3 });
	const host = await mountHost({
		config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl") },
		llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: WINDOW, summaryText: BIG_SUMMARY }),
	});
	host.meter.perNode = PER_NODE;
	return { session, host };
}

/** Run one pressure decision, asserting it is the recorded rejection rather than some other fault. */
async function rejectedAttempt(host, session) {
	await assert.rejects(
		() => host.engine.compactIfNeeded(agentOf(session), "pressure", new AbortController().signal),
		(error) => {
			assert.match(error.message, /not smaller than the shadowed content/);
			return true;
		},
	);
}

describe("failed-range key (unconditional facts)", () => {
	it("recognizes the same range at the same price and releases it once the surface has grown", () => {
		const key = failedRangeKey({ start: 287, end: 287 }, 28_003);
		assert.deepEqual(key, { start: 287, end: 287, totalTokens: 28_003 });
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, 28_003), true, "an unchanged surface must not pay for the same rejection twice");
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, 28_956), true, "+3.4% is the recording's own second 287-287 attempt: still the same selection");
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, 30_804), false, "past the declared +10% margin the selection is retried");
		assert.equal(isBackedOff(key, { start: 306, end: 306 }, 28_003), false, "a different range is a different selection");
		assert.equal(isBackedOff(undefined, { start: 287, end: 287 }, 28_003), false, "nothing has failed yet");
		assert.equal(isBackedOff(null, { start: 287, end: 287 }, 28_003), false);
	});

	it("declares the release margin, the absolute growth cap, and the audit reason as named constants", () => {
		assert.equal(FAILED_RANGE_GROWTH_MARGIN, 0.1);
		assert.equal(FAILED_RANGE_GROWTH_CAP_TOKENS, 4_096);
		assert.equal(FAILED_RANGE_BACKOFF_REASON, "failed_region_backoff");
	});
});

describe("same selection, no growth (M4-D)", () => {
	it("defers the second evaluation of a just-rejected selection and pays for no second summarizer call", async () => {
		const dir = await tempDir();
		const { session, host } = await mountRejectingEngine(dir);
		const surfaceBefore = [...session.surface.nodes];

		await rejectedAttempt(host, session);
		assert.equal(host.llm.calls.length, 1, "the first attempt did pay for one summarizer call");
		const [first] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(first.status, "failed");
		assert.equal(first.stage, "summary", "the recorded failure class is the one that consumed a model call and rejected its output");

		/* A durable header refresh passes without moving the surface: the same decision is due again. */
		session.append("request/header", {
			header: { config: { provider: "mock-provider", model: "mock-model-1" } },
			reason: "initial",
		});
		assert.deepEqual([...session.surface.nodes], surfaceBefore, "the surface did not move between the two decisions");

		const second = await host.engine.compactIfNeeded(agentOf(session), "pressure", new AbortController().signal);
		assert.equal(second, null, "a backed-off evaluation compacts nothing");
		assert.equal(host.llm.calls.length, 1, "no second summarizer call was paid for");
		assert.equal(host.spill.calls.length, 1, "and nothing was archived a second time");
		assert.deepEqual([...session.surface.nodes], surfaceBefore);
		assert.equal(session.surface.replaceGeneration, 0);
		assert.equal(
			session.snapshotEvents().filter((event) => event.type === "compaction/start").length,
			1,
			"a deferred evaluation opens no second transaction",
		);

		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.length, 2, "the deferral is recorded, not silent");
		assert.equal(lines[1].status, "deferred");
		assert.equal(lines[1].reason, FAILED_RANGE_BACKOFF_REASON, "the deferred line names the backoff, not the economic gate");
		assert.deepEqual(lines[1].shadowedRange, first.shadowedRange, "the skipped selection is the one that just failed");
		assert.deepEqual(lines[1].shadowedSeqs, first.shadowedSeqs);
		assert.deepEqual(lines[1].backoff, { start: first.shadowedRange.start, end: first.shadowedRange.end, totalTokens: 55_000, margin: 0.1, growthCapTokens: 4_096 }, "the line carries the key it matched and the whole rule that will release it");
		assert.equal(lines[1].trigger, "pressure");
		assert.equal(lines[1].turn, 1);
		assert.equal(host.logger.warnings.length, 0, "a backoff is a decision, not a failure");
	});

	it("retries the same range once the surface price has grown past the margin", async () => {
		const dir = await tempDir();
		const { session, host } = await mountRejectingEngine(dir, "backoff-growth");
		const agent = agentOf(session);

		await rejectedAttempt(host, session);
		assert.equal(host.llm.calls.length, 1);
		assert.equal(await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal), null);
		assert.equal(host.llm.calls.length, 1, "still backed off while the surface price is unchanged");

		/* +12% on the surface price with the selected span byte-identical: the selection is released. */
		host.meter.perNode = GROWN_PER_NODE;
		host.llm.summaryText = "## compacted";
		const result = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		assert.notEqual(result, null, "the grown surface is retried instead of being skipped forever");
		assert.equal(host.llm.calls.length, 2, "the retry is a real attempt that pays for a summarizer call");
		assert.equal(session.surface.replaceGeneration, 1);

		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(lines.map((line) => line.status), ["failed", "deferred", "committed"]);
		assert.deepEqual(lines[2].shadowedRange, lines[0].shadowedRange, "the retried range is the one that had failed");
	});

	it("does not back off a different selection, so the recording's wider retry is preserved", async () => {
		const dir = await tempDir();
		const { session, host } = await mountRejectingEngine(dir, "backoff-different-range");
		const agent = agentOf(session);

		await rejectedAttempt(host, session);
		const [failed] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(failed.status, "failed");

		/* Growing the surface moves the selection's END, which is a different key: it must be attempted. */
		appendUser(session, "one more durable step boundary");
		await rejectedAttempt(host, session);

		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.length, 2, "the moved selection was evaluated instead of deferred");
		assert.notDeepEqual(lines[1].shadowedRange, failed.shadowedRange, "the second attempt targeted a different span");
		assert.equal(host.llm.calls.length, 2, "and it did pay for its own summarizer call");
	});

	it("leaves overflow recovery intact after a pressure failure", async () => {
		const dir = await tempDir();
		const { session, host } = await mountRejectingEngine(dir, "backoff-overflow");
		const agent = agentOf(session);

		/* The pressure attempt fails and is remembered — that must NOT become a veto over the
		 * correctness path. Overflow recovery is the safety valve: if the window actually blows, the
		 * engine still has to try, which is the existing "overflow never vetoed" obligation (D1). */
		await rejectedAttempt(host, session);
		assert.equal(host.llm.calls.length, 1);

		host.llm.summaryText = "## compacted";
		const outcome = await host.ctx.waterfall(
			"agent/request-error",
			{
				agent,
				turn: 1,
				step: 1,
				provider: "mock-provider",
				failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
				retryPolicy: undefined,
				signal: new AbortController().signal,
			},
			async () => "next",
		);
		assert.deepEqual(outcome, { kind: "retry" }, "overflow recovery still compacts and asks for the retry");
		assert.equal(session.surface.replaceGeneration, 1);
		assert.equal(host.llm.calls.length, 2, "the recovery call was paid for despite the remembered pressure failure");
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(lines.at(-1).status, "committed");
		assert.equal(lines.some((line) => line.reason === FAILED_RANGE_BACKOFF_REASON && line.trigger === "context-overflow"), false, "the backoff never covers the overflow trigger");
	});

	it("never lets one failed /compact disable the next one", async () => {
		const dir = await tempDir();
		const session = newSession("backoff-manual");
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: WINDOW, summaryText: BIG_SUMMARY }),
		});
		host.meter.perNode = PER_NODE;

		for (const attempt of [1, 2]) {
			await assert.rejects(
				() => host.engine.compactNow(agentOf(session), new AbortController().signal),
				(error) => {
					assert.match(error.cause?.message ?? error.message, /not smaller than the shadowed content/);
					return true;
				},
			);
			assert.equal(host.llm.calls.length, attempt, `the human's request #${attempt} must reach the summarizer`);
		}
		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(lines.map((line) => line.status), ["failed", "failed"], "a manual failure is never turned into a backoff");
		assert.equal(lines.some((line) => line.reason === FAILED_RANGE_BACKOFF_REASON), false);
	});

	it("leaves the disabled path byte-for-byte unchanged", async () => {
		const dir = await tempDir();
		const session = newSession("backoff-disabled");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { auditPath: join(dir, "audit.jsonl") } });
		host.meter.perNode = PER_NODE;
		assert.equal(await host.engine.compactIfNeeded(agentOf(session), "pressure", new AbortController().signal), null);
		assert.equal(host.llm.calls.length, 0);
		assert.equal(session.snapshotEvents().some((event) => event.type === "compaction/start"), false);
	});

	it("records nothing when the mechanism is on but the selection never fails", async () => {
		const dir = await tempDir();
		const session = newSession("backoff-clean");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: WINDOW, summaryText: "## compacted" }),
		});
		host.meter.perNode = PER_NODE;
		const result = await host.engine.compactIfNeeded(agentOf(session), "pressure", new AbortController().signal);
		assert.notEqual(result, null);
		assert.equal((await auditLines(join(dir, "audit.jsonl")))[0].status, "committed");
	});
});

describe("release thresholds: proportional below the cap, absolute at and above it", () => {
	/* 1_000_000 x 10% = 100_000: what the old single-threshold rule demanded before releasing. */
	const LARGE_PRICE = 1_000_000;

	it("releases a small surface on the proportion, exactly as before (the cap is not binding)", () => {
		/* 28_003 x 10% = 2_800.3 < 4_096, so the proportion is the binding half here. If the cap were
		 * used instead, +2_801 would still be withheld — this boundary is what proves which half won. */
		const key = failedRangeKey({ start: 287, end: 287 }, 28_003);
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, 30_803), true, "+9.99% is inside the +10% band");
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, 30_804), false, "+10.0% reaches the smaller half of the rule and releases");
		assert.equal(isBackedOff(key, { start: 306, end: 306 }, 30_804), false, "a different span is still a different selection");
	});

	it("releases a large surface once the growth reaches the absolute cap, not only at +10%", () => {
		const key = failedRangeKey({ start: 287, end: 287 }, LARGE_PRICE);
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, LARGE_PRICE), true, "the unchanged surface is still withheld");
		assert.equal(isBackedOff(key, { start: 287, end: 287 }, LARGE_PRICE + 4_095), true, "+4_095 tokens is below the declared cap");
		assert.equal(
			isBackedOff(key, { start: 287, end: 287 }, LARGE_PRICE + 4_096),
			false,
			"at a large surface price the release threshold is min(10%, 4_096 tokens) = 4_096: +4_096 must release, not demand +100_000",
		);
		assert.equal(isBackedOff(key, { start: 306, end: 306 }, LARGE_PRICE + 4_096), false, "a different span is still a different selection");
		assert.equal(isBackedOff(undefined, { start: 287, end: 287 }, LARGE_PRICE + 4_096), false, "nothing has failed yet");
	});

	it("releases a byte-identical span on a real large surface where the proportion alone could not", async () => {
		const dir = await tempDir();
		const session = newSession("backoff-growth-cap");
		buildConversation(session, { steps: 3 });
		/* threshold 0.9 / retain 0.5: the surface prices at 11 x 5_000 = 55_000 against a 36_000 trigger,
		 * and the compacted surface (5 x 5_400 = 27_000) is back under it, so no retry budget is needed. */
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, thresholdRatio: 0.9, retainRatio: 0.5, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 40_000, summaryText: "x".repeat(200_000) }),
		});
		host.meter.perNode = 5_000;
		const agent = agentOf(session);

		await rejectedAttempt(host, session);
		const [failed] = await auditLines(join(dir, "audit.jsonl"));
		assert.equal(failed.status, "failed");
		assert.equal(failed.stage, "summary");

		const surfaceBefore = [...session.surface.nodes];
		assert.equal(await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal), null, "unchanged surface: still withheld");
		assert.equal(host.llm.calls.length, 1);

		/* +8% on the surface price (5_000 -> 5_400 per node, +4_400 total) with the span byte-identical.
		 * The old rule needed +10% (5_500); the declared rule needs min(10%, 4_096) = 4_096. */
		host.meter.perNode = 5_400;
		host.llm.summaryText = "## compacted";
		const result = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		assert.notEqual(result, null, "growth past the absolute cap releases the span instead of withholding it until +10%");
		assert.equal(host.llm.calls.length, 2, "the released retry pays for its own summarizer call");
		assert.equal(session.surface.replaceGeneration, 1);
		assert.equal(session.surface.nodes.length < surfaceBefore.length, true, "and it really replaced the span");

		const lines = await auditLines(join(dir, "audit.jsonl"));
		assert.deepEqual(lines.map((line) => line.status), ["failed", "deferred", "committed"], "withheld once, then released by the cap");
		assert.equal(lines[1].reason, FAILED_RANGE_BACKOFF_REASON);
		assert.equal(lines[1].backoff.growthCapTokens, FAILED_RANGE_GROWTH_CAP_TOKENS, "the withheld line already published the cap that would release it");
		assert.deepEqual(lines[2].shadowedRange, lines[0].shadowedRange, "the retried span is the one that had failed");
	});
});

