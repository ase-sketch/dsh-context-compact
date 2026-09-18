/**
 * The compaction transaction and the automatic trigger policy.
 *
 * A FRESH implementation of `ctx.compaction` (docs/phase4-plan.md §0 "不继承 basic"), not a subclass
 * of `compaction-basic`: that backend couples trigger registration to construction and hides its
 * transaction internals, so an override could not stay clean. The obligations it must nevertheless
 * honor (phase4-plan.md §0 C2) are all implemented here and each one is covered by a unit test:
 *
 *   1. /compact compatibility — `compactNow` runs through the host's idle-maintenance seam and
 *      classifies expected failures as `ManualCompactionError` (`busy`/`cancelled`/`changed`/
 *      `summary`/`commit`/`persistence`), which is exactly what `@deepseek-ai/dsh-command-compact`
 *      renders. An unsuccessful attempt still appends its `compaction/end(error)`.
 *   2. Overflow recovery — `agent/request-error` on `CONTEXT_WINDOW_EXCEEDED` retries with a durable
 *      budget (`maxOverflowRetries`) and only when `surface.replaceGeneration` advanced, i.e. only
 *      when the previous attempt actually landed a replacement.
 *   3. The lock — `compaction/start` is appended SYNCHRONOUSLY right after read-only validation and
 *      is closed by exactly one `compaction/end` attempt; an unmatched start is the durable "busy"
 *      marker, and a start that predates the latest `session/end-seed` is stale.
 *   4. Cancellation — the caller's signal is forwarded into the summarization call and re-checked
 *      after every await; an aborted manual request preserves its exact abort reason.
 *   5. Tool-pairing balance — `toolPairingBalancedBefore/After` from `@deepseek-ai/dsh-compaction`
 *      own both edges; an unbalanced or reversed or missing range is rejected before any write.
 *   6. toolResultPruner wiring — the pruner never listens for events. `compaction-basic` called it
 *      explicitly, so replacing that backend means calling it here (`ctx.get("toolResultPruner")`),
 *      otherwise it would silently never run again.
 *
 * Plus this plugin's own evidence-preserving step: the shadowed `原文` is archived through the spill
 * substrate BEFORE any replacement, and a refused archive aborts the transaction with nothing
 * written (see `archive.js`).
 *
 * @module @sol-pi-port/dsh-context-compact/engine
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	CompactionId,
	ManualCompactionError,
	compactCheckpointSource,
} from "@deepseek-ai/dsh-compaction";
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from "@deepseek-ai/dsh-llm";
import { evaluateGate } from "./economics.js";
import { selectCompactableRange, validateSurfaceRegion } from "./selectors.js";
import { failedCompactionChunks } from "./sidecar.js";
import { buildSummarizationInput, frameSummary, summarizeWithLlm } from "./summarize.js";

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was built from,
 * distinguished from summarizer and shrink failures so a manual caller can report the two causes
 * differently.
 */
export class SurfaceChangedError extends Error {}

/** A missing or rejected archive: evidence preservation forbids completing the transaction. */
export class ArchiveRefusedError extends Error {}

/** A per-route pressure-configuration failure eligible for one-shot warning suppression. */
export class TargetPressureConfigError extends Error {
	/**
	 * @param {string} targetKey exact provider/model route used as the warning key
	 * @param {string} message actionable configuration failure detail
	 */
	constructor(targetKey, message) {
		super(message);
		this.targetKey = targetKey;
	}
}

/**
 * Resolve the exact provider/model durably routed for the latest request.
 * @param {{ requestHeader: () => object|undefined }} session
 * @returns {{ provider: string, model: string } | undefined}
 */
export function routedTarget(session) {
	const config = session.requestHeader()?.config;
	if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined;
	return { provider: config.provider, model: config.model };
}

/**
 * Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently.
 * @param {object} session
 * @returns {{ openTurn: number|null, unmatchedCompactionStart: object|undefined, latestEndSeedSeq: number|undefined }}
 */
