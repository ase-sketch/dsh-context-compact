/**
 * `@sol-pi-port/dsh-context-compact`: a fresh `ctx.compaction` implementation for DeepSeek Harness.
 *
 * The plugin is an apply-function module that mounts one `CompactionEngine` service, so loading it
 * REPLACES `compaction-basic` on this context (one implementation per context — a second one throws
 * rather than silently winning, docs/phase4-plan.md §0 C1). Consumers such as
 * `@deepseek-ai/dsh-command-compact` only ever call `ctx.compaction.compactNow`, so the swap needs no
 * change on their side. `compaction-basic` must be disabled in the profile patch, exactly like the
 * `spill-local`/`spill-cas` pairing of the ObservationPack phase.
 *
 * Named exports ONLY: the loader resolves `exports.default ?? exports`, so a default export would
 * hand it a bare `apply` and silently drop the module namespace (DSH postmortem 0001).
 *
 * DISABLED BY DEFAULT, and "disabled" is a structural fact, not a runtime hope: with
 * `efficiency-context-compact.enabled = false` the engine registers NO automatic listener at all and
 * `compactIfNeeded` returns `null` before it touches the session. `compactNow` (the human
 * `/compact`) stays available, because removing that capability would be a regression of the backend
 * it replaces rather than a mechanism being off.
 *
 * @module @sol-pi-port/dsh-context-compact
 */
