/**
 * The `efficiency-context-compact` settings namespace (docs/phase4-plan.md §5, preflight Q3 frozen
 * key set).
 *
 * Composition: schemastery defaults -> the plugin's composition entry (`config:` in
 * `cordis.patch.yml`) -> the user layer (`$DSH_HOME/settings.yaml`). The composition entry is never
 * a second authority: it is the `base` layer and the fallback source when no settings provider is
 * composed (same shape as `@sol-pi-port/dsh-spill-cas/lib/settings.js`).
 *
 * Defaults are the frozen conservative ones: `enabled` is FALSE — the engine registers no
 * automatic listener at all and `compactIfNeeded` returns `null` before touching the session
 * (docs/phase4-plan.md §5, preflight Q1 verdict shape A). `compactNow` stays fully functional so
 * replacing `compaction-basic` cannot turn the human `/compact` command into a dead command (a
 * capability regression), and the economic gate starts closed.
 *
 * `enabled` is a LOAD-TIME switch: the automatic listeners are registered only when it reads true
 * at apply time. Every other knob is re-read per call, so an evaluation arm can flip thresholds
 * live without reloading. Enabling the engine from `settings.yaml` therefore takes effect on the
 * next start — the same known behavior the spill-cas plugin documents for its tool registration.
 *
 * @module @sol-pi-port/dsh-context-compact/settings
 */
import z from "@deepseek-ai/schemastery";
import { DEFAULT_COMPACTION_ECONOMICS } from "./vendor/economics.js";

/** Namespace owned by this plugin. */
export const CONTEXT_COMPACT_NAMESPACE = "efficiency-context-compact";

/** Default request-pressure fraction of the routed model's context window. */
export const DEFAULT_THRESHOLD_RATIO = 0.8;
/** Default verbatim-tail fraction kept outside the compacted range. */
export const DEFAULT_RETAIN_RATIO = 0.16;
/** Default summarization generation cap. */
export const DEFAULT_MAX_TOKENS = 8192;
/** Default same-trigger compaction attempts after the first one. */
export const DEFAULT_COMPACTION_RETRIES = 1;
/** Default context-overflow recovery retry budget per agent activity. */
export const DEFAULT_MAX_OVERFLOW_RETRIES = 1;

