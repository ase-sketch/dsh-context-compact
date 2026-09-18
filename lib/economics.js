/**
 * Economic-gate adapter (docs/phase4-plan.md §0 C3, design.md §3.4).
 *
 * 节省 = Σ(被压节点 token) × (后续每步读取成本差) × 预计剩余步数
 * 成本 = 压缩调用定价 + 前缀重写的 cacheWrite 成本
 * 触发 = 节省 > 成本 × 安全边际; pricing 缺失 -> 门控关闭且日志明示 (绝不折算为 0)
 *
 * This module is ONLY the mapping layer between the host's own measurement vocabulary and the
 * vendored upstream algorithm (`vendor/economics.js`). It does not decide when to run; the engine
 * asks it, and every answer it returns is written to the audit line so a run's gate outcome is
 * reconstructable from `context-compact-audit.jsonl`.
 *
 * The three host facts that feed the vendor inputs are all taken from live services, never invented:
 *   - `archiveTokens`  = the route-priced token price of the nodes the replacement removes
 *                         (`ctx.tokenMeter.measure(session)` -> `nodes[*].tokens` sum over the span)
 *   - `memoTokens`     = the same meter's price of the framed checkpoint message that takes their
 *                         place (`meter.estimateMessage(checkpointMessage)`)
 *   - `contextTokens`  = `measurement.totalTokens`
 *   - `writeTokens`    = the summarization call's own input price (its cache-write cost), supplied by
 *                         the caller from the summarization envelope
 * `cacheWriteReadRatio` comes from configuration. `null` means "no cache pricing is known" and the
 * vendored algorithm then answers `cache_ratio_unavailable` with `compact:false` — the fail-closed
 * reading of "pricing 缺失 -> 门控关闭": an unknown price never authorizes a rewrite.
 *
 * @module @sol-pi-port/dsh-context-compact/economics
 */
import { DEFAULT_COMPACTION_ECONOMICS, decideCompaction } from "./vendor/economics.js";

/**
 * Resolve the vendored economics constants, applying the configured overrides.
 * @param {{ remainingRequestScale: number, windowReserveTokens: number, firstCompactionRequestScale: number, subsequentCompactionMargin: number }} policyEconomics
 * @returns {object} frozen value the vendored algorithm accepts as `economics`
 */
export function resolveGateEconomics(policyEconomics) {
	return Object.freeze({
		...DEFAULT_COMPACTION_ECONOMICS,
		remainingRequestScale: policyEconomics.remainingRequestScale,
		windowReserveTokens: policyEconomics.windowReserveTokens,
		firstCompactionRequestScale: policyEconomics.firstCompactionRequestScale,
		subsequentCompactionMargin: policyEconomics.subsequentCompactionMargin,
	});
}

/**
 * Price one shadowed span from the meter's own per-node prices.
 * @param {{ nodes: readonly { seq: number, tokens: number }[] }} measurement
 * @param {readonly number[]} shadowedSeqs
 * @returns {number} route-priced tokens of the span
 */
export function priceShadowedSpan(measurement, shadowedSeqs) {
	const bySeq = new Map(measurement.nodes.map((node) => [node.seq, node.tokens]));
	let total = 0;
	for (const seq of shadowedSeqs) {
		const price = bySeq.get(seq);
		if (price === undefined) throw new Error(`economics: node ${seq} is not present in the measurement`);
		total += price;
	}
	return total;
}

/**
 * The incremental price of one cache-write relative to a cache-read, in the vendored algorithm's own
 * vocabulary: `max(0, cacheWriteReadRatio - 1)`. A writing step already pays a read-sized price for
 * the same tokens, so only the EXCESS is the cost of rewriting the prefix (design.md §7.2 risk 3).
 *
 * @param {number|null|undefined} cacheWriteReadRatio configured ratio of write to read price
 * @returns {number|null} null when no cache pricing is known (the gate's fail-closed input)
 */
export function incrementalCacheCostRatio(cacheWriteReadRatio) {
	return typeof cacheWriteReadRatio === "number" ? Math.max(0, cacheWriteReadRatio - 1) : null;
}

/**
 * Per-session carried cache-write debt (phase4-m2-plan.md D3).
 *
 * Every committed compaction rewrites the conversation prefix, and that rewrite is a cost the next
 * evaluation only recovers as the conversation moves on: each step retires a slice of it equal to
 * the saving that compaction produces per step. Until it is retired, the debt keeps a later
 * compaction from passing its own breakeven test (the vendored `carriedDebtGateOpen`).
 *
 * The state is deliberately IN-MEMORY and per session: debt describes the live prefix, and a
 * restarted process has no live prefix to amortize against. The audit line records the exact values
 * each decision used, so the model stays reconstructable across a restart.
 */
export class CompactionDebtLedger {
	constructor() {
		this.sessions = new WeakMap();
	}