export function inspectCompactionEntryState(session) {
	let openTurn = null;
	let openTurnStateKnown = false;
	let unmatchedCompactionStart;
	let compactionEntryStateKnown = false;
	let latestEndSeedSeq;
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq);
		if (event === undefined) continue;
		if (latestEndSeedSeq === undefined && event.type === "session/end-seed") latestEndSeedSeq = event.seq;
		if (!compactionEntryStateKnown) {
			if (event.type === "compaction/start") {
				unmatchedCompactionStart = event;
				compactionEntryStateKnown = true;
			} else if (event.type === "compaction/end") compactionEntryStateKnown = true;
		}
		if (!openTurnStateKnown) {
			if (event.type === "turn/start") {
				openTurn = event.data.turn;
				openTurnStateKnown = true;
			} else if (event.type === "turn/end") openTurnStateKnown = true;
		}
		if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break;
	}
	return { openTurn, unmatchedCompactionStart, latestEndSeedSeq };
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed boundary proves that
 * its owner belongs to an earlier session lifecycle.
 * @param {object|undefined} unmatchedCompactionStart latest unmatched opening marker, if any
 * @param {number|undefined} latestEndSeedSeq newest constructor-seed boundary, if any
 * @param {string} stage operation label included in the busy diagnostic
 * @throws {ManualCompactionError} with code `busy`
 */
export function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage) {
	if (unmatchedCompactionStart === undefined || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) return;
	throw new ManualCompactionError("busy", `${stage}: compaction already in progress; the session compaction lock is already active`);
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param {object} session
 * @param {string} stage operation label included in the busy diagnostic
 */
export function assertNoActiveCompaction(session, stage) {
	const entryState = inspectCompactionEntryState(session);
	assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, stage);
}

/**
 * Snapshot pricing and replay input for a validated surface range.
 * @param {{ meter: object }} deps
 * @param {object} session
 * @param {{ start: number, end: number, startIdx: number, endIdx: number, shadowedSeqs: number[] }} selection
 * @returns {object} prepared compaction
 * @throws {SurfaceChangedError} when the surface moved between selection and preparation
 */
export function prepareCompaction(deps, session, selection) {
	const measurement = deps.meter.measure(session);
	const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1);
	if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
		throw new SurfaceChangedError("compaction: selected surface changed before summarization began");
	}
	return {
		...selection,
		measurement,
		selectedNodes,
		shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
		shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
		input: buildSummarizationInput(session, selection.shadowedSeqs),
	};
}

/**
 * Run the summarizer and frame its replacement checkpoint.
 * @param {object} deps
 * @param {object} prepared
 * @param {object} agent
 * @param {string} compactionId
 * @param {string|undefined} sourceCommandId
 * @param {AbortSignal|undefined} signal
 * @param {{ locator: string, bytes: number, retrievalHint: string }|undefined} archived
 * @returns {Promise<object>}
 */
export async function summarizeCompaction(deps, prepared, agent, compactionId, sourceCommandId, signal, archived) {
	const summaryResult = await deps.summarize(prepared.input, agent, signal);
	const checkpointMessage = createUserMessage({
		content: frameSummary(summaryResult.summary),
		source: compactCheckpointSource(compactionId, sourceCommandId),
	});
	const framedSummaryTokenCount = deps.meter.estimateMessage(checkpointMessage);
	if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
		/* M4-A: the stream was consumed and its complete output is in hand, but no
		 * `compaction/summary` event will land. The rejected call is the one thing positional replay
		 * cannot see, so the failure carries the trace out to the transaction, which writes it to the
		 * sidecar once the attempt's own `compaction/end(error)` seq exists to anchor it. */
		throw Object.assign(
			new Error(`summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`),
			{ failedCompactionTrace: { rawOutput: summaryResult.rawOutput, usage: summaryResult.usage } },
		);
	}
	return { ...prepared, ...summaryResult, checkpointMessage, framedSummaryTokenCount, archived };
}

/**
 * Attach an attempt's consumed stream to the error that ends it (M4-A).
 *
 * Only a COMPLETE stream is worth recording: if the summarizer itself threw, the replay already has no
 * script to lose (a derived entry without a terminating `finish` chunk is rejected by llm-replay
 * outright). Everything after the call returned has a full `rawOutput` and must not vanish.
 *
 * @param {unknown} error the failure to annotate
 * @param {object} summarized the completed summarizer result
 * @returns {unknown} the same error, carrying the trace when there is one
 */
export function withFailedCompactionTrace(error, summarized) {
	if (!Array.isArray(summarized?.rawOutput)) return error;
	return Object.assign(error, {
		failedCompactionTrace: {
			rawOutput: summarized.rawOutput,
			...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
		},
	});
}

/** Reject a summary prepared against any earlier surface generation. */
export function assertWholeSurfaceUnchanged(deps, session, prepared) {
	if (!isDeepStrictEqual(deps.meter.measure(session).nodes, prepared.measurement.nodes)) {
		throw new SurfaceChangedError("compaction: session surface changed during summarization");
	}
}

/**
 * Require only that the selected span remain the same present, contiguous, equally priced, balanced
 * replacement target. Nodes added outside it remain visible and do not invalidate the summary.
 */
