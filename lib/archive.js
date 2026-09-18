/**
 * Evidence-preserving archive for the shadowed region (design.md §0 "证据保全", phase4-plan.md §0 C4).
 *
 * INVARIANT — 原文先归档, 归档失败 = 禁止替换: before a compaction may replace a surface range, the
 * EXACT durable events of that range are written to the spill substrate through the host's
 * `ctx.spillStore` seam, and the returned locator is recorded in the audit line. If no `spillStore`
 * is composed, or `saveText` rejects (permissions, ENOSPC, backend down), the engine ends the
 * transaction WITHOUT replacing anything. Silent compaction without an archive is never performed.
 *
 * The archived artifact is one JSONL text: a provenance header line (`schema`, `compactionId`,
 * `sessionId`, the shadowed surface span and its node seqs) followed by one line per shadowed event
 * carrying its `seq`, `type`, and `data` — i.e. the durable text the summary replaces, recoverable
 * byte-for-byte with the session log's own vocabulary. Storage location and naming are the spill
 * backend's business (the same directory convention the ObservationPack phase reuses); the locator
 * is opaque and only ever rendered through the backend's own retrieval hint.
 *
 * @module @sol-pi-port/dsh-context-compact/archive
 */

/** Stable schema tag for the provenance header line. */
export const ARCHIVE_SCHEMA = "sol-pi-port/dsh-context-compact-archive/1";

/**
 * Serialize one shadowed surface span as the archive text.
 *
 * @param {{ session: object, compactionId: string, start: number, end: number, shadowedSeqs: readonly number[] }} input
 * @returns {string} JSONL text, one event per line, in surface order.
 */
export function serializeShadowedRegion({ session, compactionId, start, end, shadowedSeqs }) {
	const header = {
		schema: ARCHIVE_SCHEMA,
		compactionId,
		sessionId: String(session.id),
		shadowedRange: { start, end },
		shadowedSeqs: [...shadowedSeqs],
	};
	const lines = [JSON.stringify(header)];
	for (const seq of shadowedSeqs) {
		const event = session.eventAt(seq);
		if (event === undefined) throw new Error(`context-compact: archive cannot read surface node ${seq} (missing from the session log)`);
		lines.push(JSON.stringify({ seq: event.seq, type: event.type, data: event.data }));
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Archive one validated shadowed span through the host spill seam.
 *
 * Never throws: the caller decides what a refusal means, but the only correct caller behavior is to
 * abandon the transaction before it replaces anything.
 *
 * @param {{ getSpillStore: () => object|undefined, logger?: { warn: (message: string) => void } }} deps
 * @param {{ session: object, compactionId: string, start: number, end: number, shadowedSeqs: readonly number[] }} input
 * @returns {Promise<{ ok: true, locator: string, bytes: number, retrievalHint: string, content: string } | { ok: false, reason: string }>}
 */
export async function archiveShadowedRegion(deps, input) {
	const store = deps.getSpillStore();
	if (store === undefined) {
		return { ok: false, reason: "no spillStore is composed; evidence preservation forbids replacing history that cannot be archived" };
	}
	let content;
	try {
		content = serializeShadowedRegion(input);
	} catch (error) {
		return { ok: false, reason: `the shadowed region could not be serialized: ${String(error)}` };
	}
	try {
		const ref = await store.saveText({
			owner: { sessionId: input.session.id },
			source: {
				kind: "session-reference",
				sessionId: input.session.id,
				label: `compaction ${input.compactionId}`,
			},
			suggestedName: `compaction-${input.compactionId}.jsonl`,
			content,
		});
		return {
			ok: true,
			locator: String(ref.locator),
			bytes: typeof ref.bytes === "number" ? ref.bytes : Buffer.byteLength(content, "utf8"),
			retrievalHint: typeof ref.retrievalHint === "string" ? ref.retrievalHint : "",
			content,
		};
	} catch (error) {
		return { ok: false, reason: `the spill backend rejected the archive write: ${String(error)}` };
	}
}