	/**
	 * Rebuild one session's debt from its durable log (phase4-m4-plan.md M4-B).
	 *
	 * The state is in-memory by design (debt describes the LIVE prefix), but that made it
	 * unreconstructable after a restart: a fresh process started every session at zero while the
	 * audit line still showed the values the original process used. Every committed, charged
	 * compaction now carries the exact record it charged on its `compaction/summary` event, so the
	 * log alone replays the ledger.
	 *
	 * Uncharged commits (`charged:false`, the gate-off path) are SKIPPED rather than charged with
	 * zeroes: `charge` retires the previous step's saving slice on every call, so replaying a no-op
	 * through it would advance the retirement schedule and diverge from the live state.
	 *
	 * @param {object} session the session whose state is replaced
	 * @param {readonly { type: string, data?: object }[]} events the durable log, in order
	 * @returns {number} how many charged compactions were replayed
	 */
	rebuild(session, events) {
		this.sessions.delete(session);
		let replayed = 0;
		for (const event of events) {
			if (event?.type !== "compaction/summary") continue;
			const charge = event.data?.charge;
			if (charge?.charged !== true) continue;
			this.charge(session, {
				writeTokens: charge.writeTokens,
				savingTokens: charge.savingTokens,
				cacheWriteReadRatio: charge.cacheWriteReadRatio,
			});
			replayed += 1;
		}
		return replayed;
	}

	/**
	 * Project the debt without changing it: what the next decision must carry and repay.
	 *
	 * Read-only on purpose — a gate is evaluated more than once per step, and a projection that
	 * mutated state would make the second evaluation of the same step disagree with the first.
	 *
	 * @param {object} session
	 * @returns {{ carriedDebtTokens: number, cacheDebtRepaymentTokens: number }} the debt left after
	 *   this step's retirement, under the vendor's own input names so a caller can spread it straight
	 *   into a gate evaluation.
	 */
	pending(session) {
		const state = this.sessions.get(session);
		if (state === undefined) return { carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0 };
		const cacheDebtRepaymentTokens = Math.min(state.tokens, state.savingPerStep);
		return { carriedDebtTokens: state.tokens - cacheDebtRepaymentTokens, cacheDebtRepaymentTokens };
	}

	/**
	 * Charge one committed compaction's cache-write debt after retiring this step's slice.
	 *
	 * @param {object} session
	 * @param {{ writeTokens: number, savingTokens: number, cacheWriteReadRatio?: number|null }} committed
	 */
	charge(session, { writeTokens, savingTokens, cacheWriteReadRatio }) {
		const prior = this.sessions.get(session) ?? { tokens: 0, savingPerStep: 0 };
		const repaymentTokens = Math.min(prior.tokens, prior.savingPerStep);
		const ratio = incrementalCacheCostRatio(cacheWriteReadRatio);
		const costTokens = ratio === null ? 0 : writeTokens * ratio;
		this.sessions.set(session, { tokens: prior.tokens - repaymentTokens + costTokens, savingPerStep: Math.max(0, savingTokens) });
	}

	/**
	 * Drop one session's debt (a session-scoped reset, e.g. for a caller that re-seeds a prefix).
	 * @param {object} session
	 */
	clear(session) {
		this.sessions.delete(session);
	}
}

/**
 * Run the vendored economic decision for one candidate compaction.
 *
 * @param {object} input
 * @param {object} input.policy resolved `efficiency-context-compact` policy
 * @param {object} input.measurement `ctx.tokenMeter.measure(session)`
 * @param {readonly number[]} input.shadowedSeqs the span the replacement would remove
 * @param {number} input.memoTokens meter price of the framed replacement message
 * @param {number|null} input.contextWindowTokens routed model context window, when known
 * @param {number} input.writeTokens summarization call's own input price
 * @param {number} input.priorCompactionCount compactions already committed on this session
 * @param {number} input.carriedDebtTokens cache-write debt still unamortized from earlier compactions
 * @param {number} input.cacheDebtRepaymentTokens the slice of that debt this step retires
 * @param {number} input.remainingBoundaries todo boundaries still open (M2 supplies the real count)
 * @param {number|null} input.averageContextTokenIncrement observed per-step context growth
 * @param {readonly number[]|null} input.completedBoundaryRequestCounts observed requests per boundary
 * @returns {object} the vendored decision, verbatim
 */
export function evaluateGate(input) {
	return decideCompaction({
		writeTokens: input.writeTokens,
		archiveTokens: priceShadowedSpan(input.measurement, input.shadowedSeqs),
		memoTokens: input.memoTokens,
		contextTokens: input.measurement.totalTokens,
		completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
		remainingBoundaries: input.remainingBoundaries,
		averageContextTokenIncrement: input.averageContextTokenIncrement,
		contextWindowTokens: input.contextWindowTokens,
		priorCompactionCount: input.priorCompactionCount,
		carriedDebtTokens: input.carriedDebtTokens,
		cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens ?? 0,
		cacheWriteReadRatio: input.policy.economics.cacheWriteReadRatio,
		economics: resolveGateEconomics(input.policy.economics),
	});
}
