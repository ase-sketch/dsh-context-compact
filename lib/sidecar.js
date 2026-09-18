/**
 * Failed-attempt replay sidecar (phase4-m4-plan.md M4-A, docs/phase4-m3-report.md §"方案 B").
 *
 * WHY THIS EXISTS. `llm-replay` reconstructs one model call per recorded stream positionally: an
 * Assistant settlement becomes one entry, and a `compaction/summary` marked `llmStreamCall:true`
 * becomes another. A compaction attempt that CONSUMED the summarizer stream but was then rejected
 * (the summary was not smaller than the shadowed span, the surface moved, the commit failed) lands
 * only `compaction/start` + `compaction/end(error)`. Its stream is gone from the log, so replay
 * derives one entry too few and every later call gets the wrong stream — measured on the M3 compact
 * arm (18 real calls, 17 derivable entries).
 *
 * This sink is the trace that closes that hole. It is written next to the audit file, it carries the
 * consumed stream as a `chunks` sequence structurally identical to the one `deriveReplayScript`
 * builds for a landed summary, and it names the failed attempt's own `compaction/end` seq as the
 * anchor the replay merges it back at. The engine writes it ONLY when the mechanism is enabled AND
 * the summarizer stream was already consumed, so the default-off path keeps its zero-side-effect
 * claim and an archive refusal (which consumes no stream) adds no entry.
 *
 * Same shape as the audit sink: writes are serialized on one promise chain, and a failure is
 * contained with a one-shot warning — a diagnostic trace must never change the compaction outcome.
 *
 * @module @sol-pi-port/dsh-context-compact/sidecar
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Stable schema tag for one sidecar line. */
export const FAILED_COMPACTION_SCHEMA = "sol-pi-port/dsh-context-compact-failed-compaction/1";

/** File name of the sidecar, always a sibling of the configured audit file. */
export const FAILED_COMPACTION_SIDECAR_NAME = "replay-failed-compactions.jsonl";

/**
 * The sidecar path that belongs to one audit path.
 *
 * Colocation is the contract: an audit file and the traces that explain its failed attempts are read
 * together, so a run-level auditPath gets a run-level sidecar and the recording's own directory gets
 * a sidecar a replay can find without any extra configuration.
 *
 * @param {string} auditPath the resolved audit file path
 * @returns {string}
 */
export function failedCompactionSidecarPath(auditPath) {
	return join(dirname(auditPath), FAILED_COMPACTION_SIDECAR_NAME);
}

/**
 * Build the replay entry that stands in for one consumed-but-rejected summarizer stream.
 *
 * The sequence is deliberately IDENTICAL to the one `llm-replay`'s `deriveReplayScript` builds for a
 * landed `compaction/summary` — one `block-start`/`block-end` pair per raw block, the `usage`
 * chunk when the stream carried one, then `finish {kind:"stop"}`. Deriving it here (instead of
 * teaching the replay tool a second shape) is what makes the sidecar a drop-in entry at the anchor.
 *
 * @param {{ rawOutput: readonly object[], usage?: object }} trace the consumed stream
 * @returns {object[]} the `chunks` array of a `{kind:"chunks"}` replay entry
 */
export function failedCompactionChunks(trace) {
	const chunks = [];
	for (const [index, block] of trace.rawOutput.entries()) {
		chunks.push({ type: "block-start", index, blockType: block.type });
		chunks.push({ type: "block-end", index, block });
	}
	if (trace.usage !== undefined) chunks.push({ type: "usage", usage: trace.usage });
	chunks.push({ type: "finish", reason: { kind: "stop" } });
	return chunks;
}

/**
 * Create the append-only failed-attempt trace sink.
 *
 * @param {{ path: string, logger?: { warn: (message: string) => void } }} options
 * @returns {{ path: string, record: (event: object) => Promise<void>, flush: () => Promise<void> }}
 */
export function createFailedCompactionSink({ path, logger }) {
	let tail = Promise.resolve();
	let warned = false;
	const warn = (message) => {
		if (warned) return;
		warned = true;
		try {
			logger?.warn?.(message);
		} catch {
			/* a logging failure must never escape the sink */
		}
	};
	const record = (event) => {
		tail = tail
			.then(async () => {
				await mkdir(dirname(path), { recursive: true });
				const line = JSON.stringify({
					schema: FAILED_COMPACTION_SCHEMA,
					time: new Date().toISOString(),
					...event,
				});
				await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
			})
			.catch((error) => {
				warn(`context-compact: failed-compaction trace write failed for ${path}: ${String(error)}`);
			});
		return tail;
	};
	return { path, record, flush: () => tail };
}
