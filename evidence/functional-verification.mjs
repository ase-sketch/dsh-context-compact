/**
 * Zero-API functional verification for dsh-context-compact (phase4-plan.md §6 "零 API 功能验证").
 *
 * Zero network and zero model cost: the only LLM is `FakeLlm` (a deterministic StreamChunk
 * sequence), while the session, the surface fold, the `surfaceOp {op:"replace"}` replacement, the
 * `compaction/*` brackets, the cordis context, and the tool-pairing checks are all REAL host code.
 *
 * This is NOT a test-framework run: it prints the facts it observed, so the transcript is the
 * evidence, and exits non-zero when any scenario fails.
 *
 * Run:  node evidence/functional-verification.mjs
 *
 * @module @sol-pi-port/dsh-context-compact/evidence/functional-verification
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import {
	FakeLlm,
	FakePruner,
	FakeSessions,
	FakeSpillStore,
	FakeTokenMeter,
	appendSystem,
	appendTodo,
	appendToolStep,
	appendUser,
	buildConversation,
	cleanupTempDirs,
	closeTurn,
	makeAgent,
	mountHost,
	newSession,
	openStep,
	silentLogger,
	startTurn,
	tempDir,
} from "../test/helpers.js";

/* llm-replay and the session format catalog live ONLY in the eval profile (they are the replay
 * harness, not a dependency of this plugin), so they are imported by absolute path. */
const EVAL_PROFILE = process.env.CC_EVAL_PROFILE ?? join(homedir(), ".dsh", "profiles", "eval");
const REPLAY_MODULE = join(EVAL_PROFILE, "node_modules", "@deepseek-ai", "dsh-llm-replay", "lib", "index.js");
const CATALOG_MODULE = join(EVAL_PROFILE, "node_modules", "@deepseek-ai", "dsh-session-format-catalog", "lib", "index.js");

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
 * @param {string} name
 * @param {() => Promise<void>} body
 */
async function scenario(name, body) {
	console.log("");
	console.log(`### ${name}`);
	await body();
}

const dir = await tempDir("cc-functional-");
const auditPath = (name) => join(dir, `${name}.jsonl`);
const auditLines = async (path) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

