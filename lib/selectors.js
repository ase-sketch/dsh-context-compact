/**
 * Surface range selection and validation.
 *
 * Range selection is PAIRING-FIRST: the only safety rule that decides a cut is the tool-call/result
 * balance of the current surface, checked with the host's own exported
 * `toolPairingBalancedBefore/After` (docs/phase4-plan.md §0 C2). A todo/write candidate hint may
 * narrow the search (M2) but can never authorize an unbalanced cut.
 *
 * The selection algorithm below is a faithful port of `compaction-basic`'s
 * `selectCompactableRange`/`validateSurfaceRegion` (dsh-compaction-basic/lib/index.js:393-549): keep a
 * priced recent tail, never start the range on the `system/message` holding surface node 0, and
 * walk the start boundary back until the cut before it is balanced.
 *
 * @module @sol-pi-port/dsh-context-compact/selectors
 */
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";

/**
 * The `system/message` holding surface node 0, or undefined when another message-producing event
 * starts the surface.
 * @param {{ eventAt: (seq: number) => object|undefined }} session
 * @param {number} headSeq
 * @returns {object|undefined}
 */
export function systemHead(session, headSeq) {
	const head = session.eventAt(headSeq);
	return head !== undefined && head.type === "system/message" ? head : undefined;
}

/**
 * Validate one requested surface-position span before asynchronous work begins.
 *
 * @param {object} session session whose current surface is authoritative
 * @param {number} start inclusive first surface-node seq
 * @param {number} end inclusive last surface-node seq
 * @returns {{ start: number, end: number, startIdx: number, endIdx: number, shadowedSeqs: number[] }}
 * @throws when a seq is absent from the surface, the pair is reversed, or either edge is unbalanced
 */
export function validateSurfaceRegion(session, start, end) {
	const nodes = session.surface.nodes;
	const startIdx = nodes.indexOf(start);
	const endIdx = nodes.indexOf(end);
	if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
	if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
	if (startIdx > endIdx) {
		throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`);
	}
	if (!toolPairingBalancedBefore(session, nodes[startIdx])) {
		throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`);
	}
	if (!toolPairingBalancedAfter(session, nodes[endIdx])) {
		throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`);
	}
	return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}

/**
 * Resolve the next range starting at the first non-system surface node while retaining a priced
 * recent tail and never splitting an assistant tool-call/result pair.
 *
 * @param {object} session session supplying authoritative current surface positions
 * @param {{ nodes: readonly { seq: number, tokens: number, heuristicTokens: number }[] }} measurement
 *   unified pressure and surface measurement from `ctx.tokenMeter.measure()`
 * @param {number} retainTokens minimum recent tail budget retained verbatim
 * @returns {{ start: number, end: number } | null}
 */
export function selectCompactableRange(session, measurement, retainTokens) {
	const pricedNodes = measurement.nodes;
	if (pricedNodes.length === 0) return null;
	const surfaceNodes = session.surface.nodes;
	if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
		throw new Error("compaction: token-meter surface does not match the current session surface");
	}
	const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1;
	let accumulated = 0;
	let keepFromIdx = pricedNodes.length;
	for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
		accumulated += pricedNodes[index].tokens;
		keepFromIdx = index;
		if (accumulated >= retainTokens) break;
	}
	if (keepFromIdx <= firstIdx) return null;
	while (keepFromIdx > firstIdx) {
		if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
		keepFromIdx -= 1;
	}
	if (keepFromIdx <= firstIdx) return null;
	return {
		start: surfaceNodes[firstIdx],
		end: surfaceNodes[keepFromIdx - 1],
	};
}

/**
 * Align a selected range's END to a todo boundary, when — and only when — the host's own pairing check
 * authorizes it (docs/phase4-plan.md §0 C7 "信号仅作提示，范围选择以配对检查为准", phase4-m2-plan.md D6).
 *
 * Alignment can only ever move the cut EARLIER than the retained priced tail, so it never removes more
 * verbatim history than the tail rule already allowed. A hint outside the range, a hint that is not a
 * surface node, or a hint whose preceding cut would split a tool-call/result pair is ignored: the
 * caller then keeps the unaligned range byte-for-byte.
 *
 * @param {object} session session supplying the authoritative surface
 * @param {{ start: number, end: number }} range range chosen by `selectCompactableRange`
 * @param {number|null|undefined} hintSeq candidate boundary surface-node seq
 * @returns {{ start: number, end: number }} the aligned range, or `range` itself when nothing is aligned
 */
export function alignRangeToHint(session, range, hintSeq) {
	if (hintSeq === null || hintSeq === undefined) return range;
	const nodes = session.surface.nodes;
	const startIdx = nodes.indexOf(range.start);
	const endIdx = nodes.indexOf(range.end);
	const hintIdx = nodes.indexOf(hintSeq);
	if (startIdx === -1 || endIdx === -1 || hintIdx === -1) return range;
	/* The hint must be a strict interior cut: at or before the range end (otherwise it is outside the
	 * compactable span and carries no information) and after the start (an empty span is not a cut). */
	if (hintIdx <= startIdx || hintIdx > endIdx) return range;
	if (!toolPairingBalancedBefore(session, nodes[startIdx])) return range;
	if (!toolPairingBalancedAfter(session, nodes[hintIdx])) return range;
	return { start: nodes[startIdx], end: nodes[hintIdx] };
}
