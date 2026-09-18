/**
 * Shared doubles and fixtures for the dsh-context-compact suite.
 *
 * The suite runs against a REAL detached `Session` (`Session.create`) and a REAL cordis
 * `Context`: the surface fold, the `surfaceOp {op:"replace"}` atomic replacement, tool-pairing
 * balance, and the `compaction/*` event brackets are all host behavior this plugin must respect,
 * and a hand-rolled session double would test the double instead. Only the LLM call is mocked
 * (zero API calls, per the M1 rules): `FakeLlm` yields a deterministic `StreamChunk` sequence.
 *
 * Every test builds its own `mkdtemp` root for audit files, registered here for teardown, and the
 * suite asserts that the developer's real host audit file is never touched.
 *
 * @module @sol-pi-port/dsh-context-compact/test/helpers
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import * as plugin from "../lib/index.js";
import { defaultAuditPath } from "../lib/audit.js";

/** Directories created by tests; removed by `cleanupTempDirs()`. */
const tempDirs = [];

/**
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
export async function tempDir(prefix = "dsh-context-compact-test-") {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Remove every directory this suite created. */
export async function cleanupTempDirs() {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** The host-wide DEFAULT audit file — outside every test temp directory. */
export function hostAuditPath() {
	return defaultAuditPath();
}

/**
 * Content and metadata snapshot of one file, for a before/after equality check.
 * @param {string} path
 * @returns {Promise<{ exists: boolean, sha256?: string, bytes?: number, mtimeMs?: number }>}
 */
export async function snapshotFile(path) {
	try {
		const buffer = await readFile(path);
		const stats = await stat(path);
		return { exists: true, sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length, mtimeMs: stats.mtimeMs };
	} catch {
		return { exists: false };
	}
}

/** A logger that records instead of printing. */
export function silentLogger() {
	const warnings = [];
	const infos = [];
	return {
		warnings,
		infos,
		warn: (message) => warnings.push(message),
		info: (message) => infos.push(message),
	};
}

/** A deterministic mock summarizer: one text block, one usage chunk, one stop finish. */
export class FakeLlm extends Service {
	/**
	 * @param {object} ctx
	 * @param {{ contextWindow?: number|null, summaryText?: string, usage?: object, finish?: object, failWith?: string }} [options]
	 */
	constructor(ctx, options = {}) {
		super(ctx, "llm");
		this.contextWindow = options.contextWindow === undefined ? 100_000 : options.contextWindow;
		this.summaryText = options.summaryText ?? "## Primary Request and Intent\n- compacted region (unit test)";
		this.usage = options.usage ?? { inputTokens: 111, cacheReadTokens: 222, cacheWriteTokens: 333, outputTokens: 44 };
		this.finish = options.finish ?? { kind: "stop" };
		this.failWith = options.failWith;
		/** Every `stream()` envelope this double received, in order. */
		this.calls = [];
		this.resolveCalls = 0;
	}

	async resolveModelInfo(provider, model) {
		this.resolveCalls += 1;
		return {
			provider,
			id: model,
			name: model,
			...(this.contextWindow === null ? {} : { context: { contextWindow: this.contextWindow } }),
		};
	}

	async *stream(options) {
		this.calls.push(options);
		if (this.failWith !== undefined) throw new Error(this.failWith);
		const text = this.summaryText;
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "text-delta", index: 0, text };
		yield { type: "block-end", index: 0, block: { type: "text", text } };
		yield { type: "usage", usage: this.usage };
		yield { type: "finish", reason: this.finish };
	}
}

/**
 * A token meter over the real surface: every node costs the same configured price, so a test can
 * move pressure by moving `perNode` or by appending nodes.
 */
export class FakeTokenMeter extends Service {
	/**
	 * @param {object} ctx
	 * @param {{ perNode?: number, charsetDivisor?: number }} [options]
	 */
	constructor(ctx, options = {}) {
		super(ctx, "tokenMeter");
		this.perNode = options.perNode ?? 500;
		this.measureCalls = 0;
		this.estimateCalls = 0;
	}

	measure(session) {
		this.measureCalls += 1;
		const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: this.perNode, heuristicTokens: this.perNode }));
		const surfaceTokens = this.perNode * nodes.length;
		return {
			logRevision: session.seq,
			baseline: { kind: "none", tokens: 0 },
			surfaceDeltaTokens: 0,
			totalTokens: surfaceTokens,
			surfaceTokens,
			nodes,
		};
	}

	estimateMessage(message) {
		this.estimateCalls += 1;
		const leaves = [];
		const collect = (value) => {
			if (typeof value === "string") leaves.push(value);
			else if (Array.isArray(value)) for (const item of value) collect(item);
			else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collect(item);
		};
		collect(message.content);
		return Math.ceil(leaves.join("").length / 4) + 8;
	}
}

