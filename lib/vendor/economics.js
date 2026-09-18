/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * VENDORED — do not restructure. Source: refs/sol-opencode/src/compact/economics.ts
 * (NVIDIA SoL-Pi / sol-opencode, MIT). The ONLY transformation applied is erasure of the
 * TypeScript type layer (type aliases, parameter/return annotations) so the file loads as
 * plain ESM .js; every expression, constant, branch order, and reason string is byte-equivalent
 * to the upstream algorithm. The upstream test file
 * refs/sol-opencode/test/compact-economics.test.ts is ported verbatim (assertions unchanged)
 * to test/economics.test.js.
 *
 * Economic gate for Online Context Compact (docs/phase4-plan.md §0 C3): whether replacing a
 * history span with one summary is worth its own price once prefix-cache invalidation is
 * charged. Phase 4 M1 vendors the algorithm and its unit tests; M2 wires the trigger policy.
 *
 * @module @sol-pi-port/dsh-context-compact/vendor/economics
 */

export const DEFAULT_COMPACTION_ECONOMICS = Object.freeze({
	remainingRequestScale: 1,
	remainingRequestStddevK: 0,
	windowReserveTokens: 16_384,
	firstCompactionRequestScale: 2,
	subsequentCompactionMargin: 1.5,
});

const MINIMUM_VARIANCE_SAMPLES = 3;
const SMALL_SAMPLE_SCALE = 0.5;

export function estimateRemainingRequests(input) {
	const mean =
		input.completedBoundaryRequestCounts.reduce((total, count) => total + count, 0) /
		Math.max(1, input.completedBoundaryRequestCounts.length);
	let lowerBound = mean;
	if (input.standardDeviationK !== 0) {
		if (input.completedBoundaryRequestCounts.length < MINIMUM_VARIANCE_SAMPLES) {
			lowerBound *= SMALL_SAMPLE_SCALE;
		} else {
			const variance = input.completedBoundaryRequestCounts.reduce(
				(total, count) => total + (count - mean) ** 2,
				0,
			);
			const deviation = Math.sqrt(variance / (input.completedBoundaryRequestCounts.length - 1));
			lowerBound = Math.max(0, mean - input.standardDeviationK * deviation);
		}
	}

	const unboundedExpectedRemainingRequests =
		1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);
	const windowRequestUpperBound =
		input.contextWindowTokens === null ||
		input.averageContextTokenIncrement === null ||
		input.averageContextTokenIncrement <= 0
			? null
			: Math.max(
					0,
					Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement),
				);

	return {
		completedBoundaryRequestCounts: [...input.completedBoundaryRequestCounts],
		requestsPerBoundaryMean: mean,
		requestsPerBoundaryLowerBound: lowerBound,
		unboundedExpectedRemainingRequests,
		averageContextTokenIncrement: input.averageContextTokenIncrement,
		windowRequestUpperBound,
		expectedRemainingRequests:
			windowRequestUpperBound === null
				? unboundedExpectedRemainingRequests
				: Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
	};
}

export function decideCompaction(input) {
	const horizon =
		input.completedBoundaryRequestCounts === null
			? null
			: estimateRemainingRequests({
					completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
					remainingBoundaries: input.remainingBoundaries,
					scale: input.economics.remainingRequestScale,
					standardDeviationK: input.economics.remainingRequestStddevK,
					contextTokens: input.contextTokens,
					contextWindowTokens: input.contextWindowTokens,
					averageContextTokenIncrement: input.averageContextTokenIncrement,
				});
	const savingTokens = input.archiveTokens - input.memoTokens;
	const incrementalCacheCostRatio =
		input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1);
	const breakevenRequests =
		savingTokens > 0 && incrementalCacheCostRatio !== null
			? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
			: null;
	const combinedBreakevenRequests =
		savingTokens > 0 && incrementalCacheCostRatio !== null
			? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
			: null;
	const firstCompaction = input.priorCompactionCount === 0;
	const effectiveHorizonRequests =
		horizon === null
			? null
			: firstCompaction
				? Math.min(
						horizon.expectedRemainingRequests * input.economics.firstCompactionRequestScale,
						horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
					)
				: horizon.expectedRemainingRequests;
	const windowProtection =
		input.contextWindowTokens !== null &&
		input.contextTokens >= input.contextWindowTokens - input.economics.windowReserveTokens;
	const baseEconomic =
		horizon !== null &&
		horizon.expectedRemainingRequests > 0 &&
		breakevenRequests !== null &&
		breakevenRequests <= horizon.expectedRemainingRequests;
	const firstEconomic =
		firstCompaction &&
		effectiveHorizonRequests !== null &&
		effectiveHorizonRequests > 0 &&
		breakevenRequests !== null &&
		breakevenRequests <= effectiveHorizonRequests;
	const subsequentMarginOpen =
		!firstCompaction &&
		horizon !== null &&
		breakevenRequests !== null &&
		breakevenRequests * input.economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests;
	const carriedDebtGateOpen =
		!firstCompaction &&
		horizon !== null &&
		combinedBreakevenRequests !== null &&
		combinedBreakevenRequests <= horizon.expectedRemainingRequests;
	const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen;
	const compressible = savingTokens > 0;
	const compact = compressible && (windowProtection || economic);

	return {
		writeTokens: input.writeTokens,
		archiveTokens: input.archiveTokens,
		memoTokens: input.memoTokens,
		contextTokens: input.contextTokens,
		...(horizon ?? {
			completedBoundaryRequestCounts: null,
			requestsPerBoundaryMean: null,
			requestsPerBoundaryLowerBound: null,
			unboundedExpectedRemainingRequests: null,
			averageContextTokenIncrement: input.averageContextTokenIncrement,
			windowRequestUpperBound: null,
			expectedRemainingRequests: null,
		}),
		breakevenRequests,
		combinedBreakevenRequests,
		effectiveHorizonRequests,
		cacheWriteReadRatio: input.cacheWriteReadRatio,
		incrementalCacheCostRatio,
		priorCompactionCount: input.priorCompactionCount,
		carriedDebtTokens: input.carriedDebtTokens,
		cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
		compact,
		reason: !compressible
			? "non_positive_saving"
			: windowProtection
				? "window_protection"
				: economic
					? "economic"
					: horizon === null
						? "horizon_unavailable"
						: breakevenRequests === null
							? "cache_ratio_unavailable"
							: !firstCompaction && baseEconomic && !subsequentMarginOpen
								? "deferred_subsequent_margin"
								: !firstCompaction && baseEconomic && !carriedDebtGateOpen
									? "deferred_carried_debt"
									: "deferred_economic",
	};
}