import { CompactionEngine, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { archiveShadowedRegion } from "./archive.js";
import { createAuditSink, defaultAuditPath } from "./audit.js";
import { createFailedCompactionSink, failedCompactionSidecarPath } from "./sidecar.js";
import { CompactionDebtLedger } from "./economics.js";
import {
	FAILED_RANGE_BACKOFF_REASON,
	FAILED_RANGE_GROWTH_CAP_TOKENS,
	FAILED_RANGE_GROWTH_MARGIN,
	TargetPressureConfigError,
	assertNoActiveCompaction,
	compactSurfaceRegion,
	countCommittedCompactions,
	failedRangeKey,
	gateRecord,
	isBackedOff,
	recordDeferred,
	registerAutomaticCompaction,
	routedTarget,
} from "./engine.js";
import { alignRangeToHint, selectCompactableRange } from "./selectors.js";
import { createPolicySource } from "./settings.js";
import { SUMMARIZER_PLUGIN, frameSummary, summarizeWithLlm } from "./summarize.js";
import { TodoTracker } from "./todo-tracker.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "context-compact";

/**
 * The services the LOADER must resolve for this plugin's fiber.
 *
 * This is the module-namespace declaration cordis actually reads: `ctx.plugin(pluginModule, config)`
 * resolves dependencies with `Inject.resolve(plugin.inject)` (cordis/lib/index.js), so a
 * module-level export is the only spelling that reaches the plugin fiber. It must stay in step with
 * {@link ContextCompactEngine.inject}, which declares the same set for the direct-construction path
 * (`new ContextCompactEngine(ctx)`) — the two are different contracts and both are required.
 *
 * Omitting this export is a silent-failure trap: the fiber's inject map stays empty, every
 * `ctx.tokenMeter` read inside the engine throws `cannot get property "tokenMeter" without inject`,
 * and `registerAutomaticCompaction` swallows that throw — so the mechanism quietly does nothing
 * while the whole test suite stays green. Phase 4 M3 hit exactly this in a real recording; the guard
 * is test/composition.test.js and the postmortem is
 * eval/compact-arms/m3-zero-trigger-diagnosis.md.
 */
export const inject = ["llm", "tokenMeter", "sessions"];

/**
 * The compaction backend: three engine methods over one durable transaction.
 *
 * `summarize()` is the sole customization hook; the replay and durable mutation strategy stays
 * fixed so every pricing decision uses the singleton token meter.
 */
export class ContextCompactEngine extends CompactionEngine {
	static inject = ["llm", "tokenMeter", "sessions"];

	/**
	 * @param {object} ctx owning cordis context
	 * @param {{ policySource: { read: () => object }, logger?: { warn: Function, info?: Function } }} options
	 */
	constructor(ctx, { policySource, logger } = {}) {
		super(ctx);
		this.policySource = policySource;
		this.logger = logger ?? { warn: () => {}, info: () => {} };
		this.sinks = new Map();
		/* Failed-attempt replay traces are cached per path exactly like audit sinks. */
		this.traceSinks = new Map();
		/* The todo fold and the carried-debt ledger are pure bookkeeping: they hold no listener and
		 * touch no session until the mechanism is enabled (see the block below). */
		this.todoTracker = new TodoTracker({ logger: this.logger });
		this.debt = new CompactionDebtLedger();
		/* Sessions whose ledger has already been restored from the log this process can see (M4-B). */
		this.restoredDebtSessions = new WeakSet();
		/* M4-D: per-session memory of the last selection whose summarization was PAID FOR and rejected.
		 * Session-scoped and in-memory on purpose: it exists to stop this process from buying the same
		 * rejection twice within one conversation, and a restarted process is entitled to one fresh
		 * attempt. It is a WeakMap so an ended session's entry is collected with it. */
		this.failedSelections = new WeakMap();
		/* The automatic listeners exist only when the mechanism is enabled at LOAD time — the
		 * zero-side-effect claim of "off" must not depend on each handler's early return. */
		if (this.policySource.read().enabled) {
			registerAutomaticCompaction(this);
			this.logger.info?.("context-compact: automatic pressure and overflow recovery are ENABLED");
		}
	}

	/**
	 * The audit sink for the currently configured path. Sinks are cached per path so a live
	 * `auditPath` change starts a new file instead of silently writing to the old one.
	 * @returns {{ record: (event: object) => void, flush: () => Promise<void>, path: string }}
	 */
	auditFor() {
		const path = this.policySource.read().auditPath ?? defaultAuditPath();
		let sink = this.sinks.get(path);
		if (sink === undefined) {
			sink = createAuditSink({ path, logger: this.logger });
			this.sinks.set(path, sink);
		}
		return sink;
	}

	/**
	 * The failed-attempt trace sink beside the currently configured audit file (M4-A).
	 *
	 * Cached per path for the same reason the audit sink is: a live `auditPath` change must start a new
	 * sidecar rather than silently appending to the old run's evidence. The sink is created lazily, so a
	 * run that never fails a compaction never opens the file.
	 *
	 * @returns {{ record: (event: object) => Promise<void>, flush: () => Promise<void>, path: string }}
	 */
	failedTraceFor() {
		const auditPath = this.policySource.read().auditPath ?? defaultAuditPath();
		const path = failedCompactionSidecarPath(auditPath);
		let sink = this.traceSinks.get(path);
		if (sink === undefined) {
			sink = createFailedCompactionSink({ path, logger: this.logger });
			this.traceSinks.set(path, sink);
		}
		return sink;
	}

	/** Wait for every queued audit line and failed-attempt trace. Never rejects. */
	flushAudit() {
		return Promise.all([...this.sinks.values(), ...this.traceSinks.values()].map((sink) => sink.flush().catch(() => undefined)));
	}

	/**
	 * Consider automatic compaction for one explicit trigger.
	 * @param {{ session: object, options: object }} agent
	 * @param {"pressure"|"context-overflow"} trigger
	 * @param {AbortSignal} signal
	 * @returns {Promise<object|null>}
	 */
	async compactIfNeeded(agent, trigger, signal) {
		const policy = this.policySource.read();
		/* Shape A: disabled means no automatic work at all — not even a measurement. */
		if (!policy.enabled) return null;
		const target = routedTarget(agent.session);
		if (target === undefined) return null;
		const meter = this.ctx.tokenMeter;
		let measurement = meter.measure(agent.session);
		const prune = this.ctx.get("toolResultPruner");
		if (trigger === "context-overflow") {
			if (prune !== undefined) {
				prune.pruneSession(agent.session);
				measurement = meter.measure(agent.session);
			}
			const range = selectCompactableRange(agent.session, measurement, 0);
			if (range === null) return null;
			/* D1: overflow recovery is a correctness obligation, so the gate is EVALUATED and RECORDED
			 * here but can never veto — the reduction runs, and its verdict is visible in the audit. */
			const gate = gateRecord(policy, measurement, measuredSeqs(measurement, range.start, range.end), { contextWindow: null }, this._framedMemoTokens(), {
				priorCompactionCount: countCommittedCompactions(agent.session),
				...this._debtPending(agent.session),
				remainingBoundaries: null,
				completedBoundaryRequestCounts: null,
			});
			const outcome = await this._compact(agent.session, range.start, range.end, agent, signal, {
				owner: "current-turn",
				stability: "whole-surface",
				trigger,
				archiveEnabled: policy.archive,
				gate,
			});
			this._chargeDebt(agent.session, gate, policy);
			return outcome;
		}
		const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
		assertNoActiveCompaction(agent.session, "automatic pressure compaction");
		const targetKey = `${target.provider}/${target.model}`;
		if (context === undefined) {
			throw new TargetPressureConfigError(targetKey, `context-compact: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
		}
		const thresholdTokens = Math.floor(context.contextWindow * policy.thresholdRatio);
		if (measurement.totalTokens < thresholdTokens) return null;
		if (prune !== undefined) {
			prune.pruneSession(agent.session);
			measurement = meter.measure(agent.session);
		}
		if (measurement.totalTokens < thresholdTokens) return null;
		const retainTokens = Math.floor(context.contextWindow * policy.retainRatio);
		let result = null;
		for (let attempt = 0; attempt <= policy.compactionRetries; attempt += 1) {
			const evaluation = this._evaluate(agent.session, policy, measurement, retainTokens, context.contextWindow ?? null);
			if (evaluation.range === null) {
				if (result === null) return null;
				break;
			}
			if (this._backedOff(agent.session, evaluation.range, measurement.totalTokens)) {
				/* M4-D: this exact selection was already paid for and rejected, and the surface has not
				 * moved enough to make the retry a different attempt. Skipping is the whole point: the
				 * recording shows 16 rejected summarizer calls, several on a byte-identical span. */
				const deferred = await this._recordBackoff(agent.session, policy, evaluation, measurement.totalTokens, trigger);
				this.logger.info?.(`context-compact: pressure compaction deferred (${deferred.reason}) for the failed selection ${deferred.shadowedRange.start}-${deferred.shadowedRange.end}; no session event was appended and nothing was replaced`);
				return result;
			}
			if (evaluation.veto) {
				/* D2: a refusal appends NO session event and never throws — it reports the refusal in the
				 * audit line and the log. A compaction that already committed in an earlier attempt of
				 * this same call is still reported as this call's result. */
				const deferred = await recordDeferred(
					{ audit: this.auditFor(), logger: this.logger },
					agent.session,
					{ start: evaluation.range.start, end: evaluation.range.end, shadowedSeqs: evaluation.shadowedSeqs },
					evaluation.gate,
					evaluation.todoHint,
					trigger,
				);
				this.logger.info?.(`context-compact: pressure compaction deferred (${deferred.reason}); no session event was appended and nothing was replaced`);
				return result;
			}
			result = await this._compact(agent.session, evaluation.range.start, evaluation.range.end, agent, signal, {
				owner: "current-turn",
				stability: "whole-surface",
				trigger,
				archiveEnabled: policy.archive,
				gate: evaluation.gate,
				...(evaluation.todoHint === null ? {} : { todoHint: evaluation.todoHint }),
			});
			/* The surface just moved: the standing todo hints are stale by construction, and the call
			 * that caused it has now been paid for (D3: the debt is charged for EVERY committed path). */
			this.todoTracker.commit(agent.session);
			this._chargeDebt(agent.session, evaluation.gate, policy);
			measurement = meter.measure(agent.session);
			if (measurement.totalTokens < thresholdTokens) return result;
		}
		throw new Error(`compaction still above threshold after ${policy.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${thresholdTokens})`);
	}

	/**
	 * Choose and price one pressure attempt, and decide whether the economic gate allows it.
	 *
	 * Selection is pairing-first; the todo signal may only NARROW an already-authorized range (D6), and
	 * a range that no todo candidate can be aligned to is exactly what `selectCompactableRange`
	 * returned, byte-for-byte.
	 *
	 * @param {object} session
	 * @param {object} policy resolved policy
	 * @param {object} measurement meter measurement taken just before this attempt
	 * @param {number} retainTokens verbatim tail budget
	 * @param {number|null} contextWindow routed model context window
	 * @returns {{ range: object|null, gate?: object, todoHint?: object|null, veto?: boolean }}
	 */
	_evaluate(session, policy, measurement, retainTokens, contextWindow) {
		const selected = selectCompactableRange(session, measurement, retainTokens);
		if (selected === null) return { range: null };
		const todo = this.todoTracker.observe(session);
		const candidate = todo.candidates.at(-1) ?? null;
		const range = alignRangeToHint(session, selected, candidate === null ? null : candidate.endSeq);
		const shadowedSeqs = measuredSeqs(measurement, range.start, range.end);
		const gate = gateRecord(policy, measurement, shadowedSeqs, { contextWindow }, this._framedMemoTokens(), {
			priorCompactionCount: countCommittedCompactions(session),
			...this._debtPending(session),
			remainingBoundaries: todo.remainingBoundaries,
			completedBoundaryRequestCounts: todo.completedBoundaryRequestCounts,
		});
		const todoHint = candidate === null
			? null
			: {
					used: range.end !== selected.end,
					content: candidate.content,
					todoSeq: candidate.todoSeq,
					endSeq: candidate.endSeq,
					selectedEnd: selected.end,
					alignedEnd: range.end,
				};
		return {
			range,
			shadowedSeqs,
			gate,
			todoHint,
			veto: policy.economics.enabled && gate.evaluated === true && gate.compact !== true,
		};
	}

	/**
	 * The session's carried-debt projection, restored from its durable log on first use (M4-B).
	 *
	 * The ledger itself is an in-memory WeakMap, so a restarted process would otherwise evaluate every
	 * session at zero debt while the audit line still showed what the original process carried. Every
	 * committed, charged compaction therefore records what it charged on its `compaction/summary` event,
	 * and this accessor consults that log exactly once per session, BEFORE the first decision that needs
	 * the number.
	 *
	 * Laziness is the whole point: a session the engine just created has nothing to restore, and a live
	 * session that has already charged keeps its state untouched (the WeakSet short-circuits), so the
	 * within-process behavior stays byte-for-byte what M2 did.
	 *
	 * @param {object} session
	 * @returns {{ carriedDebtTokens: number, cacheDebtRepaymentTokens: number }}
	 */
	_debtPending(session) {
		if (!this.restoredDebtSessions.has(session)) {
			this.restoredDebtSessions.add(session);
			const events = session.snapshotEvents();
			const replayed = this.debt.rebuild(session, events);
			if (replayed > 0) {
				this.logger.info?.(`context-compact: restored ${replayed} charged compaction(s) of carried cache-write debt from the session log`);
			}
		}
		return this.debt.pending(session);
	}

	/**
	 * Charge one committed compaction's cache-write cost to the session's debt ledger (D3).
	 *
	 * Called on every path that actually rewrote the prefix — pressure, overflow recovery, /compact and
	 * a forced region — because the cache-write is paid regardless of what triggered it, and a later
	 * pressure decision must see the true total.
	 *
	 * @param {object} session
	 * @param {object|undefined} gate the gate record of the committed attempt (may be `{enabled:false}`)
	 * @param {object} policy
	 */
	_chargeDebt(session, gate, policy) {
		const writeTokens = gate?.writeTokens;
		const seenMemo = gate?.memoTokens;
		if (typeof writeTokens !== "number" || typeof seenMemo !== "number") return;
		this.debt.charge(session, {
			writeTokens,
			savingTokens: Math.max(0, (gate.archiveTokens ?? 0) - seenMemo),
			cacheWriteReadRatio: policy.economics.cacheWriteReadRatio,
		});
	}

	/** The PRE-CALL lower bound of the framed checkpoint's price: the same floor the gate decides on. */
	_framedMemoTokens() {
		const framingOnly = createUserMessage({
			content: frameSummary([]),
			source: { kind: "plugin", plugin: SUMMARIZER_PLUGIN },
		});
		return this.ctx.tokenMeter.estimateMessage(framingOnly);
	}

	/** Bind the effective token meter, the archiver, the sink, and the dynamically dispatched summarizer. */
	_compact(session, start, end, agent, signal, options) {
		return compactSurfaceRegion({
			meter: this.ctx.tokenMeter,
			summarize: (input, owner, abort) => this.summarize(input, owner, abort),
			archive: (request) => archiveShadowedRegion({ getSpillStore: () => this.ctx.get("spillStore"), logger: this.logger }, request),
			audit: this.auditFor(),
			failedTrace: (payload) => this.failedTraceFor().record(payload),
			logger: this.logger,
		}, session, start, end, agent, {
			traceFailedAttempts: this.policySource.read().enabled,
			/* M4-D: the failure is remembered from the transaction's own verdict, so the key is the
			 * selection that was actually attempted and the stage is the one it actually died at. Only
			 * the AUTOMATIC PRESSURE path is remembered — this is the path that would otherwise re-decide
			 * the same span on its own. A manual `/compact`, a forced region and overflow recovery are
			 * explicit requests: each must behave exactly as it did before this mechanism existed. */
			onFailure: (stage) => {
				if (options.trigger === "pressure") this._rememberFailedSelection(session, start, end, stage);
			},
			...options,
		}, signal);
	}

	/**
	 * Remember one failed attempt's selection, for the automatic pressure path only (M4-D).
	 *
	 * A MANUAL compaction is never remembered: the human asked for that exact span, and refusing to
	 * repeat it would turn `/compact` into a command that silently stops working after one failure.
	 * A forced region and overflow recovery are likewise untouched — overflow recovery is a
	 * correctness obligation with its own durable retry budget, and this mechanism must not weaken it.
	 *
	 * The surface price recorded here is the one measured at the attempt's own decision, which is what
	 * a later evaluation must beat by the smaller of {@link FAILED_RANGE_GROWTH_MARGIN} of that price
	 * and {@link FAILED_RANGE_GROWTH_CAP_TOKENS} before the span is retried.
	 *
	 * @param {object} session
	 * @param {number} start inclusive first surface-node seq of the attempted span
	 * @param {number} end inclusive last surface-node seq of the attempted span
	 * @param {string} stage the stage the transaction died at
	 */
	_rememberFailedSelection(session, start, end, stage) {
		this.failedSelections.set(session, {
			...failedRangeKey({ start, end }, this.ctx.tokenMeter.measure(session).totalTokens),
			stage,
			at: Date.now(),
		});
	}

	/**
	 * Whether the candidate selection is still covered by this session's remembered failure (M4-D).
	 * @param {object} session
	 * @param {{ start: number, end: number }} range
	 * @param {number} totalTokens the surface price at this decision
	 * @returns {boolean}
	 */
	_backedOff(session, range, totalTokens) {
		return isBackedOff(this.failedSelections.get(session), range, totalTokens);
	}

	/**
	 * Record one failed-selection backoff: a `status:"deferred"` audit line and NO session event
	 * (M4-D).
	 *
	 * Same "the refusal must leave the durable log byte-for-byte as it was" contract as the economic
	 * gate's deferral (D2/D7), and the same audit schema: only `reason` and the added `backoff` detail
	 * distinguish the two, so every existing consumer of a deferred line keeps working.
	 *
	 * @param {object} session
	 * @param {object} policy resolved policy
	 * @param {object} evaluation the `_evaluate` record whose selection was skipped
	 * @param {number} totalTokens the surface price at this decision
	 * @param {string} trigger
	 * @returns {Promise<object>} the recorded line
	 */
	async _recordBackoff(session, policy, evaluation, totalTokens, trigger) {
		return recordDeferred(
			{ audit: this.auditFor(), logger: this.logger },
			session,
			{ start: evaluation.range.start, end: evaluation.range.end, shadowedSeqs: evaluation.shadowedSeqs },
			/* The gate record is the REAL evaluation this decision replaced, so the line still shows
			 * what the economics said; only `reason` names why the attempt was withheld. */
			evaluation.gate,
			evaluation.todoHint,
			trigger,
			{
				reason: FAILED_RANGE_BACKOFF_REASON,
				backoff: { ...failedRangeKey(evaluation.range, totalTokens), margin: FAILED_RANGE_GROWTH_MARGIN, growthCapTokens: FAILED_RANGE_GROWTH_CAP_TOKENS },
			},
		);
	}

	/**
	 * Compact one inclusive positional range from the agent-owned surface.
	 * @param {number} start
	 * @param {number} end
	 * @param {{ session: object, options: object }} agent
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<object>}
	 */
	async compactRegion(start, end, agent, signal) {
		const policy = this.policySource.read();
		/* A forced region is not an economic decision; the audit line says so explicitly. */
		const prepared = this._regionGate(policy, agent.session, start, end, "forced-region");
		const outcome = await this._compact(agent.session, start, end, agent, signal, {
			owner: "current-turn",
			stability: "whole-surface",
			trigger: "compactRegion",
			archiveEnabled: policy.archive,
			gate: prepared,
		});
		this._chargeDebt(agent.session, prepared, policy);
		return outcome;
	}

	/**
	 * Price an explicitly requested region for the audit line.
	 *
	 * The region is not gated (the caller asked for it), but it is PRICED: the cache-write it pays is
	 * real and the debt ledger must see it, and an audit line without the numbers could not explain
	 * the later pressure decisions that inherit them.
	 *
	 * @param {object} policy
	 * @param {object} session
	 * @param {number} start
	 * @param {number} end
	 * @param {string} forcedReason the audit reason naming WHY the gate had no authority here
	 * @returns {object} the gate record to record and to charge
	 */
	_regionGate(policy, session, start, end, forcedReason) {
		const measurement = this.ctx.tokenMeter.measure(session);
		const priced = gateRecord(policy, measurement, measuredSeqs(measurement, start, end), { contextWindow: null }, this._framedMemoTokens(), {
			priorCompactionCount: countCommittedCompactions(session),
			...this._debtPending(session),
			remainingBoundaries: null,
			completedBoundaryRequestCounts: null,
		});
		/* The audit reason names WHY the gate had no authority here, while the numbers below stay live:
		 * a forced compaction still pays its cache-write and must be visible to the debt ledger. */
		return { ...priced, evaluated: false, reason: forcedReason };
	}

	/**
	 * Force one useful idle-session compaction below the pressure threshold.
	 *
	 * Deliberately NOT `async`: the surrounding try/catch must catch only `runMaintenance`'s
	 * SYNCHRONOUS rejection (agent not idle), while an asynchronous failure keeps its own
	 * classification (`cancelled`/`changed`/`summary`/`commit`/`persistence`).
	 * @param {object} agent idle agent whose next-turn admission this call reserves
	 * @param {AbortSignal} signal cancellation scoped to this compaction request
	 * @param {string} [sourceCommandId] initiating command identity for presentation correlation
	 * @returns {Promise<object|null>}
	 */
	compactNow(agent, signal, sourceCommandId) {
		signal.throwIfAborted();
		try {
			return agent.runMaintenance(async (agentSignal) => {
				const operationSignal = AbortSignal.any([agentSignal, signal]);
				try {
					operationSignal.throwIfAborted();
					const policy = this.policySource.read();
					const range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);
					if (range === null) return null;
					const prepared = this._regionGate(policy, agent.session, range.start, range.end, "explicit-manual");
					const outcome = await this._compact(agent.session, range.start, range.end, agent, operationSignal, {
						owner: null,
						stability: "selected-span",
						trigger: "manual",
						archiveEnabled: policy.archive,
						gate: prepared,
						...(sourceCommandId === undefined ? {} : { sourceCommandId }),
						flush: async () => {
							await this.ctx.sessions.flush(agent.session);
						},
					});
					this._chargeDebt(agent.session, prepared, policy);
					return outcome;
				} catch (error) {
					if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
						throw new ManualCompactionError("cancelled", "manual compaction was cancelled", { cause: error });
					}
					operationSignal.throwIfAborted();
					throw error;
				}
			});
		} catch (error) {
			if (error instanceof ManualCompactionError) throw error;
			throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
		}
	}

	/**
	 * Summarize the replayed conversation region through a direct one-shot `ctx.llm.stream()` call
	 * whose prefix reuses the conversation's own system prompt, tools, and messages.
	 * @param {{ messages: object[], tools?: readonly object[] }} input
	 * @param {object} agent
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<object>}
	 */
	async summarize(input, agent, signal) {
		return summarizeWithLlm(this.ctx, this.policySource.read(), input, agent, signal);
	}
}

/**
 * @param {object} ctx cordis context
 * @param {object} [config] the plugin's composition entry; the base layer of the settings section
 */
/**
 * The measured node seqs of one positional span, for a gate that must price exactly what a range
 * removes.
 *
 * The span is resolved by POSITION on the measured surface, never by comparing seqs: after a
 * replacement the checkpoint carries a seq from the end of the log while sitting at the front of the
 * surface, so a seq-ordered filter would silently price the wrong (or an empty) span.
 *
 * @param {{ nodes: readonly { seq: number }[] }} measurement
 * @param {number} start inclusive first surface-node seq
 * @param {number} end inclusive last surface-node seq
 * @returns {number[]}
 */
function measuredSeqs(measurement, start, end) {
	const startIdx = measurement.nodes.findIndex((node) => node.seq === start);
	const endIdx = measurement.nodes.findIndex((node) => node.seq === end);
	if (startIdx < 0 || endIdx < startIdx) return [];
	return measurement.nodes.slice(startIdx, endIdx + 1).map((node) => node.seq);
}

/**
 * @param {object} ctx cordis context
 * @param {object} [config] the plugin's composition entry; the base layer of the settings section
 */
export function apply(ctx, config) {
	const logger = typeof ctx.logger?.warn === "function" ? ctx.logger : { warn: () => {}, info: () => {} };
	const policySource = createPolicySource(ctx, config, logger);
	const engine = new ContextCompactEngine(ctx, { policySource, logger });
	/* The audit tail is drained on unload so a disposed plugin cannot lose a queued line. */
	ctx.effect(() => () => engine.flushAudit(), "context-compact audit flush");
	const policy = policySource.read();
	logger.info?.(
		`context-compact: loaded (enabled=${policy.enabled}, archive=${policy.archive}, economics=${policy.economics.enabled}, thresholdRatio=${policy.thresholdRatio}) with ${policySource.describe()}`,
	);
	if (!policy.enabled) {
		logger.info?.("context-compact: automatic compaction is disabled (efficiency-context-compact.enabled is false); no listener was registered and /compact stays available");
	}
}
