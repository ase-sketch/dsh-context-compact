/**
 * Audit sink (phase4-plan.md §0 C4, design.md §0.5 "全程可审计").
 *
 * One JSONL line per compaction ATTEMPT and per economic-gate evaluation. The official
 * `compaction/start|summary|end` events already land in `session.jsonl` and are the replay-visible
 * record; this sink carries what those events cannot: the archive locator that makes the compacted
 * `原文` recoverable, the archive verdict (including `archived:false` on a fail-closed refusal), the
 * selected range and its pricing, and the economic gate's decision detail (`saving/cost` inputs and
 * the vendored algorithm's reason code). There is NO switch that turns auditing off while the
 * mechanism is on, so an enabled engine is always auditable.
 *
 * Same shape as the earlier sol-pi-port sinks: writes are serialized on one promise chain so lines
 * never interleave, and every failure is contained with a one-shot warning — auditing must never
 * change the compaction outcome it observes.
 *
 * @module @sol-pi-port/dsh-context-compact/audit
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Stable schema tag for one audit line. */
export const AUDIT_SCHEMA = "sol-pi-port/dsh-context-compact-audit/1";

/**
 * Default audit file, under the host state root.
 * @param {string} [dshHome]
 * @returns {string}
 */
export function defaultAuditPath(dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh")) {
	return join(dshHome, "state", "context-compact", "context-compact-audit.jsonl");
}

/**
 * Create the append-only audit sink.
 *
 * `record` returns the chain tail: the caller may await it to know the line settled (the plugin
 * does exactly that before a compaction transaction returns, so an audit line is never racing the
 * result it documents). It never rejects — every failure is contained with one warning.
 *
 * @param {{ path: string, logger?: { warn: (message: string) => void } }} options
 * @returns {{ path: string, record: (event: object) => Promise<void>, flush: () => Promise<void> }}
 */
export function createAuditSink({ path, logger }) {
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
					schema: AUDIT_SCHEMA,
					time: new Date().toISOString(),
					...event,
				});
				await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
			})
			.catch((error) => {
				warn(`context-compact: audit write failed for ${path}: ${String(error)}`);
			});
		return tail;
	};
	return { path, record, flush: () => tail };
}