try {
	console.log("# dsh-context-compact — zero-API functional verification");
	console.log("");
	console.log(`- node ${process.version}`);
	console.log(`- workspace ${dir}`);
	console.log("- LLM: FakeLlm (deterministic chunks; no network, no provider keys)");
	console.log("- session/surface/brackets/pairing/cordis: real host code");

	/* ------------------------------------------------------------------ 1 disabled shape -------- */
	await scenario("1. disabled by default: no listener, no measurement, no write", async () => {
		const session = newSession("session-disabled");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { auditPath: auditPath("disabled") } });
		host.meter.perNode = 1_000_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		ok("compactIfNeeded returns null while disabled", result === null, String(result));
		ok("no token measurement happened", host.meter.measureCalls === 0, `measureCalls=${host.meter.measureCalls}`);
		ok("no model route resolution happened", host.llm.resolveCalls === 0, `resolveCalls=${host.llm.resolveCalls}`);
		let reached = 0;
		host.engine.compactIfNeeded = async () => {
			reached += 1;
			return null;
		};
		const next = async () => "next";
		const signal = new AbortController().signal;
		await host.ctx.waterfall("agent/pre-step", { agent: makeAgent(session).agent, messages: [], turn: 1, step: 1, signal }, next);
		await host.ctx.waterfall("agent/request-error", { agent: makeAgent(session).agent, turn: 1, step: 1, provider: "mock-provider", failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal }, next);
		ok("a real waterfall dispatch never reaches the engine (zero listeners)", reached === 0, `reached=${reached}`);
		ok("no compaction event was appended", session.snapshotEvents().every((event) => !event.type.startsWith("compaction/")), session.snapshotEvents().map((event) => event.type).join(","));
		ok("no audit file was written", await readFile(auditPath("disabled"), "utf8").then(() => false, () => true));
	});

	/* ------------------------------------------------------------- 2 full transaction ----------- */
	let manualSession;
	let manualHost;
	let manualResult;
	await scenario("2. one complete compaction: start -> archive -> summary -> replace -> end", async () => {
		manualSession = newSession("session-manual");
		const { stepSeqs } = buildConversation(manualSession, { steps: 3 });
		closeTurn(manualSession);
		const surfaceBefore = [...manualSession.surface.nodes];
		manualHost = await mountHost({
			config: { enabled: true, maxTokens: 512, auditPath: auditPath("manual") },
		});
		manualResult = await manualHost.engine.compactNow(makeAgent(manualSession).agent, new AbortController().signal);
		assert.ok(manualResult !== null);

		const events = manualSession.snapshotEvents();
		const startIndex = events.findIndex((event) => event.type === "compaction/start");
		const sequence = events.slice(startIndex).map((event) => event.type);
		console.log(`  event sequence after turn/end: ${sequence.join(" -> ")}`);
		ok("the bracket is exactly start -> summary -> user/message -> end", sequence.join(",") === "compaction/start,compaction/summary,user/message,compaction/end");
		const startEvent = events[startIndex];
		const endEvent = events.at(-1);
		ok("start/end share one compactionId", startEvent.data.compactionId === endEvent.data.compactionId, startEvent.data.compactionId);
		ok("the close carries no error", endEvent.data.error === undefined);
		ok("the manual bracket is standalone (turn: null)", startEvent.data.turn === null);

		const replacement = events.find((event) => event.type === "user/message" && isReplacementSurfaceEvent(event));
		ok("the replacement is an atomic surfaceOp replace over the span", JSON.stringify(replacement.surfaceOp) === JSON.stringify({ op: "replace", startSeq: manualResult.shadowedRange.start, endSeq: manualResult.shadowedRange.end }), JSON.stringify(replacement.surfaceOp));
		ok("the replacement carries the backend-independent checkpoint source", isCompactCheckpointSource(replacement.data.source), JSON.stringify(replacement.data.source));
		ok("the checkpoint cites start/summary/shadowed events", JSON.stringify(replacement.sourceEventSeqs) === JSON.stringify([manualResult.startSeq, manualResult.summarySeq, ...manualResult.shadowedSeqs]));
		console.log(`  surface ${surfaceBefore.join(",")} -> ${[...manualSession.surface.nodes].join(",")} (replaceGeneration ${manualSession.surface.replaceGeneration})`);
		ok("surface = [system head, checkpoint, retained tail]", JSON.stringify([...manualSession.surface.nodes]) === JSON.stringify([surfaceBefore[0], replacement.seq, surfaceBefore.at(-1)]));
		ok("the system head and the tail are untouched", manualSession.eventAt(surfaceBefore[0]).type === "system/message" && manualSession.eventAt(surfaceBefore.at(-1)).type === "user/message");
		ok("replaceGeneration advanced exactly once", manualSession.surface.replaceGeneration === 1);
		ok("the shadowed span is a contiguous tool-pairing-balanced range", JSON.stringify(manualResult.shadowedSeqs) === JSON.stringify(surfaceBefore.slice(surfaceBefore.indexOf(manualResult.shadowedRange.start), surfaceBefore.indexOf(manualResult.shadowedRange.end) + 1)));
		ok("the first completed step pair is inside the span", manualResult.shadowedSeqs.includes(stepSeqs[0].assistant) && manualResult.shadowedSeqs.includes(stepSeqs[0].toolResult));
		ok("the trailing user message is retained outside the span", !manualResult.shadowedSeqs.includes(surfaceBefore.at(-1)) && [...manualSession.surface.nodes].includes(surfaceBefore.at(-1)));

		const archiveText = manualHost.spill.calls[0].content;
		const archiveHeader = JSON.parse(archiveText.trim().split("\n")[0]);
		console.log(`  archive locator: ${manualResult === null ? "" : manualHost.spill.calls.length} call(s)`);
		ok("the 原文 archive holds one header plus one line per shadowed event", archiveText.trim().split("\n").length === manualResult.shadowedSeqs.length + 1);
		ok("the archive header names the same span", JSON.stringify(archiveHeader.shadowedSeqs) === JSON.stringify(manualResult.shadowedSeqs));
		ok("the archive is recoverable from the log vocabulary", JSON.parse(archiveText.trim().split("\n")[1]).type === manualSession.eventAt(manualResult.shadowedSeqs[0]).type);

		const summaryEvent = events.find((event) => event.type === "compaction/summary");
		ok("compaction/summary marks the llm stream call", summaryEvent.data.llmStreamCall === true);
		ok("compaction/summary carries the complete rawOutput", JSON.stringify(summaryEvent.data.rawOutput) === JSON.stringify([{ type: "text", text: manualHost.llm.summaryText }]));
		ok("compaction/summary carries usage", summaryEvent.data.usage?.inputTokens === 111 && summaryEvent.data.usage?.cacheWriteTokens === 333, JSON.stringify(summaryEvent.data.usage));

		const call = manualHost.llm.calls[0];
		ok("the summarization call reuses the session system prefix", call.messages[0].role === "system", call.messages[0].role);
		ok("the summarization call ends with this plugin's instruction", call.messages.at(-1).source.plugin === "dsh-context-compact" && call.messages.at(-1).content[0].text.startsWith("You are now acting as a compaction engine"));
		ok("the summarization call is a one-shot compaction purpose", call.purpose === "compaction" && call.maxTokens === 512);
		ok("the manual path ran the durability checkpoint once", manualHost.sessions.flushes.length === 1);

		const [line] = await auditLines(auditPath("manual"));
		console.log(`  audit: ${JSON.stringify(line).slice(0, 220)}…`);
		ok("the audit line is committed and complete", line.status === "committed" && line.trigger === "manual" && line.shadowedRange.start === manualResult.shadowedRange.start);
		ok("the audit line records the archive locator", line.archive.status === "ok" && typeof line.archive.locator === "string" && line.archive.bytes > 0, line.archive.locator);
		ok("the audit line records the gate as not evaluated for an explicit manual run", line.gate.enabled === false && line.gate.evaluated === false);
		ok("the audit line records the summarizer route and framed price", line.summary.provider === "mock-provider" && line.summary.framedTokenCount > 0, String(line.summary.framedTokenCount));
		ok("no compaction/start is left unmatched", events.filter((event) => event.type === "compaction/start").length === events.filter((event) => event.type === "compaction/end").length);
	});

	/* ------------------------------------------------------------ 3 automatic triggers ---------- */
	await scenario("3. pressure trigger + explicit toolResultPruner wiring", async () => {
		const session = newSession("session-pressure");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, auditPath: auditPath("pressure") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 10_000 }),
		});
		host.meter.perNode = 1_000;
		const result = await host.engine.compactIfNeeded(makeAgent(session).agent, "pressure", new AbortController().signal);
		ok("pressure above the 80% threshold compacts", result !== null, JSON.stringify(result?.shadowedRange));
		ok("the pruner was called explicitly (it never listens for events)", host.pruner.sessions.length === 1, `pruneSession calls=${host.pruner.sessions.length}`);
		ok("the bracket is enclosed in the open turn", session.snapshotEvents().find((event) => event.type === "compaction/start").data.turn === 1);
		const [line] = await auditLines(auditPath("pressure"));
		ok("the audit line names the pressure trigger and the resolved turn", line.trigger === "pressure" && line.turn === 1, `trigger=${line.trigger} turn=${line.turn}`);

		const quiet = newSession("session-quiet");
		buildConversation(quiet, { steps: 3 });
		const quietHost = await mountHost({
			config: { enabled: true, auditPath: auditPath("quiet") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 1_000_000 }),
		});
		const quietResult = await quietHost.engine.compactIfNeeded(makeAgent(quiet).agent, "pressure", new AbortController().signal);
		ok("below the threshold nothing happens", quietResult === null && quiet.snapshotEvents().every((event) => !event.type.startsWith("compaction/")));
		ok("the quiet path writes no audit line", await readFile(auditPath("quiet"), "utf8").then(() => false, () => true));
	});

	await scenario("4. context-overflow recovery: retry once with a durable budget", async () => {
		const session = newSession("session-overflow");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({ config: { enabled: true, maxOverflowRetries: 1, auditPath: auditPath("overflow") } });
		const agent = makeAgent(session).agent;
		const payload = { agent, turn: 1, step: 1, provider: "mock-provider", failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, retryPolicy: undefined, signal: new AbortController().signal };
		const next = async () => "next";
		const first = await host.ctx.waterfall("agent/request-error", payload, next);
		ok("the first overflow is answered with a retry", JSON.stringify(first) === JSON.stringify({ kind: "retry" }), JSON.stringify(first));
		ok("a replacement landed", session.surface.replaceGeneration === 1);
		const second = await host.ctx.waterfall("agent/request-error", payload, next);
		ok("the second attempt is refused by the retry budget", second === "next", JSON.stringify(second));
		ok("no further replacement happened", session.surface.replaceGeneration === 1);
	});

	/* ---------------------------------------------------------- 5 evidence fail-closed ----------- */
	await scenario("5. evidence preservation is fail-closed", async () => {
		const session = newSession("session-refused");
		buildConversation(session, { steps: 3 });
		closeTurn(session);
		const surfaceBefore = [...session.surface.nodes];
		const host = await mountHost({ config: { enabled: true, auditPath: auditPath("refused") }, spillOptions: { fail: true } });
		const outcome = await host.engine.compactNow(makeAgent(session).agent, new AbortController().signal).then(() => "resolved", (error) => error);
		ok("a rejected archive fails the request", outcome instanceof Error && outcome.code === "summary", String(outcome?.code));
		ok("nothing was replaced", JSON.stringify([...session.surface.nodes]) === JSON.stringify(surfaceBefore) && session.surface.replaceGeneration === 0);
		const types = session.snapshotEvents().map((event) => event.type);
		ok("no summary landed and the bracket still closed with an error", !types.includes("compaction/summary") && session.snapshotEvents().at(-1).data.error !== undefined);
		const [line] = await auditLines(auditPath("refused"));
		ok("the audit line states the refusal", line.status === "failed" && line.stage === "archive" && line.archive.status === "refused", `${line.status}/${line.stage}`);

		const noStore = newSession("session-no-store");
		buildConversation(noStore, { steps: 3 });
		closeTurn(noStore);
		const bare = await mountHost({ config: { enabled: true, auditPath: auditPath("nostore") }, spill: null });
		const bareOutcome = await bare.engine.compactNow(makeAgent(noStore).agent, new AbortController().signal).then(() => "resolved", (error) => error);
		ok("a missing spillStore refuses compaction too", bareOutcome instanceof Error && /no spillStore is composed/.test(bareOutcome.cause?.message ?? ""), String(bareOutcome?.cause?.message));
	});

	/* ------------------------------------------------------- 6 llm-replay compatibility --------- */
	await scenario("6. llm-replay reads the compacted session and replays the summary call", async () => {
		const catalog = (await import(CATALOG_MODULE)).sessionFormatCatalog;
		const replay = await import(REPLAY_MODULE);
		const events = manualSession.snapshotEvents();
		/* A detached test session synthesizes a minimal header; the released v2 envelope requires the
		 * durable fields, so complete them here (this is fixture plumbing, not a plugin behavior). */
		const header = catalog.encodeCurrentHeader({ ...manualSession.header, cwd: process.cwd(), delegationDepth: 0 }, manualSession.inheritedEventCount);
		const text = `${[JSON.stringify(header), ...events.map((event) => JSON.stringify(catalog.encodeCurrentEvent(event)))].join("\n")}\n`;
		const fixturePath = join(dir, "session-compacted.jsonl");
		await writeFile(fixturePath, text);
		console.log(`  fixture: ${fixturePath} (${text.length} bytes, format v${catalog.currentVersion})`);

		const parsedHeader = replay.parseSessionHeader(text);
		ok("llm-replay parses the header of a compacted session", parsedHeader.id === "session-manual", parsedHeader.id);
		const parsedEvents = replay.parseSessionLog(text);
		ok("llm-replay parses every event, compaction/* included", parsedEvents.length === events.length, `${parsedEvents.length}/${events.length}`);
		ok("llm-replay sees the compaction/summary record", parsedEvents.some((event) => event.type === "compaction/summary"));

		const derived = replay.deriveReplayScript(parsedEvents);
		console.log(`  derived model calls: ${derived.length}; chunks: ${derived[0]?.chunks.map((chunk) => chunk.type).join(",")}`);
		ok("the compaction call is reconstructed at its log position", derived.length === 1);
		const chunks = derived[0].chunks;
		ok("the reconstruction is block-start/block-end per rawOutput block + usage + finish", chunks.map((chunk) => chunk.type).join(",") === "block-start,block-end,usage,finish", chunks.map((chunk) => chunk.type).join(","));
		ok("the reconstructed block equals the recorded rawOutput", JSON.stringify(chunks[1].block) === JSON.stringify(manualHost.llm.summaryText === undefined ? null : { type: "text", text: manualHost.llm.summaryText }));
		ok("the reconstructed usage equals the recorded usage", JSON.stringify(chunks[2].usage) === JSON.stringify(manualSession.snapshotEvents().find((event) => event.type === "compaction/summary").data.usage));

		const byFile = replay.loadReplayScript({ file: fixturePath });
		ok("loadReplayScript(file) yields the same script", JSON.stringify(byFile) === JSON.stringify(derived));

		/* End-to-end through llm-replay's own llm/stream interception (still zero network). */
		const ctx = new Context();
		Object.defineProperty(ctx, "logger", { value: silentLogger(), configurable: true, writable: true });
		const handle = replay.installLlmReplay(ctx, { file: fixturePath });
		const next = async () => {
			throw new Error("no provider is composed: the replay must intercept this call");
		};
		const stream = await ctx.waterfall("llm/stream", { sessionId: "session-manual", provider: "mock-provider", model: "mock-model-1", messages: [] }, next);
		const replayed = [];
		for await (const chunk of stream) replayed.push(chunk);
		handle.assertConsumed();
		ok("the intercepted call replays the recorded chunks", JSON.stringify(replayed) === JSON.stringify(chunks), replayed.map((chunk) => chunk.type).join(","));
		ok("the replay consumed the fixture completely (assertConsumed)", true);
		handle.dispose();
	});

	/* ------------------------------------------------- 6b failed-attempt trace (M4-A) ---------- */
	await scenario("6b. a failed attempt leaves a sidecar, and llm-replay derives it back", async () => {
		const catalog = (await import(CATALOG_MODULE)).sessionFormatCatalog;
		const replay = await import(REPLAY_MODULE);
		const sidecarModule = await import("../lib/sidecar.js");
		const failedDir = join(dir, "failed-attempt");
		const failedSession = newSession("session-failed-attempt");
		buildConversation(failedSession, { steps: 3 });
		closeTurn(failedSession);
		const failedHost = await mountHost({
			config: { enabled: true, auditPath: join(failedDir, "audit.jsonl") },
			llmFactory: (ctx) => new FakeLlm(ctx, { summaryText: "x".repeat(4000) }),
		});
		failedHost.meter.perNode = 10;
		const failedOutcome = await failedHost.engine.compactNow(makeAgent(failedSession).agent, new AbortController().signal).then(() => null, (error) => error);
		ok("the summary is rejected", failedOutcome?.code === "summary", failedOutcome?.code);
		const sidecarPath = join(failedDir, sidecarModule.FAILED_COMPACTION_SIDECAR_NAME);
		const sidecarLines = (await readFile(sidecarPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		ok("exactly one trace line lands next to the audit file", sidecarLines.length === 1, sidecarPath);
		const failedEnd = failedSession.snapshotEvents().find((event) => event.type === "compaction/end");
		ok("the trace is anchored to the attempt's own end seq", sidecarLines[0].endSeq === failedEnd.seq, `${sidecarLines[0].endSeq} vs ${failedEnd.seq}`);
		ok("the trace carries the consumed stream verbatim", JSON.stringify(sidecarLines[0].rawOutput) === JSON.stringify([{ type: "text", text: "x".repeat(4000) }]));
		/* The decisive check: llm-replay's OWN derivation on the logged event stream must agree with the
		 * trace's chunk sequence, so a merge at the anchor is a drop-in replacement, not an approximation. */
		const header = catalog.encodeCurrentHeader({ ...failedSession.header, cwd: process.cwd(), delegationDepth: 0 }, failedSession.inheritedEventCount);
		const text = `${[JSON.stringify(header), ...failedSession.snapshotEvents().map((event) => JSON.stringify(catalog.encodeCurrentEvent(event)))].join("\n")}\n`;
		const parsed = replay.parseSessionLog(text);
		const derived = replay.deriveReplayScript(parsed);
		ok("llm-replay derives NO entry for the failed attempt (the M3 shift)", derived.length === 0, `entries=${derived.length}`);
		const committedSession = newSession("session-committed-for-shape");
		buildConversation(committedSession, { steps: 3 });
		closeTurn(committedSession);
		const committedHost = await mountHost({ config: { enabled: true, auditPath: join(dir, "shape-audit.jsonl") } });
		committedHost.meter.perNode = 50;
		const committedResult = await committedHost.engine.compactNow(makeAgent(committedSession).agent, new AbortController().signal);
		const committedSummary = committedSession.snapshotEvents().find((event) => event.type === "compaction/summary");
		const committedHeader = catalog.encodeCurrentHeader({ ...committedSession.header, cwd: process.cwd(), delegationDepth: 0 }, committedSession.inheritedEventCount);
		const committedText = `${[JSON.stringify(committedHeader), ...committedSession.snapshotEvents().map((event) => JSON.stringify(catalog.encodeCurrentEvent(event)))].join("\n")}\n`;
		const committedDerived = replay.deriveReplayScript(replay.parseSessionLog(committedText));
		const committedChunks = replay.deriveReplayScript([committedSummary])[0].chunks;
		console.log(`  derived shape: ${committedChunks.map((chunk) => chunk.type).join(",")}`);
		ok("a LANDED summary derives block-start/block-end/usage/finish", committedChunks.map((chunk) => chunk.type).join(",") === "block-start,block-end,usage,finish", committedChunks.map((chunk) => chunk.type).join(","));
		/* The two sessions summarised different text, so the VALUES differ by construction; the invariant
		 * that makes the merge a drop-in replacement is the STRUCTURE: same chunk kinds, same field names,
		 * same per-block pairing. */
		const shapeOf = (chunks) => chunks.map((chunk) => `${chunk.type}:[${Object.keys(chunk).sort().join("+")}]`).join(",");
		ok("the sidecar's chunks are structurally identical to a landed summary's", shapeOf(sidecarLines[0].chunks) === shapeOf(committedChunks), `${shapeOf(sidecarLines[0].chunks)} vs ${shapeOf(committedChunks)}`);
		ok("and the block-end payloads carry a real block, like a landed summary's", sidecarLines[0].chunks[1].block.type === "text" && committedChunks[1].block.type === "text");
		ok("a committed attempt writes no trace at all", await readFile(join(dir, "replay-failed-compactions.jsonl"), "utf8").then(() => false, () => true));
	});

	/* ------------------------------------------------- 6c debt rebuild from the log (M4-B) ---- */
	await scenario("6c. the carried-debt ledger rebuilds from the session log (M4-G2)", async () => {
		const catalog = (await import(CATALOG_MODULE)).sessionFormatCatalog;
		const replay = await import(REPLAY_MODULE);
		const carrying = newSession("session-debt-rebuild");
		buildConversation(carrying, { steps: 4 });
		closeTurn(carrying);
		const debtConfig = { enabled: true, auditPath: auditPath("debt-live"), economics: { enabled: true, cacheWriteReadRatio: 3 } };
		const debtHost = await mountHost({ config: debtConfig });
		debtHost.meter.perNode = 12_000;
		await debtHost.engine.compactNow(makeAgent(carrying).agent, new AbortController().signal);
		const liveState = debtHost.engine.debt.pending(carrying);
		const summaryEvent = carrying.snapshotEvents().find((event) => event.type === "compaction/summary");
		console.log(`  charge on the event: ${JSON.stringify(summaryEvent.data.charge)}`);
		ok("the committed summary event carries the charge record", summaryEvent.data.charge?.charged === true);
		ok("the live ledger holds real debt", liveState.carriedDebtTokens > 0, JSON.stringify(liveState));

		/* The strongest available形式 of "the log is enough": re-read the charge record out of the
		 * PERSISTED JSONL via llm-replay's own parser, then feed that back into a fresh ledger. */
		const header = catalog.encodeCurrentHeader({ ...carrying.header, cwd: process.cwd(), delegationDepth: 0 }, carrying.inheritedEventCount);
		const text = `${[JSON.stringify(header), ...carrying.snapshotEvents().map((event) => JSON.stringify(catalog.encodeCurrentEvent(event)))].join("\n")}\n`;
		const fromLog = replay.parseSessionLog(text);
		const restarted = await mountHost({ config: { enabled: true, auditPath: auditPath("debt-restarted"), economics: { enabled: true, cacheWriteReadRatio: 3 } } });
		restarted.meter.perNode = 12_000;
		assert.equal(restarted.engine.debt.pending(carrying).carriedDebtTokens, 0);
		const replayed = restarted.engine.debt.rebuild(carrying, fromLog);
		ok("the log replays exactly one charged compaction", replayed === 1, String(replayed));
		ok("the rebuilt ledger equals the in-memory ledger field for field", JSON.stringify(restarted.engine.debt.pending(carrying)) === JSON.stringify(liveState), `${JSON.stringify(restarted.engine.debt.pending(carrying))} vs ${JSON.stringify(liveState)}`);

		/* The wiring check: a restarted engine must restore BY ITSELF on the first decision that needs the
		 * number — an explicit rebuild() call nobody makes would be dead code. */
		startTurn(carrying, 2);
		openStep(carrying);
		const wired = await mountHost({
			config: { enabled: true, thresholdRatio: 0.01, retainRatio: 0.001, auditPath: auditPath("debt-wired"), economics: { enabled: true, cacheWriteReadRatio: 3 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		wired.meter.perNode = 12_000;
		assert.deepEqual(wired.engine.debt.pending(carrying), { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
		await wired.engine.compactIfNeeded(makeAgent(carrying).agent, "pressure", new AbortController().signal);
		const [wiredLine] = await auditLines(auditPath("debt-wired"));
		console.log(`  restart decided: ${wiredLine.status}/${wiredLine.gate.reason} with carriedDebt ${wiredLine.gate.carriedDebtTokens}`);
		ok("a restarted engine's FIRST decision already carries the log's debt", wiredLine.gate.carriedDebtTokens === liveState.carriedDebtTokens && wiredLine.gate.carriedDebtTokens > 0, `${wiredLine.gate.carriedDebtTokens} vs ${liveState.carriedDebtTokens}`);
	});

	/* ------------------------------------------------------------------- 7 economic gate ------ */
	await scenario("7. the economic gate decides the pressure trigger (M2: veto + real inputs)", async () => {
		const noTodo = newSession("session-gate-veto");
		buildConversation(noTodo, { steps: 3 });
		const vetoHost = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: auditPath("gate-veto"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		vetoHost.meter.perNode = 16_000;
		const eventsBefore = noTodo.snapshotEvents().length;
		const vetoed = await vetoHost.engine.compactIfNeeded(makeAgent(noTodo).agent, "pressure", new AbortController().signal);
		const [vetoLine] = await auditLines(auditPath("gate-veto"));
		console.log(`  gate: ${vetoLine.gate.reason} (compact=${vetoLine.gate.compact}, horizon=${JSON.stringify(vetoLine.gate.completedBoundaryRequestCounts)})`);
		ok("no todo signal means no horizon, and the pressure compaction is refused", vetoed === null && vetoLine.gate.reason === "horizon_unavailable");
		ok("the refusal writes a deferred audit line instead of a transaction", vetoLine.status === "deferred" && vetoLine.shadowedSeqs.length > 0);
		ok("the refusal appends no session event at all", noTodo.snapshotEvents().length === eventsBefore, `${eventsBefore} -> ${noTodo.snapshotEvents().length}`);
		ok("the refusal never pays for a summarization call", vetoHost.llm.calls.length === 0);
		ok("nothing was replaced or archived", noTodo.surface.replaceGeneration === 0 && vetoHost.spill.calls.length === 0);

		const withTodo = newSession("session-gate-allow");
		const plan = (completed) => [
			{ content: "alpha", status: completed ? "completed" : "in_progress" },
			{ content: "beta", status: completed ? "in_progress" : "pending" },
			{ content: "gamma", status: "pending" },
			{ content: "delta", status: "pending" },
			{ content: "epsilon", status: "pending" },
			{ content: "zeta", status: "pending" },
		];
		appendSystem(withTodo);
		appendTodo(withTodo, plan(false));
		for (let index = 0; index < 5; index += 1) {
			appendUser(withTodo, `work ${index}`);
			appendToolStep(withTodo, { callId: `call-${index}` });
			if (index === 0) appendTodo(withTodo, plan(true));
		}
		appendUser(withTodo, "final tail");
		const allowHost = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: auditPath("gate-allow"), economics: { enabled: true, cacheWriteReadRatio: 2 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		allowHost.meter.perNode = 10_000;
		const allowed = await allowHost.engine.compactIfNeeded(makeAgent(withTodo).agent, "pressure", new AbortController().signal);
		const [allowLine] = await auditLines(auditPath("gate-allow"));
		console.log(`  gate: ${allowLine.gate.reason}; horizon input ${JSON.stringify(allowLine.gate.completedBoundaryRequestCounts)} / ${allowLine.gate.remainingBoundaries} open; breakeven ${allowLine.gate.breakevenRequests?.toFixed(2)}`);
		ok("a todo boundary opens a horizon and the compaction runs", allowed !== null && allowLine.status === "committed");
		ok("the gate inputs are the tracker's real observations", JSON.stringify(allowLine.gate.completedBoundaryRequestCounts) === "[1]" && allowLine.gate.remainingBoundaries === 5 && allowLine.gate.expectedRemainingRequests === 6);
		ok("the sub-sequence HINT aligned the cut to the plan boundary", allowLine.todoHint?.used === true && allowLine.shadowedRange.end === allowLine.todoHint.alignedEnd);
		ok("priorCompactionCount comes from the durable log", allowLine.gate.priorCompactionCount === 0);
		const carried = await allowHost.engine.debt.pending(withTodo);
		const saving = allowLine.gate.archiveTokens - allowLine.gate.memoTokens;
		console.log(`  debt: ${allowLine.gate.writeTokens} written tokens at ratio 2 -> ${carried.carriedDebtTokens} carried, ${carried.cacheDebtRepaymentTokens} retired this step`);
		ok("the committed compaction's cache-write becomes carried debt", carried.carriedDebtTokens + carried.cacheDebtRepaymentTokens === allowLine.gate.writeTokens, JSON.stringify(carried));
		ok("one step retires exactly the compaction's per-step saving", carried.cacheDebtRepaymentTokens === saving, `${carried.cacheDebtRepaymentTokens} vs ${saving}`);

		const overflow = newSession("session-gate-overflow");
		buildConversation(overflow, { steps: 3 });
		const overflowHost = await mountHost({
			config: { enabled: true, maxOverflowRetries: 1, auditPath: auditPath("gate-overflow"), economics: { enabled: true, cacheWriteReadRatio: 1 } },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 200_000 }),
		});
		overflowHost.meter.perNode = 16_000;
		const agent = makeAgent(overflow).agent;
		const outcome = await overflowHost.ctx.waterfall("agent/request-error", { agent, turn: 1, step: 1, provider: "mock-provider", failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, retryPolicy: undefined, signal: new AbortController().signal }, async () => "next");
		const [overflowLine] = await auditLines(auditPath("gate-overflow"));
		ok("the gate's 'no' has no authority over overflow recovery", JSON.stringify(outcome) === JSON.stringify({ kind: "retry" }) && overflow.surface.replaceGeneration === 1);
		ok("and the refusal verdict is still recorded verbatim", overflowLine.status === "committed" && overflowLine.gate.compact === false && overflowLine.gate.reason === "horizon_unavailable");
	});

	/* ------------------------------------------------- 8 failed-selection backoff (M4-D) --------- */
	await scenario("8. a failed selection is not paid for twice (M4-D)", async () => {
		const session = newSession("session-backoff");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, auditPath: auditPath("backoff") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 25_000, summaryText: "x".repeat(400_000) }),
		});
		host.meter.perNode = 5_000;
		const agent = makeAgent(session).agent;
		await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal).catch((error) => {
			console.log(`  first attempt rejected at stage: ${error.message.slice(0, 60)}...`);
		});
		const [failed] = await auditLines(auditPath("backoff"));
		ok("the first attempt paid for one summarizer call and was rejected", host.llm.calls.length === 1 && failed.status === "failed" && failed.stage === "summary", `calls=${host.llm.calls.length} status=${failed.status}/${failed.stage}`);

		const surfaceBefore = [...session.surface.nodes];
		const second = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		const skipped = (await auditLines(auditPath("backoff")))[1];
		console.log(`  second decision: ${skipped.status}/${skipped.reason} over ${skipped.shadowedRange.start}-${skipped.shadowedRange.end}`);
		ok("the identical selection is deferred, not re-attempted", second === null && skipped.status === "deferred" && skipped.reason === "failed_region_backoff");
		ok("the deferral buys zero summarizer calls", host.llm.calls.length === 1, `calls=${host.llm.calls.length}`);
		ok("the deferral archives nothing a second time", host.spill.calls.length === 1, `archives=${host.spill.calls.length}`);
		ok("the deferral appends no session event and moves no surface", JSON.stringify([...session.surface.nodes]) === JSON.stringify(surfaceBefore) && session.snapshotEvents().filter((event) => event.type === "compaction/start").length === 1);
		ok("the skipped span is exactly the one that failed", JSON.stringify(skipped.shadowedRange) === JSON.stringify(failed.shadowedRange));
		ok("the line names the key it matched and the whole rule that releases it", JSON.stringify(skipped.backoff) === JSON.stringify({ ...failed.shadowedRange, totalTokens: 55_000, margin: 0.1, growthCapTokens: 4_096 }), JSON.stringify(skipped.backoff));

		host.meter.perNode = 5_600; /* +12%: past the declared margin */
		host.llm.summaryText = "## compacted";
		const released = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		const releasedLines = await auditLines(auditPath("backoff"));
		console.log(`  after +12% surface growth: ${releasedLines.at(-1).status}`);
		ok("a grown surface releases the same span and the retry commits", released !== null && releasedLines.at(-1).status === "committed" && session.surface.replaceGeneration === 1);
		ok("the release costs exactly one more summarizer call", host.llm.calls.length === 2, `calls=${host.llm.calls.length}`);
	});

	/* ------------------------------------------------- 8b dual release threshold (M4-D) ------------ */
	await scenario("8b. the release threshold is min(10%, 4096 tokens) (M4-D revision)", async () => {
		/* A real LARGE surface: 11 surface nodes at 5_000 = 55_000 tokens against a 36_000 trigger,
		 * with a 6-node retained tail so the selected span is identical across the decisions. */
		const { isBackedOff, failedRangeKey, FAILED_RANGE_GROWTH_CAP_TOKENS } = await import("../lib/engine.js");
		const large = failedRangeKey({ start: 287, end: 287 }, 1_000_000);
		ok("the declared absolute cap is 4096 tokens", FAILED_RANGE_GROWTH_CAP_TOKENS === 4_096);
		ok("below the cap: +4_095 at a 1M surface is still withheld", isBackedOff(large, { start: 287, end: 287 }, 1_004_095) === true);
		ok("at the cap: +4_096 at a 1M surface releases (the old rule demanded +100_000)", isBackedOff(large, { start: 287, end: 287 }, 1_004_096) === false);
		const small = failedRangeKey({ start: 287, end: 287 }, 28_003);
		ok("small surfaces keep the proportional boundary exactly", isBackedOff(small, { start: 287, end: 287 }, 30_803) === true && isBackedOff(small, { start: 287, end: 287 }, 30_804) === false);

		const session = newSession("session-backoff-cap");
		buildConversation(session, { steps: 3 });
		const host = await mountHost({
			config: { enabled: true, compactionRetries: 0, thresholdRatio: 0.9, retainRatio: 0.5, auditPath: auditPath("backoff-cap") },
			llmFactory: (ctx) => new FakeLlm(ctx, { contextWindow: 40_000, summaryText: "x".repeat(200_000) }),
		});
		host.meter.perNode = 5_000;
		const agent = makeAgent(session).agent;
		await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal).catch(() => void 0);
		ok("the large-surface attempt paid for one summarizer call and failed at stage summary", host.llm.calls.length === 1 && (await auditLines(auditPath("backoff-cap")))[0].stage === "summary");

		const unchanged = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		ok("the byte-identical large surface is withheld with zero new calls", unchanged === null && host.llm.calls.length === 1);
		const shown = (await auditLines(auditPath("backoff-cap")))[1].backoff;
		ok("the withheld line publishes the cap it will be released by", shown.growthCapTokens === 4_096 && shown.margin === 0.1, JSON.stringify(shown));

		/* +8% on the surface price: 4_400 tokens of new content, past the 4_096 cap but short of the
		 * 5_500 the proportion alone would have demanded. */
		host.meter.perNode = 5_400;
		host.llm.summaryText = "## compacted";
		const released = await host.engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
		const lines = await auditLines(auditPath("backoff-cap"));
		console.log(`  +8% (4_400 tokens) released the cap-bound span: ${lines.at(-1).status}`);
		ok("growth past the absolute cap releases a byte-identical span the proportion would still withhold", released !== null && lines.at(-1).status === "committed" && session.surface.replaceGeneration === 1);
		ok("and the release costs exactly one more summarizer call", host.llm.calls.length === 2, `calls=${host.llm.calls.length}`);
	});
} finally {
	console.log("");
	console.log(`checks: ${checks}, failures: ${failures}`);
	await cleanupTempDirs();
}

if (failures > 0) {
	console.error(`functional verification FAILED (${failures}/${checks})`);
	process.exit(1);
}
console.log("functional verification PASSED");