export function assertSelectedSpanStable(deps, session, prepared) {
	let current;
	try {
		current = validateSurfaceRegion(session, prepared.start, prepared.end);
	} catch (error) {
		throw new SurfaceChangedError("compaction: the selected span is no longer a valid replacement target", { cause: error });
	}
	if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
		throw new SurfaceChangedError("compaction: the selected span changed during summarization");
	}
	if (!isDeepStrictEqual(deps.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1), prepared.selectedNodes)) {
		throw new SurfaceChangedError("compaction: the selected span was rewritten during summarization");
	}
}

/**
 * Append one completed summary record and the replacement body without yielding.
 *
 * The replacement `user/message` carries `surfaceOp {op:"replace"}` over the shadowed span and cites
 * the start/summary/shadowed events — the host's own atomic surface replacement, no host patch.
 */
/**
 * The durable record of what one committed compaction charged the debt ledger (M4-B).
 *
 * The ledger's three inputs (`writeTokens` = the gate's pre-call surface price, `archiveTokens` =
 * the route price of the shadowed span, `memoTokens` = the framed checkpoint's pre-call price) are not
 * derivable from any other field of the event, so a restarted process cannot rebuild the ledger
 * without them. They ride ON the existing `compaction/summary` event — same data source (the session
 * log), no new file.
 *
 * `charged` mirrors the engine's own charge predicate (a gate that priced both numbers), never a
 * re-derivation: `writeTokens` is `null` exactly when the gate was off.
 *
 * @param {object} summarized the committed compaction facts
 * @returns {object} the charge record for the summary event
 */
export function chargeRecordOf(summarized) {
	const measurable = summarized.gate;
	const charged = typeof measurable?.writeTokens === "number" && typeof measurable?.memoTokens === "number";
	return {
		charged,
		writeTokens: charged ? measurable.writeTokens : null,
		archiveTokens: typeof measurable?.archiveTokens === "number" ? measurable.archiveTokens : (summarized.shadowedRouteTokenCount ?? null),
		memoTokens: charged ? measurable.memoTokens : null,
		savingTokens: charged ? Math.max(0, (measurable.archiveTokens ?? 0) - measurable.memoTokens) : 0,
		cacheWriteReadRatio: charged && typeof measurable.cacheWriteReadRatio === "number" ? measurable.cacheWriteReadRatio : null,
	};
}

export function commitCompactionBody(session, startEvent, summarized) {
	const { start, end, shadowedSeqs, shadowedTokenCount, summary, provider, model, maxTokens, usage, checkpointMessage } = summarized;
	const callProvenance = summarized.llmStreamCall === true
		? { rawOutput: summarized.rawOutput, llmStreamCall: true }
		: summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput };
	const summaryEvent = session.append("compaction/summary", {
		compactionId: startEvent.data.compactionId,
		...(startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId }),
		summary,
		...callProvenance,
		shadowedRange: { start, end },
		shadowedSeqs: [...shadowedSeqs],
		shadowedTokenCount,
		provider,
		model,
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(usage === undefined ? {} : { usage }),
		charge: chargeRecordOf(summarized),
	});
	session.append("user/message", checkpointMessage, {
		surfaceOp: { op: "replace", startSeq: start, endSeq: end },
		sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
	});
	return {
		compactionId: startEvent.data.compactionId,
		...(startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId }),
		startSeq: startEvent.seq,
		summarySeq: summaryEvent.seq,
		summary,
		shadowedRange: { start, end },
		shadowedSeqs: [...shadowedSeqs],
		shadowedTokenCount,
	};
}

/** Attach the successfully appended close event to a pending result. */
export function completeCompaction(pending, endEvent) {
	return { ...pending, endSeq: endEvent.seq };
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
export function throwManualFailure(failure) {
	if (failure.stage === "commit") throw new ManualCompactionError("commit", "manual compaction did not commit cleanly", { cause: failure.error });
	if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError("changed", "the compacted history changed during manual compaction", { cause: failure.error });
	if (failure.error instanceof ArchiveRefusedError) {
		/* The closed ManualCompactionError code set has no archive class; `summary` is the member whose
		 * rendered text is factually right here ("the conversation is unchanged; the attempt is recorded
		 * in the session log"), and the real reason travels in the audit line and the log. */
		throw new ManualCompactionError("summary", `manual compaction could not archive the shadowed history: ${failure.error.message}`, { cause: failure.error });
	}
	throw new ManualCompactionError("summary", "manual compaction could not produce a smaller summary", { cause: failure.error });
}

/**
 * Count the compactions already COMMITTED on one session's durable log (phase4-m2-plan.md D3).
 *
 * Derived from the log, never tracked in memory: a `compaction/end` without `error` is the durable
 * record that one compaction landed, so the count survives a restart, a resume, and a replay, and it
 * is the same number a replayed decision sees.
 *
 * @param {{ seq: number, eventAt: (seq: number) => object|undefined }} session
 * @returns {number}
 */
export function countCommittedCompactions(session) {
	let count = 0;
	for (let seq = 0; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event !== undefined && event.type === "compaction/end" && event.data.error === undefined) count += 1;
	}
	return count;
}

