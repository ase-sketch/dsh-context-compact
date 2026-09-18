/**
 * The todo/plan signal fold (phase4-m2-plan.md D5, M2-G3).
 *
 * The tracker is exercised over REAL sessions: `todo/write` is the host's own event, the surface
 * positions it anchors to are the host's own fold, and `turn/start` is the host's own clearing
 * semantics. No listener, no LLM, no network.
 *
 * @module @sol-pi-port/dsh-context-compact/test/todo-tracker
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TodoTracker, surfaceTailAt, toPlanSteps } from "../lib/todo-tracker.js";
import { appendSystem, appendTodo, appendToolStep, appendUser, newSession, startTurn } from "./helpers.js";

describe("todo tracker", () => {
	it("maps host todo entries onto plan steps using content as the identity", () => {
		assert.deepEqual(toPlanSteps([{ content: "build the parser", status: "in_progress" }]), [
			{ id: "build the parser", goal: "build the parser", status: "in_progress" },
		]);
		assert.deepEqual(toPlanSteps([]), []);
	});

	it("reports no todo data (and therefore no horizon) before the first write", () => {
		const session = newSession("todo-none");
		appendSystem(session);
		appendUser(session, "hello");
		const signal = new TodoTracker().observe(session);
		assert.equal(signal.hasTodoData, false);
		assert.equal(signal.remainingBoundaries, null);
		assert.equal(signal.completedBoundaryRequestCounts, null, "no todo data is the horizon_unavailable reading (D4)");
		assert.deepEqual(signal.candidates, []);
	});

	it("counts the open steps of the latest whole-list snapshot", () => {
		const session = newSession("todo-open");
		appendSystem(session);
		appendTodo(session, [
			{ content: "alpha", status: "completed" },
			{ content: "beta", status: "in_progress" },
			{ content: "gamma", status: "pending" },
		]);
		const signal = new TodoTracker().observe(session);
		assert.equal(signal.remainingBoundaries, 2, "remainingBoundaries = pending + in_progress");
		assert.deepEqual(signal.completedBoundaryRequestCounts, [], "todo data exists, so the horizon input is an empty array, never null");
	});

	it("detects a completed transition, anchors it to the surface tail, and counts its requests", () => {
		const session = newSession("todo-transition");
		appendSystem(session);
		appendTodo(session, [
			{ content: "alpha", status: "in_progress" },
			{ content: "beta", status: "pending" },
		]);
		appendUser(session, "start with alpha");
		const { assistant, toolResult } = appendToolStep(session, { callId: "call-0" });
		const write = appendTodo(session, [
			{ content: "alpha", status: "completed" },
			{ content: "beta", status: "pending" },
		]);
		const signal = new TodoTracker().observe(session);
		assert.deepEqual(signal.candidates, [{ content: "alpha", todoSeq: write.seq, endSeq: toolResult.seq }]);
		assert.equal(signal.candidates[0].endSeq, surfaceTailAt(session, write.seq));
		assert.deepEqual(signal.completedBoundaryRequestCounts, [1], "one assistant request was spent on the completed step");
		assert.equal(signal.remainingBoundaries, 1);
		assert.ok(session.surface.nodes.includes(assistant.seq) && session.surface.nodes.includes(toolResult.seq));
	});

	it("keeps one request count per closed boundary, in order", () => {
		const session = newSession("todo-two-boundaries");
		appendSystem(session);
		appendTodo(session, [
			{ content: "alpha", status: "in_progress" },
			{ content: "beta", status: "pending" },
		]);
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [
			{ content: "alpha", status: "completed" },
			{ content: "beta", status: "in_progress" },
		]);
		appendToolStep(session, { callId: "call-1" });
		appendToolStep(session, { callId: "call-2" });
		appendTodo(session, [
			{ content: "alpha", status: "completed" },
			{ content: "beta", status: "completed" },
		]);
		const signal = new TodoTracker().observe(session);
		assert.deepEqual(signal.completedBoundaryRequestCounts, [1, 2], "requests accrued since the previous boundary");
		assert.deepEqual(signal.candidates.map((candidate) => candidate.content), ["alpha", "beta"]);
		assert.equal(signal.remainingBoundaries, 0);
	});

	it("does not report a boundary that is merely rewritten as still completed", () => {
		const session = newSession("todo-idempotent");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }]);
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [{ content: "alpha", status: "completed" }]);
		const tracker = new TodoTracker();
		assert.equal(tracker.observe(session).candidates.length, 1);
		appendToolStep(session, { callId: "call-1" });
		appendTodo(session, [{ content: "alpha", status: "completed" }]);
		const second = tracker.observe(session);
		assert.equal(second.candidates.length, 1, "a re-stated completed entry is not a new transition (vendor analyzePlanTransition)");
		assert.deepEqual(second.completedBoundaryRequestCounts, [1], "no second boundary was counted");
	});

	it("treats a content change as one removed and one new entry", () => {
		const session = newSession("todo-rename");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }]);
		appendTodo(session, [{ content: "alpha (renamed)", status: "in_progress" }]);
		const signal = new TodoTracker().observe(session);
		assert.deepEqual(signal.candidates, [], "entries carry no stable id: a rename is not a completion");
		assert.equal(signal.remainingBoundaries, 1, "the new content is an open entry of the new list");
		assert.deepEqual(signal.completedBoundaryRequestCounts, []);
	});

	it("clears the plan on turn/start and returns to the no-todo-data state", () => {
		const session = newSession("todo-cleared");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }]);
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [{ content: "alpha", status: "completed" }]);
		const tracker = new TodoTracker();
		assert.equal(tracker.observe(session).hasTodoData, true);
		startTurn(session, 2);
		const cleared = tracker.observe(session);
		assert.equal(cleared.hasTodoData, false);
		assert.equal(cleared.remainingBoundaries, null);
		assert.equal(cleared.completedBoundaryRequestCounts, null, "the cleared projection means no horizon data again");
		assert.deepEqual(cleared.candidates, []);

		/* The plan is cleared, the OBSERVATIONS are not: the boundary request counts are session-level
		 * samples the vendored horizon estimator wants to keep (it discounts small samples itself). */
		appendTodo(session, [{ content: "delta", status: "in_progress" }, { content: "beta", status: "completed" }]);
		const afterClear = tracker.observe(session);
		assert.deepEqual(afterClear.completedBoundaryRequestCounts, [1], "the earlier observation survives turn/start");
		assert.deepEqual(afterClear.candidates, [], "the first list of a turn has no predecessor, so it states no transition");
		assert.equal(afterClear.remainingBoundaries, 1);
	});

	it("catches up lazily from the durable log for a session it has never folded", () => {
		const session = newSession("todo-resume");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }]);
		appendToolStep(session, { callId: "call-0" });
		const write = appendTodo(session, [{ content: "alpha", status: "completed" }]);
		/* The live tracker saw none of the above: this is the resumed-session path. */
		const resumed = new TodoTracker().observe(session);
		assert.deepEqual(resumed.candidates, [{ content: "alpha", todoSeq: write.seq, endSeq: surfaceTailAt(session, write.seq) }]);
		assert.deepEqual(resumed.completedBoundaryRequestCounts, [1]);
	});

	it("keeps a session it has already folded on the fast path", () => {
		const session = newSession("todo-fast-path");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }]);
		const tracker = new TodoTracker();
		tracker.observe(session);
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [{ content: "alpha", status: "completed" }]);
		assert.deepEqual(tracker.observe(session).completedBoundaryRequestCounts, [1]);
	});

	it("re-folds from scratch when the session log moved backwards", () => {
		const events = [
			{ type: "turn/start", seq: 0, data: { turn: 1 } },
			{ type: "todo/write", seq: 1, data: { todos: [{ content: "alpha", status: "in_progress" }] } },
		];
		const double = { seq: 2, surface: { nodes: [] }, eventAt: (seq) => events[seq] };
		const tracker = new TodoTracker();
		assert.equal(tracker.observe(double).hasTodoData, true);
		double.seq = 1;
		assert.equal(tracker.observe(double).hasTodoData, false, "a moved offset invalidates the fold instead of guessing");
	});

	it("clears only the consumed candidates on commit, never the request counts", () => {
		const session = newSession("todo-commit");
		appendSystem(session);
		appendTodo(session, [{ content: "alpha", status: "in_progress" }]);
		appendToolStep(session, { callId: "call-0" });
		appendTodo(session, [{ content: "alpha", status: "completed" }]);
		const tracker = new TodoTracker();
		assert.equal(tracker.observe(session).candidates.length, 1);
		tracker.commit(session);
		const after = tracker.observe(session);
		assert.deepEqual(after.candidates, [], "a used candidate is not offered again");
		assert.deepEqual(after.completedBoundaryRequestCounts, [1], "the observation itself is not consumed by an evaluation");
	});
});