/** A spill backend double that records every `saveText` request (and can be made to fail). */
export class FakeSpillStore extends Service {
	/**
	 * @param {object} ctx
	 * @param {{ fail?: boolean }} [options]
	 */
	constructor(ctx, options = {}) {
		super(ctx, "spillStore");
		this.calls = [];
		this.fail = options.fail ?? false;
	}

	async saveText(input) {
		this.calls.push(input);
		if (this.fail) throw new Error("unit-test spill backend refused the write");
		return {
			locator: `spill://unit/${this.calls.length}/${input.suggestedName}`,
			bytes: Buffer.byteLength(input.content, "utf8"),
			retrievalHint: "Unit-test spill artifact; read it with read/grep.",
		};
	}
}

/** A session-store double: only `flush` is used by the manual path. */
export class FakeSessions extends Service {
	constructor(ctx) {
		super(ctx, "sessions");
		this.flushes = [];
	}

	async flush(session) {
		this.flushes.push(session);
		return true;
	}
}

/** A tool-result-pruner double: it must be called explicitly, so tests observe the call. */
export class FakePruner extends Service {
	/**
	 * @param {object} ctx
	 * @param {{ onPrune?: (session: object) => void }} [options]
	 */
	constructor(ctx, options = {}) {
		super(ctx, "toolResultPruner");
		this.sessions = [];
		this.observedSessionIds = [];
		this.onPrune = options.onPrune;
	}

	pruneSession(session) {
		this.sessions.push(session);
		this.observedSessionIds.push(String(session.id));
		this.onPrune?.(session);
		return { landed: [], savedContentCodePoints: 0 };
	}
}

/**
 * A settings-provider double: records the registration and merges one user layer over the
 * composition entry, which is the layer order the real provider implements.
 */
export class FakeSettings extends Service {
	constructor(ctx, { layer = {} } = {}) {
		super(ctx, "settings");
		this.registrations = [];
		this.layer = layer;
	}

	register(ns, schema, options = {}) {
		this.registrations.push({ ns, schema, options });
		const read = () => ({ ...(options.base ?? {}), ...this.layer });
		return { get: read, ns, schema };
	}
}

let messageCounter = 0;

/**
 * Per-session step cursor. The real loop brackets every model call in `step/start`…`step/end`, and
 * the released session envelope validates that a `system/message` belongs to an open step — so the
 * fixture must carry the same brackets to be a loadable recorded session.
 */
const stepState = new WeakMap();

/**
 * @param {object} session
 * @returns {number} the step number just opened
 */
export function openStep(session) {
	const state = stepState.get(session) ?? { turn: 1, step: 0, open: false };
	state.step += 1;
	state.open = true;
	stepState.set(session, state);
	session.append("step/start", { turn: state.turn, step: state.step });
	return state.step;
}

/**
 * @param {object} session
 * @returns {number} the step just closed
 */
export function closeStep(session) {
	const state = stepState.get(session);
	if (state === undefined || !state.open) return state?.step ?? 0;
	session.append("step/end", { turn: state.turn, step: state.step });
	state.open = false;
	return state.step;
}

/**
 * @param {object} session
 * @returns {{ turn: number, step: number, open: boolean }}
 */
function stepOf(session) {
	const state = stepState.get(session);
	if (state === undefined) throw new Error("fixture error: session was not created by newSession()");
	return state;
}

/** A real detached session with an open turn, an open step, a system head, and a request header. */
export function newSession(id = "session-unit", { openTurn = true, provider = "mock-provider", model = "mock-model-1", tools } = {}) {
	messageCounter = 0;
	const session = Session.create(SessionId(id));
	stepState.set(session, { turn: 1, step: 0, open: false });
	session.append("turn/start", { turn: 1 });
	openStep(session);
	session.append("request/header", {
		header: {
			config: { provider, model },
			...(tools === undefined ? {} : { tools }),
		},
		reason: "initial",
	});
	return session;
}

/** Append the system prompt that owns surface node 0. */
export function appendSystem(session, text = "system prompt for the unit test") {
	const state = stepOf(session);
	return session.append("system/message", { turn: state.turn, step: state.step, message: createSystemMessage(text, "test-harness") }, { surfaceOp: "append" });
}

/**
 * Append one whole-list todo snapshot, the durable shape `todo_write` produces.
 *
 * The host's own invariant allows `todo/write` only inside an open turn, and every session built by
 * `newSession()` has turn 1 open, so this is the same append the real tool performs.
 *
 * @param {object} session
 * @param {{ content: string, status: string }[]} todos the complete replacement list
 * @returns {object} the appended event
 */
export function appendTodo(session, todos) {
	return session.append("todo/write", { todos });
}

/** Open one further durable turn (the host's own projection clears the plan on this event). */
export function startTurn(session, turn) {
	return session.append("turn/start", { turn });
}

/** Append one plain user message. */
export function appendUser(session, text) {
	messageCounter += 1;
	return session.append("user/message", createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }), { surfaceOp: "append" });
}