/**
 * Plan one economic-gate evaluation record for the audit line.
 *
 * The gate is EVALUATED and RECORDED (phase4-plan.md §0 C4 "经济门控判定明细") and, for the automatic
 * `pressure` trigger, its verdict DECIDES whether the compaction runs at all (phase4-m2-plan.md D1/D2).
 * With `policy.economics.enabled === false` (the default) the vendored algorithm is not even
 * consulted.
 *
 * Every input is a live fact: `priorCompactionCount` comes from the session log, the carried debt
 * from the engine's per-session ledger, and the horizon from the todo tracker. The audit line carries
 * the complete input set, so a decision can be reconstructed without re-running it.
 *
 * @param {object} policy resolved policy
 * @param {object} measurement meter measurement at decision time
 * @param {readonly number[]} shadowedSeqs candidate span
 * @param {{ contextWindow?: number }} context routed model context
 * @param {number} memoTokens PRE-CALL lower bound of the framed replacement's price (framing
 *   overhead only, priced before the model has produced the summary text): the gate must decide
 *   before the summarization call is paid for.
 * @param {{ priorCompactionCount?: number, carriedDebtTokens?: number, cacheDebtRepaymentTokens?: number, remainingBoundaries?: number|null, completedBoundaryRequestCounts?: readonly number[]|null }} [inputs]
 * @returns {object} gate record for the audit line; `{enabled:false}` when the gate is switched off
 */
export function gateRecord(policy, measurement, shadowedSeqs, context, memoTokens, inputs = {}) {
	if (!policy.economics.enabled) return { enabled: false, evaluated: false };
	const priorCompactionCount = inputs.priorCompactionCount ?? 0;
	const carriedDebtTokens = inputs.carriedDebtTokens ?? 0;
	const cacheDebtRepaymentTokens = inputs.cacheDebtRepaymentTokens ?? 0;
	/* `null` is the "no todo data" signal and is passed through verbatim: it is what makes the
	 * vendored algorithm answer `horizon_unavailable` and refuse (phase4-m2-plan.md D4). */
	const remainingBoundaries = inputs.remainingBoundaries === undefined ? 0 : inputs.remainingBoundaries;
	const completedBoundaryRequestCounts = inputs.completedBoundaryRequestCounts === undefined ? null : inputs.completedBoundaryRequestCounts;
	const decision = evaluateGate({
		policy,
		measurement,
		shadowedSeqs,
		memoTokens,
		contextWindowTokens: context?.contextWindow ?? null,
		writeTokens: measurement.surfaceTokens,
		priorCompactionCount,
		carriedDebtTokens,
		cacheDebtRepaymentTokens,
		remainingBoundaries: remainingBoundaries ?? 0,
		averageContextTokenIncrement: null,
		completedBoundaryRequestCounts,
	});
	return {
		enabled: true,
		evaluated: true,
		compact: decision.compact,
		reason: decision.reason,
		contextTokens: decision.contextTokens,
		contextWindowTokens: context?.contextWindow ?? null,
		windowReserveTokens: policy.economics.windowReserveTokens,
		archiveTokens: decision.archiveTokens,
		memoTokens: decision.memoTokens,
		writeTokens: decision.writeTokens,
		breakevenRequests: decision.breakevenRequests,
		combinedBreakevenRequests: decision.combinedBreakevenRequests,
		effectiveHorizonRequests: decision.effectiveHorizonRequests,
		expectedRemainingRequests: decision.expectedRemainingRequests,
		requestsPerBoundaryMean: decision.requestsPerBoundaryMean,
		requestsPerBoundaryLowerBound: decision.requestsPerBoundaryLowerBound,
		unboundedExpectedRemainingRequests: decision.unboundedExpectedRemainingRequests,
		windowRequestUpperBound: decision.windowRequestUpperBound,
		incrementalCacheCostRatio: decision.incrementalCacheCostRatio,
		cacheWriteReadRatio: decision.cacheWriteReadRatio,
		priorCompactionCount: decision.priorCompactionCount,
		carriedDebtTokens: decision.carriedDebtTokens,
		cacheDebtRepaymentTokens: decision.cacheDebtRepaymentTokens,
		completedBoundaryRequestCounts: decision.completedBoundaryRequestCounts,
		remainingBoundaries,
		averageContextTokenIncrement: decision.averageContextTokenIncrement,
	};
}