/** The `efficiency-context-compact` section. */
export const ContextCompactSchema = z.object({
	enabled: z.boolean().default(false),
	thresholdRatio: z.number().default(DEFAULT_THRESHOLD_RATIO),
	retainRatio: z.number().default(DEFAULT_RETAIN_RATIO),
	summarizationProvider: z.string().default(""),
	summarizationModel: z.string().default(""),
	maxTokens: z.natural().default(DEFAULT_MAX_TOKENS),
	compactionRetries: z.natural().default(DEFAULT_COMPACTION_RETRIES),
	maxOverflowRetries: z.natural().default(DEFAULT_MAX_OVERFLOW_RETRIES),
	archive: z.boolean().default(true),
	auditPath: z.string(),
	economics: z.object({
		enabled: z.boolean().default(false),
		remainingRequestScale: z.number().default(DEFAULT_COMPACTION_ECONOMICS.remainingRequestScale),
		windowReserveTokens: z.natural().default(DEFAULT_COMPACTION_ECONOMICS.windowReserveTokens),
		firstCompactionRequestScale: z.number().default(DEFAULT_COMPACTION_ECONOMICS.firstCompactionRequestScale),
		subsequentCompactionMargin: z.number().default(DEFAULT_COMPACTION_ECONOMICS.subsequentCompactionMargin),
		cacheWriteReadRatio: z.number(),
	}),
});

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function ratio(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInteger(value, fallback) {
	return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Normalize a resolved section into the policy the engine consumes.
 *
 * Tolerant on purpose: a malformed section normalizes to the safe (fully disabled) policy rather
 * than throwing, mirroring `resolvePolicy` in the earlier sol-pi-port plugins.
 *
 * `retainRatio` is clamped below `thresholdRatio` so a misconfigured section can never produce an
 * empty compactable range.
 *
 * @param {unknown} section
 * @returns {{ enabled: boolean, thresholdRatio: number, retainRatio: number, summarizationProvider: string, summarizationModel: string, maxTokens: number, compactionRetries: number, maxOverflowRetries: number, archive: boolean, auditPath: string|undefined, economics: { enabled: boolean, remainingRequestScale: number, windowReserveTokens: number, firstCompactionRequestScale: number, subsequentCompactionMargin: number, cacheWriteReadRatio: number|null } }}
 */
export function resolvePolicy(section) {
	const value = section === null || typeof section !== "object" ? {} : section;
	const economics = value.economics === null || typeof value.economics !== "object" ? {} : value.economics;
	const threshold = ratio(value.thresholdRatio, DEFAULT_THRESHOLD_RATIO);
	const retain = ratio(value.retainRatio, DEFAULT_RETAIN_RATIO);
	return {
		enabled: value.enabled === true,
		thresholdRatio: threshold,
		retainRatio: retain < threshold ? retain : DEFAULT_RETAIN_RATIO,
		summarizationProvider: nonEmptyString(value.summarizationProvider) ?? "",
		summarizationModel: nonEmptyString(value.summarizationModel) ?? "",
		maxTokens: positiveInteger(value.maxTokens, DEFAULT_MAX_TOKENS),
		compactionRetries: nonNegativeInteger(value.compactionRetries, DEFAULT_COMPACTION_RETRIES),
		maxOverflowRetries: nonNegativeInteger(value.maxOverflowRetries, DEFAULT_MAX_OVERFLOW_RETRIES),
		archive: value.archive !== false,
		auditPath: nonEmptyString(value.auditPath),
		economics: {
			enabled: economics.enabled === true,
			remainingRequestScale: typeof economics.remainingRequestScale === "number"
				? economics.remainingRequestScale
				: DEFAULT_COMPACTION_ECONOMICS.remainingRequestScale,
			windowReserveTokens: nonNegativeInteger(
				economics.windowReserveTokens,
				DEFAULT_COMPACTION_ECONOMICS.windowReserveTokens,
			),
			firstCompactionRequestScale: typeof economics.firstCompactionRequestScale === "number"
				? economics.firstCompactionRequestScale
				: DEFAULT_COMPACTION_ECONOMICS.firstCompactionRequestScale,
			subsequentCompactionMargin: typeof economics.subsequentCompactionMargin === "number"
				? economics.subsequentCompactionMargin
				: DEFAULT_COMPACTION_ECONOMICS.subsequentCompactionMargin,
			cacheWriteReadRatio: typeof economics.cacheWriteReadRatio === "number" ? economics.cacheWriteReadRatio : null,
		},
	};
}

/**
 * Attach the namespace to the settings provider when one is composed, and always expose a reader.
 * A registration failure (including the duplicate-namespace rejection) is contained: the plugin
 * warns and keeps working from its composition entry, so a namespace clash can never take the
 * profile down.
 *
 * @param {{ get?: (name: string) => unknown }} ctx
 * @param {unknown} entryConfig the plugin's composition `config`
 * @param {{ warn: (message: string) => void, info?: (message: string) => void }} logger
 * @returns {{ scope: object|undefined, read: () => object, registered: boolean, describe: () => string }}
 */
export function createPolicySource(ctx, entryConfig, logger) {
	const base = entryConfig === undefined || entryConfig === null ? {} : entryConfig;
	let scope;
	const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
	if (settings !== undefined && settings !== null && typeof settings.register === "function") {
		try {
			scope = settings.register(CONTEXT_COMPACT_NAMESPACE, ContextCompactSchema, { base, applies: "live" });
		} catch (error) {
			logger.warn(`context-compact: could not register the "${CONTEXT_COMPACT_NAMESPACE}" settings namespace (${String(error)}); falling back to the composition entry only`);
		}
	}
	const read = () => {
		if (scope !== undefined) return resolvePolicy(scope.get());
		try {
			return resolvePolicy(ContextCompactSchema(base));
		} catch (error) {
			logger.warn(`context-compact: composition entry is not a valid "${CONTEXT_COMPACT_NAMESPACE}" section (${String(error)}); treating the mechanism as disabled`);
			return resolvePolicy({});
		}
	};
	return {
		scope,
		read,
		registered: scope !== undefined,
		describe: () => (scope !== undefined ? `settings namespace "${CONTEXT_COMPACT_NAMESPACE}"` : "composition entry (no settings provider)"),
	};
}