/** Append one completed assistant step: a tool-call message plus its paired result, then a new step. */
export function appendToolStep(session, { callId, name = "read", args = "{}", result = "tool output" } = {}) {
	const state = stepOf(session);
	messageCounter += 1;
	const assistant = session.append("assistant/message", {
		turn: state.turn,
		step: state.step,
		message: {
			id: `assistant-${messageCounter}`,
			role: "assistant",
			content: [{ type: "tool-call", id: callId, name, arguments: args }],
			source: { kind: "model", provider: "mock-provider", model: "mock-model-1" },
		},
		stream: [],
	}, { surfaceOp: "append" });
	/* The loop logs the dispatched call before its result; the released envelope validates that
	 * relationship, so the fixture carries it. */
	session.append("tool/call", { turn: state.turn, step: state.step, callId, name, arguments: args });
	messageCounter += 1;
	const toolResult = session.append("tool/result", {
		turn: state.turn,
		step: state.step,
		message: createToolResultMessage({ callId, content: [{ type: "text", text: result }], isError: false }),
	}, { surfaceOp: "append", sourceEventSeqs: [assistant.seq] });
	closeStep(session);
	openStep(session);
	return { assistant, toolResult };
}

/** Append one final text assistant message. */
export function appendAssistantText(session, text) {
	const state = stepOf(session);
	messageCounter += 1;
	return session.append("assistant/message", {
		turn: state.turn,
		step: state.step,
		message: {
			id: `assistant-${messageCounter}`,
			role: "assistant",
			content: [{ type: "text", text }],
			source: { kind: "model", provider: "mock-provider", model: "mock-model-1" },
		},
		stream: [],
	}, { surfaceOp: "append" });
}

/** Close the open step and turn 1 (manual compaction requires no open turn). */
export function closeTurn(session, turn = 1) {
	closeStep(session);
	return session.append("turn/end", { turn, reason: { kind: "done" } });
}

/**
 * A conversation with a system head and `steps` balanced tool-call/result pairs, then a recent
 * user tail. Returns the surface node seqs of one tool step so a test can compact a known span.
 */
export function buildConversation(session, { steps = 3, tail = true } = {}) {
	appendSystem(session);
	const stepSeqs = [];
	for (let index = 0; index < steps; index += 1) {
		appendUser(session, `read node ${index} and report`);
		const { assistant, toolResult } = appendToolStep(session, { callId: `call-${index}`, result: `tool output ${index}` });
		stepSeqs.push({ assistant: assistant.seq, toolResult: toolResult.seq });
	}
	if (tail) appendUser(session, "now summarize what you did");
	return { stepSeqs };
}

/** An agent double: `runMaintenance` runs the task inline with an abort signal. */
export function makeAgent(session, { provider = "mock-provider", model = "mock-model-1", maintenanceThrows = undefined } = {}) {
	const maintenanceCalls = [];
	return {
		agent: {
			session,
			options: { provider, model },
			/* Deliberately NOT `async`: the host's `runMaintenance` rejects SYNCHRONOUSLY for a
			 * non-idle agent, and `compactNow` must classify only that rejection as `busy`. */
			runMaintenance: (task) => {
				if (maintenanceThrows !== undefined) throw maintenanceThrows;
				const controller = new AbortController();
				maintenanceCalls.push(controller);
				return task(controller.signal);
			},
		},
		maintenanceCalls,
	};
}

/**
 * Boot a real cordis Context with the given doubles and mount the plugin through the real
 * `ctx.plugin` path (never a manual constructor call).
 *
 * @param {{ config?: object, llm?: FakeLlm, meter?: FakeTokenMeter, spill?: FakeSpillStore|null, pruner?: FakePruner|null, sessions?: FakeSessions, logger?: object }} [options]
 * @returns {Promise<object>} the mounted host
 */
export async function mountHost(options = {}) {
	const ctx = new Context();
	/* The host logger is replaced by a recorder before the plugin mounts, so a test can assert the
	 * exact diagnostics and the suite stays quiet. */
	const logger = silentLogger();
	Object.defineProperty(ctx, "logger", { value: logger, configurable: true, writable: true });
	const llm = options.llm ?? options.llmFactory?.(ctx) ?? new FakeLlm(ctx);
	const meter = options.meter ?? new FakeTokenMeter(ctx);
	const sessions = options.sessions ?? new FakeSessions(ctx);
	const settings = options.settings ?? (options.settingsLayer === undefined ? undefined : new FakeSettings(ctx, { layer: options.settingsLayer }));
	const spill = options.spill === null ? undefined : options.spill ?? new FakeSpillStore(ctx, options.spillOptions);
	const pruner = options.pruner === null ? undefined : options.pruner ?? new FakePruner(ctx, options.prunerOptions);
	const fiber = ctx.plugin(plugin, options.config ?? {});
	await fiber;
	return { ctx, fiber, logger, llm, meter, sessions, settings, spill, pruner, engine: ctx.get("compaction") };
}