/**
 * The PROPORTIONAL half of the surface-price growth that releases a failed-selection backoff (M4-D).
 *
 * A share of the failed price, so it scales with the conversation. On its own it is wrong at scale:
 * a 1M-token surface plus a byte-identical span would demand a whole 100k tokens of new content
 * before the same selection may be retried, which suppresses the retry for the rest of a long
 * session. FAILED_RANGE_GROWTH_CAP_TOKENS closes that end.
 */
export const FAILED_RANGE_GROWTH_MARGIN = 0.1;

/**
 * The ABSOLUTE half of the release threshold (M4-D): growth beyond this many tokens always releases
 * the backoff, whatever the proportion would demand.
 *
 * The two halves are combined with min(), so small surfaces keep the old +10% behavior exactly
 * (there the proportion is the smaller of the two) and large surfaces are released at a fixed, still
 * meaningful amount of genuinely new content. This is not a weakening of "the same rejection is not
 * bought twice": the span must still be byte-identical AND the surface must still have grown by
 * either +10% or this many tokens, whichever is smaller.
 */
export const FAILED_RANGE_GROWTH_CAP_TOKENS = 4096;

/**
 * The audit `reason` naming a deferred evaluation caused by the failed-selection backoff (M4-D).
 *
 * Deliberately distinct from the economic gate's reason codes: the decision recorded here is not a
 * price verdict, it is "this exact selection was just paid for and rejected".
 */
export const FAILED_RANGE_BACKOFF_REASON = "failed_region_backoff";

/**
 * The identity of one failed selection: the span that was shadowed, plus the surface price the
 * decision was made at.
 *
 * Both halves are needed. The span alone would suppress a legitimately different decision after the
 * surface moved (the recording's own recovery: a failed single-node `220-220` was followed by a
 * successful `220-172`); the price alone would suppress an unrelated span that happens to sit at a
 * similar total.
 *
 * @param {{ start: number, end: number }} range the selection that failed
 * @param {number} totalTokens `measurement.totalTokens` at decision time
 * @returns {{ start: number, end: number, totalTokens: number }}
 */
export function failedRangeKey(range, totalTokens) {
	return { start: range.start, end: range.end, totalTokens };
}

/**
 * Whether a selection is still covered by a remembered failure (M4-D).
 *
 * A retry is withheld only while BOTH facts still hold: the span is byte-identical AND the surface
 * has not grown past the release threshold, which is the SMALLER of {@link FAILED_RANGE_GROWTH_MARGIN}
 * of the failed price and {@link FAILED_RANGE_GROWTH_CAP_TOKENS} (M4-D revision: a single
 * proportional threshold made the suppression period grow without bound — at a 1M-token surface it
 * demanded 100k tokens of new content). Growth is the release valve: a summary is produced from the
 * region's content, so more content in flight is a genuinely new attempt, while the same region at
 * the same price buys the same rejection again.
 *
 * A shrunk surface is still backed off: nothing about a smaller surface makes the same span easier
 * to summarize below its own price.
 *
 * @param {{ start: number, end: number, totalTokens: number }|undefined|null} key the remembered failure
 * @param {{ start: number, end: number }} range the selection being evaluated now
 * @param {number} totalTokens the surface price now
 * @returns {boolean}
 */
export function isBackedOff(key, range, totalTokens) {
	if (key === undefined || key === null) return false;
	if (key.start !== range.start || key.end !== range.end) return false;
	/* Dual threshold (M4-D): the smaller of the two release prices. A large surface therefore stops
	 * suppressing a byte-identical selection CAP tokens above the failed price instead of at an
	 * ever-growing share of its own price.
	 *
	 * The proportional arm keeps the PRE-REVISION expression verbatim rather than an algebraically
	 * equal `price + min(price * margin, cap)`: the two differ by one ULP at exact boundaries (a
	 * 50-token surface has a 55.00000000000001 threshold, so 55 is still withheld), and "small
	 * surfaces behave exactly as before" is a claim this code should make literally true. */
	const proportionalRelease = key.totalTokens * (1 + FAILED_RANGE_GROWTH_MARGIN);
	const cappedRelease = key.totalTokens + FAILED_RANGE_GROWTH_CAP_TOKENS;
	return totalTokens < Math.min(proportionalRelease, cappedRelease);
}

