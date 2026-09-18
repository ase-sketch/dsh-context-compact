/**
 * Ported verbatim from refs/sol-opencode/test/compact-plan.test.ts (NVIDIA MIT) — the upstream vitest
 * `expect` assertions are preserved one for one; only the harness (node:test + node:assert) changed.
 *
 * @module @sol-pi-port/dsh-context-compact/test/plan
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "../lib/vendor/plan.js";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }];
const DONE = [{ id: "build", goal: "build it", status: "completed" }];

describe("Online Context Compact plans", () => {
	it("accepts stored empty plans and rejects malformed plans", () => {
		assert.deepEqual(parsePlanSteps([]), []);
		assert.equal(parsePlanSteps([{ goal: "missing id", status: "pending" }]), undefined);
		assert.equal(parsePlanSteps([{ id: "x", goal: "x", status: "unknown" }]), undefined);
		assert.equal(
			parsePlanSteps([{ id: "x", goal: "a", status: "pending" }, { id: "x", goal: "b", status: "pending" }]),
			undefined,
		);
		assert.deepEqual(parsePlanSteps(OPEN), OPEN);
	});

	it("detects only new transitions into completed", () => {
		assert.deepEqual(analyzePlanTransition(OPEN, DONE).completedSteps, DONE);
		assert.deepEqual(analyzePlanTransition(DONE, DONE).completedSteps, []);
	});

	it("flags ambiguous active work and reused ids with changed goals", () => {
		const transition = analyzePlanTransition(
			[{ id: "a", goal: "old", status: "in_progress" }],
			[
				{ id: "a", goal: "new", status: "in_progress" },
				{ id: "b", goal: "second", status: "in_progress" },
			],
		);
		const advice = transition.advice.join("\n");
		assert.ok(advice.includes("changed goal"));
		assert.ok(advice.includes("at most one"));
	});

	it("formats a compact progress-only snapshot", () => {
		const snapshot = formatPlanSnapshot(OPEN);
		assert.ok(snapshot.includes('<sol-pi-plan task_status="active">'));
		assert.ok(snapshot.includes(JSON.stringify({ steps: OPEN })));
	});
});
