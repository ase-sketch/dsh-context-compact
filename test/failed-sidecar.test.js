/**
 * M4-A red test: a FAILED compaction attempt that already consumed the summarizer stream must leave a
 * replay-visible sidecar trace next to the audit file.
 *
 * Root cause this pins down (eval/compact-arms/m3-g5-faithful-root-cause.md): the engine holds the
 * complete `rawOutput` of the summarizer stream by the time it rejects the summary, but the rejection
 * lands no `compaction/summary` event, so llm-replay derives one script entry too few and positional
 * replay shifts by one from that point on.
 *
 * @module @sol-pi-port/dsh-context-compact/test/failed-sidecar
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	FakeLlm,
	buildConversation,
	cleanupTempDirs,
	closeTurn,
	makeAgent,
	mountHost,
	newSession,
	appendUser,
	tempDir,
} from "./helpers.js";

after(cleanupTempDirs);

/** The sidecar the engine must write beside its audit file. */
const SIDECAR_NAME = "replay-failed-compactions.jsonl";

/**
 * Read one JSONL file into parsed lines; `undefined` when the file is absent.
 * @param {string} path
 * @returns {Promise<object[]|undefined>}
 */
async function readJsonl(path) {
	try {
		const text = await readFile(path, "utf8");
		return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * A summarizer double whose stream completes BEFORE it moves the surface: the compaction then fails
 * `assertStable` with a consumed stream and no summary event, the second shape M4-A must trace.
 */
class MutatingLlm extends FakeLlm {
	constructor(ctx, session, mutate) {
		super(ctx, { summaryText: "## surface moved" });
		this.session = session;
		this.mutate = mutate;
	}

	async *stream(options) {
		this.calls.push(options);
		const chunks = [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "text-delta", index: 0, text: "## surface moved" },
			{ type: "block-end", index: 0, block: { type: "text", text: "## surface moved" } },
			{ type: "finish", reason: { kind: "stop" } },
		];
		for (const chunk of chunks) yield chunk;
		this.mutate();
	}
}

/** A session whose conversation is big enough for one manual compaction, with a turn closed. */
function compactableSession(id = "sidecar-unit") {
	const session = newSession(id);
	const built = buildConversation(session, { steps: 3 });
	closeTurn(session);
	return { session, built };
}

describe("M4-A failed-attempt replay sidecar", () => {
	it("writes one sidecar line when the summarizer stream was consumed and the summary was rejected", async () => {
		const dir = await tempDir();
		const { session } = compactableSession();
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { summaryText: "x".repeat(4000), usage: { inputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 9, outputTokens: 10 } }),
		});
		host.meter.perNode = 10;
		await assert.rejects(
			() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal),
			(error) => {
				assert.equal(error.code, "summary");
				return true;
			},
		);
		/* The engine must have flushed the sidecar before it returns the failure. */
		const lines = await readJsonl(join(dir, SIDECAR_NAME));
		assert.notEqual(lines, undefined, "the failed attempt must leave replay-failed-compactions.jsonl beside the audit file");
		assert.equal(lines.length, 1, "exactly one failed attempt ⇒ exactly one sidecar line");
		const record = lines[0];

		/* The failed attempt's own durable bracket is the anchor llm-replay needs. */
		const events = session.snapshotEvents();
		const start = events.find((event) => event.type === "compaction/start");
		const end = events.find((event) => event.type === "compaction/end");
		assert.equal(record.compactionId, start.data.compactionId, "the sidecar names the attempt it belongs to");
		assert.equal(record.turn, start.data.turn, "and the turn it ran in");
		assert.equal(record.endSeq, end.seq, "the position anchor is the failed attempt's own compaction/end seq");
		assert.equal(record.trigger, "manual", "the trigger that produced the attempt is recorded");

		/* The chunks must be drop-in compatible with a derived compaction/summary entry: the same
		 * block-start/block-end pairs, the usage chunk when the stream carried one, then finish. */
		const rawOutput = [{ type: "text", text: "x".repeat(4000) }];
		assert.deepEqual(record.rawOutput, rawOutput, "the consumed raw output is preserved verbatim");
		assert.deepEqual(record.chunks, [
			{ type: "block-start", index: 0, blockType: "text" },
			{ type: "block-end", index: 0, block: { type: "text", text: "x".repeat(4000) } },
			{ type: "usage", usage: { inputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 9, outputTokens: 10 } },
			{ type: "finish", reason: { kind: "stop" } },
		]);
		assert.equal(record.usage.inputTokens, 7, "the summarizer call's usage travels with the trace");
		assert.equal(typeof record.schema, "string");
		assert.equal(record.sessionId, String(session.id));
	});

	it("writes nothing when the attempt commits", async () => {
		const dir = await tempDir();
		const { session } = compactableSession("sidecar-committed");
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { summaryText: "## short summary" }),
		});
		host.meter.perNode = 50;
		await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal);
		assert.equal(await readJsonl(join(dir, SIDECAR_NAME)), undefined, "a committed attempt lands a compaction/summary event and needs no sidecar");
	});

	it("writes one sidecar line when the summarizer stream was consumed and the surface then moved", async () => {
		const dir = await tempDir();
		/* The automatic path needs an OPEN turn: an automatic bracket must be enclosed in one. */
		const session = newSession("sidecar-surface-moved");
		buildConversation(session, { steps: 3 });
		/* The selection is validated BEFORE the summarizer runs, so a surface change during the call is a
		 * second, independent way to consume a stream and land no summary. */
		/* The automatic path uses WHOLE-SURFACE stability, so a node appearing anywhere during the
		 * summarization call is what invalidates this attempt. */
		const host = await mountHost({
			config: { enabled: true, thresholdRatio: 0.01, retainRatio: 0.001, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new MutatingLlm(ctx, session, () => appendUser(session, "a message that arrives mid-summarization")),
		});
		/* perNode must clear floor(contextWindow * thresholdRatio) = 1000 so pressure fires at all. */
		host.meter.perNode = 20_000;
		await assert.rejects(
			() => host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal),
			/surface changed during summarization/,
		);
		const lines = await readJsonl(join(dir, SIDECAR_NAME));
		assert.notEqual(lines, undefined, "a surface-changed failure also lost a consumed stream");
		assert.equal(lines.length, 1);
		assert.equal(lines[0].stage, "summary");
		assert.deepEqual(lines[0].rawOutput, [{ type: "text", text: "## surface moved" }]);
		/* The anchor must be the failed attempt's own end seq, exactly as in the size-rejection case. */
		const end = session.snapshotEvents().find((event) => event.type === "compaction/end");
		assert.equal(lines[0].endSeq, end.seq);
	});

	it("writes nothing when the attempt failed before the summarizer stream was consumed", async () => {
		const dir = await tempDir();
		const { session } = compactableSession("sidecar-archive-refused");
		const host = await mountHost({
			config: { enabled: true, auditPath: join(dir, "audit.jsonl") },
			spill: null,
		});
		await assert.rejects(() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal));
		assert.equal(await readJsonl(join(dir, SIDECAR_NAME)), undefined, "an archive refusal consumes no model stream, so it adds no script entry");
	});

	it("writes nothing when the mechanism is disabled", async () => {
		const dir = await tempDir();
		const { session } = compactableSession("sidecar-disabled");
		const host = await mountHost({
			config: { enabled: false, auditPath: join(dir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { summaryText: "x".repeat(4000) }),
		});
		host.meter.perNode = 10;
		await assert.rejects(() => host.engine.compactNow(makeAgent(session).agent, new AbortController().signal));
		assert.equal(await readJsonl(join(dir, SIDECAR_NAME)), undefined, "the default-off path must have zero side effects");
		assert.equal((await readJsonl(join(dir, "audit.jsonl"))).length, 1, "the audit line still lands: auditing is not the mechanism switch");
	});
});