/**
 * Record one economic-gate refusal: a `status:"deferred"` audit line and NO session event
 * (phase4-m2-plan.md D2/D7).
 *
 * The refusal must leave the durable log byte-for-byte as it was — no `compaction/start`, no summary,
 * no replacement — which is why this is a separate path from `compactSurfaceRegion` rather than a
 * variant of it: the transaction never opens.
 *
 * @param {{ audit?: object, logger?: object }} deps
 * @param {object} session
 * @param {{ start: number, end: number, shadowedSeqs: readonly number[] }} selection
 * @param {object} gate evaluated gate record
 * @param {object|null} hint todo-alignment detail for the audit line
 * @param {string} trigger
 * @param {object} [detail] extra fields for this refusal class, applied AFTER the gate so a
 *   non-economic deferral can name its own `reason` without inventing a gate record
 */
export async function recordDeferred(deps, session, selection, gate, hint, trigger, detail = {}) {
	const record = {
		event: "compaction",
		status: "deferred",
		trigger,
		sessionId: String(session.id),
		turn: inspectCompactionEntryState(session).openTurn,
		reason: gate.reason ?? "gate_declined",
		shadowedRange: { start: selection.start, end: selection.end },
		shadowedSeqs: [...selection.shadowedSeqs],
		gate,
		...(hint === null || hint === undefined ? {} : { todoHint: hint }),
		...detail,
	};
	try {
		await deps.audit?.record(record);
	} catch (error) {
		deps.logger?.warn?.(`context-compact: audit record failed: ${String(error)}`);
	}
	return record;
}

/**
 * Run the single compaction transaction over one selected positional span.
 *
 * Selection and validation are read-only. Idle/log validation and `compaction/start` are
 * synchronously adjacent, so the durable opening marker is the compaction lock before the first
 * yield. The archive step runs under that lock and BEFORE summarization: the shadowed `原文` must be
 * durable before anything is replaced, and a refused archive aborts with zero writes. Every later
 * failure makes exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 *
 * @param {{ meter: object, summarize: Function, archive: Function, audit: object|undefined, logger: object|undefined }} deps
 * @param {object} session session whose surface is mutated
 * @param {number} start inclusive first surface-node seq
 * @param {number} end inclusive last surface-node seq
 * @param {object} agent agent used by the summarizer
 * @param {{ owner: number|null, stability: "whole-surface"|"selected-span", trigger: string, sourceCommandId?: string, flush?: Function, gate?: object, contextWindow?: number, archiveEnabled?: boolean, onFailure?: (stage: string) => void }} options
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<object>} the successful durable compaction result
 */
