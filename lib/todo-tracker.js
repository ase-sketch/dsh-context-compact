/**
 * The todo/plan signal (docs/phase4-plan.md §0 C7, design.md §3.4, phase4-m2-plan.md D5).
 *
 * DSH's own plan surface is a whole-list snapshot per call: every `todo` write appends a
 * `todo/write` event carrying the COMPLETE list, entries have no stable id, and the host's `todos`
 * projection is cleared by the next `turn/start` (`@deepseek-ai/dsh-tool-todo`). This module folds
 * exactly that vocabulary into the two facts the economic gate needs and the one hint the range
 * selector may use:
 *
 *   1. `remainingBoundaries` — how many plan steps are still open in the current list.
 *   2. `completedBoundaryRequestCounts` — how many assistant requests were spent between two plan
 *      steps turning `completed`. Empty (not null) once todo data exists but no boundary has closed;
 *      `null` only while the session has NO todo data at all, which is the `horizon_unavailable`
 *      fail-closed reading (phase4-m2-plan.md D4).
 *   3. candidate points `{ content, todoSeq, endSeq }` — a step that TRANSITIONED into `completed`,
 *      anchored to the last surface node at or before the write. This is a HINT ONLY: the range
 *      selector still authorizes every cut through the host's tool-pairing check (D6/C7).
 *
 * The fold is a pure function of `(events, current surface)`, so it is replay-safe and needs no host
 * patch: live appends are fast-forwarded through the `session/event` listener, while a session that
 * was resumed — or one whose replacement-surface log moved under us — is caught up lazily from
 * `session.snapshotEvents()`. No listener is registered while the mechanism is disabled.
 *
 * @module @sol-pi-port/dsh-context-compact/todo-tracker
 */
import { analyzePlanTransition } from "./vendor/plan.js";

/**
 * Map the host's `TodoItem` shape onto the vendored plan-step shape.
 *
 * The host guarantees content is non-empty, already trimmed, and unique within one snapshot, so it
 * is a faithful identity for the vendored algorithm's `id`/`goal` pair; a content edit is therefore
 * a REMOVED entry plus a NEW one, which is exactly what "no stable id" means (M2-G3).
 *
 * @param {readonly { content: string, status: string }[]} todos
 * @returns {{ id: string, goal: string, status: string }[]}
 */
export function toPlanSteps(todos) {
	return todos.map((item) => ({ id: item.content, goal: item.content, status: item.status }));
}

/**
 * The last surface node — in SURFACE ORDER — whose own event seq is at or before `seq`.
 *
 * A backward scan, not a search over sorted seqs: a replacement (the compaction checkpoint) is
 * appended at the END of the log but inserted at the FRONT of the surface, so `surface.nodes` is not
 * seq-monotonic once a compaction has landed. Surface order is the only order that means anything
 * here — it is the order the model sees.
 *
 * @param {{ surface: { nodes: readonly number[] } }} session
 * @param {number} seq
 * @returns {number|null} surface node seq, or null when no visible node predates the anchor
 */
export function surfaceTailAt(session, seq) {
	const nodes = session.surface.nodes;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		if (nodes[index] <= seq) return nodes[index];
	}
	return null;
}

/** A tracker with no folded state: every session starts here and reconstructs from its own log. */
function initialState() {
	return {
		watermark: 0,
		todos: null,
		baseline: null,
		pending: [],
		boundaryCounts: [],
		requestsSinceBoundary: 0,
	};
}

/**
 * Fold ONE event into the tracker state.
 * @param {object} state
 * @param {{ type: string, seq: number, data: object }} event
 * @param {object} session
 */
function applyEvent(state, event, session) {
	switch (event.type) {
		case "turn/start":
		case "session/end-seed": {
			/* The host's own projection clears the plan on `turn/start`; the tracker follows that
			 * semantics exactly (M2-G5/D5). The REQUEST COUNTS are session-level observations and
			 * deliberately survive, because the vendored horizon estimator wants every sample it can
			 * get (it discounts small samples itself). */
			state.todos = null;
			state.baseline = null;
			state.pending = [];
			state.requestsSinceBoundary = 0;
			return;
		}
		case "todo/write": {
			const next = event.data.todos;
			if (state.baseline !== null) {
				const transition = analyzePlanTransition(toPlanSteps(state.baseline), toPlanSteps(next));
				if (transition.completedSteps.length > 0) {
					const count = state.requestsSinceBoundary;
					for (const step of transition.completedSteps) {
						state.boundaryCounts.push(count);
						/* The anchor is stored as the write's own seq and RESOLVED against the live surface at
						 * observation time: "the last node at or before the write" is a fact about the surface,
						 * and a surface replacement between the write and the observation can legitimately move
						 * it. The pairing guard, not this anchor, is what authorizes a cut. */
						state.pending.push({ content: step.id, todoSeq: event.seq });
					}
					state.requestsSinceBoundary = 0;
				}
			}
			state.baseline = next;
			state.todos = next;
			return;
		}
		case "assistant/message": {
			state.requestsSinceBoundary += 1;
			return;
		}
		default: return;
	}
}

/**
 * Fold the todo/plan signal of one session.
 *
 * One instance serves every session the plugin sees (the automatic listeners are per-context), so the
 * folded state is keyed by the session object itself.
 */
export class TodoTracker {
	/** @param {{ logger?: { warn: (message: string) => void } }} [options] */
	constructor(options = {}) {
		this.logger = options.logger;
		this.states = new WeakMap();
	}

	/**
	 * Catch one session's folded state up to its current log, then report the signal.
	 *
	 * @param {object} session
	 * @returns {{ hasTodoData: boolean, remainingBoundaries: number|null, completedBoundaryRequestCounts: readonly number[]|null, candidates: readonly object[] }}
	 */
	observe(session) {
		let state = this.states.get(session);
		if (state === undefined || session.seq < state.watermark) {
			/* A resumed session, or a log whose offsets moved: recompute from the durable log rather
			 * than guess. The fold is cheap and idempotent. */
			state = initialState();
			this.states.set(session, state);
		}
		for (let seq = state.watermark; seq < session.seq; seq += 1) {
			const event = session.eventAt(seq);
			if (event === undefined) continue;
			applyEvent(state, event, session);
		}
		state.watermark = session.seq;
		const hasTodoData = state.todos !== null;
		return {
			hasTodoData,
			remainingBoundaries: hasTodoData ? state.todos.filter((item) => item.status !== "completed").length : null,
			completedBoundaryRequestCounts: hasTodoData ? [...state.boundaryCounts] : null,
			candidates: state.pending.map((candidate) => ({ ...candidate, endSeq: surfaceTailAt(session, candidate.todoSeq) })),
		};
	}

	/**
	 * Drop the standing candidate hints after a compaction moved the surface.
	 *
	 * The gate is evaluated more than once per step, so a mere evaluation must not consume a hint; the
	 * engine calls this only once a compaction actually committed. Dropping them is bookkeeping, not
	 * safety: every anchor is re-resolved against the live surface on the next observation, and the
	 * pairing guard is what authorizes any cut.
	 *
	 * @param {object} session
	 */
	commit(session) {
		const state = this.states.get(session);
		if (state === undefined) return;
		state.pending = [];
	}
}