export async function compactSurfaceRegion(deps, session, start, end, agent, options, signal) {
	/* Resolved bracket owner: `null` for a standalone manual transaction, the open turn number for an
	 * automatic one. Declared before the audit closure because every refusal below records it. */
	let owner;
	/* The consumed-but-rejected summarizer trace of the attempt in flight, plus the seq of the closing
	 * `compaction/end(error)` that anchors it: both captured in the catch below. */
	let failedTrace;
	let failureEndSeq;
	const audit = async (record) => {
		try {
			await deps.audit?.record({
				event: "compaction",
				trigger: options.trigger,
				sessionId: String(session.id),
				turn: owner ?? null,
				...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
				...record,
			});
		} catch (error) {
			deps.logger?.warn?.(`context-compact: audit record failed: ${String(error)}`);
		}
	};
	if (options.owner === null) signal?.throwIfAborted();
	let selection;
	try {
		selection = validateSurfaceRegion(session, start, end);
	} catch (error) {
		await audit({ status: "refused", reason: "unbalanced-or-missing-range", error: String(error), shadowedRange: { start, end } });
		throw error;
	}
	const entryState = inspectCompactionEntryState(session);
	try {
		assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, "compaction");
	} catch (error) {
		await audit({ status: "refused", reason: "busy", error: String(error), shadowedRange: { start, end } });
		throw error;
	}
	if (options.owner === null) {
		if (entryState.openTurn !== null) {
			const error = new ManualCompactionError("busy", "manual compaction: the session already has an open turn");
			await audit({ status: "refused", reason: "busy", error: String(error), shadowedRange: { start, end } });
			throw error;
		}
		owner = null;
	} else {
		if (entryState.openTurn === null) {
			const error = new Error("compactRegion: no open turn — automatic compaction events must be enclosed in a turn");
			await audit({ status: "refused", reason: "no-open-turn", error: String(error), shadowedRange: { start, end } });
			throw error;
		}
		owner = entryState.openTurn;
	}
	const compactionId = CompactionId(randomUUID());
	const lifecycle = {
		compactionId,
		...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
		turn: owner,
	};
	const startEvent = session.append("compaction/start", lifecycle);
	const assertStable = options.stability === "whole-surface" ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
	let failure;
	let flushFailure;
	let result;
	let closed = false;
	let closing = false;
	let stage = "archive";
	let archived;
	let summaryFacts;
	try {
		const prepared = prepareCompaction(deps, session, selection);
		if (options.archiveEnabled === false) {
			archived = { ok: true, skipped: true };
		} else {
			archived = await deps.archive({
				session,
				compactionId,
				start: selection.start,
				end: selection.end,
				shadowedSeqs: selection.shadowedSeqs,
			});
			if (archived.ok === false) throw new ArchiveRefusedError(archived.reason);
		}
		stage = "summary";
		const summarized = await summarizeCompaction(deps, prepared, agent, compactionId, options.sourceCommandId, signal, archived.ok === true && archived.skipped !== true ? archived : undefined);
		/* M4-B: the decision that authorized this transaction rides onto the durable summary event, so
		 * the charge is reconstructable from the log. Attached here rather than inside
		 * `summarizeCompaction` because the gate belongs to the transaction, not to the model call. */
		summarized.gate = options.gate;
		/* M4-A: from here on the stream is COMPLETE and in hand, so any later failure (cancellation,
		 * a moved surface, a commit fault) loses a model call that positional replay cannot see. The
		 * trace travels on the error; the transaction writes it once the end seq exists. */
		try {
			if (options.owner === null) signal?.throwIfAborted();
			assertStable(deps, session, summarized);
		} catch (error) {
			throw withFailedCompactionTrace(error, summarized);
		}
		summaryFacts = summarized;
		stage = "commit";
		const pending = commitCompactionBody(session, startEvent, summarized);
		closing = true;
		const endEvent = session.append("compaction/end", lifecycle);
		closed = true;
		result = completeCompaction(pending, endEvent);
	} catch (error) {
		failure = { error, stage: closing ? "commit" : stage };
		if (!closing) {
			closing = true;
			try {
				failureEndSeq = session.append("compaction/end", { ...lifecycle, error: errorChainOf(error) })?.seq;
				closed = true;
			} catch (closeError) {
				failure = { error: closeError, stage: "commit" };
			}
		}
		if (error?.failedCompactionTrace !== undefined) failedTrace = error.failedCompactionTrace;
	}
	if (failure !== undefined && failedTrace !== undefined && failureEndSeq !== undefined && options.traceFailedAttempts === true) {
		/* M4-A: this attempt consumed a model stream and landed no `compaction/summary`, which is exactly
		 * the entry positional replay is missing. Record it beside the audit file, anchored to this
		 * attempt's own end seq. Awaiting HERE (before the throw below) is what makes the trace durable
		 * before the caller can react to the failure. */
		try {
			const payload = {
				compactionId: lifecycle.compactionId,
				...(lifecycle.sourceCommandId === undefined ? {} : { sourceCommandId: lifecycle.sourceCommandId }),
				sessionId: String(session.id),
				turn: lifecycle.turn,
				trigger: options.trigger,
				stage: failure.stage,
				endSeq: failureEndSeq,
				error: errorChainOf(failure.error),
				rawOutput: failedTrace.rawOutput,
				...(failedTrace.usage === undefined ? {} : { usage: failedTrace.usage }),
				chunks: failedCompactionChunks(failedTrace),
			};
			if (deps.failedTrace === undefined) throw new Error("no failed-attempt trace sink is composed");
			await deps.failedTrace(payload);
		} catch (error) {
			deps.logger?.warn?.(`context-compact: failed-compaction trace failed: ${String(error)}`);
		}
	}
	if (closed && options.flush !== undefined) {
		try {
			await options.flush();
		} catch (error) {
			flushFailure = error;
		}
	}
	const archiveDetail = archived === undefined
		? { status: "refused" }
		: archived.skipped === true
			? { status: "skipped" }
			: archived.ok === true
				? { status: "ok", locator: archived.locator, bytes: archived.bytes, retrievalHint: archived.retrievalHint }
				: { status: "refused", reason: archived.reason };
	const auditBase = {
		compactionId,
		shadowedRange: { start: selection.start, end: selection.end },
		shadowedSeqs: [...selection.shadowedSeqs],
		archive: archiveDetail,
		...(options.gate === undefined ? {} : { gate: options.gate }),
		...(options.todoHint === undefined ? {} : { todoHint: options.todoHint }),
	};
	if (options.owner === null && signal !== undefined && signal.aborted) {
		/* Cancellation precedence: re-raise the caller's own abort reason — but record the attempt
		 * first, so a cancelled transaction is still auditable. */
		if (failure !== undefined) {
			await audit({ ...auditBase, status: "failed", stage: failure.stage, cancelled: true, error: errorChainOf(failure.error) });
		}
		signal.throwIfAborted();
	}
	if (failure !== undefined) {
		await audit({ ...auditBase, status: "failed", stage: failure.stage, error: errorChainOf(failure.error) });
		/* M4-D: the engine remembers WHICH selection failed and at what surface price. Reported from
		 * here because this is the one place that knows the stage the attempt actually died at, and
		 * contained so a bookkeeping fault can never change the failure the caller sees. */
		try {
			options.onFailure?.(failure.stage);
		} catch (error) {
			deps.logger?.warn?.(`context-compact: failure bookkeeping failed: ${String(error)}`);
		}
		if (options.owner === null) throwManualFailure(failure);
		throw failure.error;
	}
	if (flushFailure !== undefined) {
		await audit({ ...auditBase, status: "failed", stage: "persistence", error: errorChainOf(flushFailure) });
		throw new ManualCompactionError("persistence", "manual compaction durability checkpoint failed", { cause: flushFailure });
	}
	if (result === undefined) throw new Error("compaction committed without a result");
	await audit({
		...auditBase,
		status: "committed",
		shadowedTokenCount: result.shadowedTokenCount,
		summary: {
			provider: summaryFacts.provider,
			model: summaryFacts.model,
			maxTokens: summaryFacts.maxTokens,
			framedTokenCount: summaryFacts.framedSummaryTokenCount,
			...(summaryFacts.usage === undefined ? {} : { usage: summaryFacts.usage }),
		},
		events: { startSeq: result.startSeq, summarySeq: result.summarySeq, endSeq: result.endSeq },
	});
	return result;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorChainOf(error) {
	if (error instanceof Error) {
		const parts = [error.message];
		let cause = error.cause;
		while (cause instanceof Error) {
			parts.push(cause.message);
			cause = cause.cause;
		}
		return parts.join(" <- ");
	}
	return String(error);
}

/**
 * Register the automatic between-step pressure and model-request overflow recovery listeners.
 *
 * Called ONLY when the engine is enabled at load time: with `enabled:false` this plugin registers no
 * listener at all, which is what makes "mechanism off = the current behavior byte-for-byte" true
 * without relying on each handler to remember to return early.
 *
 * @param {{ ctx: object, config: object, compactIfNeeded: Function }} engine
 */
export function registerAutomaticCompaction(engine) {
	const { ctx } = engine;
	const warnOnceTargets = new Set();
	const overflowRetries = new WeakMap();
	const overflowAgents = new WeakMap();
	const logResult = (result, trigger) => {
		ctx.logger.info(`compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
	};
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		if (!signal.aborted) {
			try {
				const result = await engine.compactIfNeeded(agent, "pressure", signal);
				if (result !== null) logResult(result, "step pressure");
			} catch (error) {
				if (error instanceof TargetPressureConfigError) {
					if (warnOnceTargets.has(error.targetKey)) return next();
					warnOnceTargets.add(error.targetKey);
				}
				const message = error instanceof Error ? error.message : String(error);
				ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
			}
		}
		return next();
	});
	ctx.on("agent/status", ({ agent, status }) => {
		if (status === "idle") overflowRetries.delete(agent);
	});
	ctx.on("session/event", (session, event) => {
		if (event.type !== "assistant/message") return;
		const agent = overflowAgents.get(session);
		if (agent !== undefined) overflowRetries.delete(agent);
	});
	ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
		if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
		overflowAgents.set(agent.session, agent);
		const target = routedTarget(agent.session);
		if (target === undefined) return next();
		const policy = engine.policySource.read();
		if (!policy.enabled) return next();
		const retries = overflowRetries.get(agent) ?? 0;
		if (retries >= policy.maxOverflowRetries) return next();
		const generation = agent.session.surface.replaceGeneration;
		let result;
		try {
			result = await engine.compactIfNeeded(agent, "context-overflow", signal);
		} catch (recoveryError) {
			const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
			if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
				ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
				overflowRetries.set(agent, retries + 1);
				return { kind: "retry" };
			}
			ctx.logger.warn(`context-overflow compaction failed: ${message}; ${signal.aborted ? "cancellation prevents retry" : "preserving the original request error"}`);
			return next();
		}
		if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
		if (result !== null) logResult(result, "context overflow recovery");
		overflowRetries.set(agent, retries + 1);
		return { kind: "retry" };
	});
}
