// Generated from a markdown plan.
// Plan: Make the "active planning" warning more visible with yellow/red colors and borders.
//
// CRITICAL AMBIGUITY NOTE:
// The plan does not specify which module renders the active-planning warning,
// what function/API to test, or how the warning integrates into CLI output.
// The plan's own edge cases acknowledge:
//   "No obvious existing module is found for the request."
//   "Critical behavior remains ambiguous and needs clarification before implementation."
//
// The plan's only concrete scope item is:
//   "Review and update __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts"
//
// Per the existing test file (Example 1), the relevant modules are:
//   - extensions/worktree.ts (imported as worktreeExtension)
//   - extensions/plan-feature.ts (exports __testables with getPlanningState, applyPlanningState, clearPlanningState)
//
// The tests below are grounded in the REAL exports from plan-feature.ts __testables.
// The feature requires that when a planning session is active, the CLI warning
// uses ANSI color codes (yellow/red) and/or border characters for visibility.
// Since plan-feature.ts manages planning state, the rendering enhancement most
// likely lives there or in a new export from that module.
//
// Tests use node:test + node:assert/strict to match repo conventions.

import test from "node:test";
import assert from "node:assert/strict";

import { __testables } from "../../extensions/plan-feature.ts";

// ---------------------------------------------------------------------------
// Baseline: existing plan-feature API must still work (out-of-scope guard)
// ---------------------------------------------------------------------------

test("out of scope guard: existing getPlanningState, applyPlanningState, clearPlanningState APIs are preserved", () => {
	assert.equal(
		typeof __testables.getPlanningState,
		"function",
		"getPlanningState must still be exported from __testables",
	);
	assert.equal(
		typeof __testables.applyPlanningState,
		"function",
		"applyPlanningState must still be exported from __testables",
	);
	assert.equal(
		typeof __testables.clearPlanningState,
		"function",
		"clearPlanningState must still be exported from __testables",
	);
});

// ---------------------------------------------------------------------------
// Feature requirement: plan-feature must export a formatPlanningWarning (or
// similar) function that renders the active-planning banner with color/borders.
// ---------------------------------------------------------------------------

test("plan-feature __testables exports a function for formatting the active-planning warning", () => {
	// The implementation must expose a formatting function for the planning warning.
	// We accept any of these reasonable names:
	const candidateNames = [
		"formatPlanningWarning",
		"formatPlanningBanner",
		"renderPlanningWarning",
		"getPlanningWarningText",
		"planningWarning",
		"formatActivePlanningWarning",
	];

	const testables = __testables as Record<string, unknown>;
	const found = candidateNames.find((name) => typeof testables[name] === "function");

	assert.ok(
		found,
		`plan-feature.__testables must export a planning-warning formatting function. ` +
			`Checked: ${candidateNames.join(", ")}. ` +
			`Available keys: ${Object.keys(testables).join(", ")}`,
	);
});

// Helper to locate the formatting function dynamically
function getWarningFormatter(): (state: Record<string, unknown>) => string {
	const candidateNames = [
		"formatPlanningWarning",
		"formatPlanningBanner",
		"renderPlanningWarning",
		"getPlanningWarningText",
		"planningWarning",
		"formatActivePlanningWarning",
	];

	const testables = __testables as Record<string, unknown>;
	const name = candidateNames.find((n) => typeof testables[n] === "function");

	if (!name) {
		throw new Error(
			`No planning-warning formatting function found in plan-feature.__testables. ` +
				`Checked: ${candidateNames.join(", ")}. ` +
				`Available: ${Object.keys(testables).join(", ")}`,
		);
	}

	return testables[name] as (state: Record<string, unknown>) => string;
}

// ---------------------------------------------------------------------------
// Requirement: warning uses yellow or red ANSI color codes for visibility
// ---------------------------------------------------------------------------

test("active planning warning uses yellow or red ANSI color codes for visibility", () => {
	const format = getWarningFormatter();
	const output = format({ active: true, title: "Test Plan" });

	// Standard ANSI codes for yellow (33, 93) and red (31, 91), plus 256-color variants
	const hasYellow = /\x1b\[33m|\x1b\[93m|\x1b\[38;5;(?:3|11|226|220)m/.test(output);
	const hasRed = /\x1b\[31m|\x1b\[91m|\x1b\[38;5;(?:1|9|196)m/.test(output);

	assert.ok(
		hasYellow || hasRed,
		`Active planning warning must use yellow or red ANSI codes. Got:\n${JSON.stringify(output)}`,
	);
});

// ---------------------------------------------------------------------------
// Requirement: warning is enclosed within visible borders
// ---------------------------------------------------------------------------

test("active planning warning is enclosed within visible borders (box-drawing or repeated line characters)", () => {
	const format = getWarningFormatter();
	const output = format({ active: true, title: "Test Plan" });

	const hasBoxDrawing = /[─━╔╗╚╝║┌┐└┘┃╭╮╰╯]/.test(output);
	const hasRepeatedDashes = /[-=]{3,}/.test(output);
	const hasBlockChars = /[█▀▄▌▐]/.test(output);

	assert.ok(
		hasBoxDrawing || hasRepeatedDashes || hasBlockChars,
		`Active planning warning must be enclosed in visible borders. Got:\n${JSON.stringify(output)}`,
	);
});

// ---------------------------------------------------------------------------
// Requirement: warning includes recognizable label
// ---------------------------------------------------------------------------

test("active planning warning includes a recognisable label like 'active planning' or 'planning session'", () => {
	const format = getWarningFormatter();
	const output = format({ active: true, title: "Some Plan" });

	// Strip ANSI codes for text matching
	const plain = output.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();

	const hasLabel =
		plain.includes("active planning") ||
		plain.includes("planning session") ||
		plain.includes("planning active") ||
		plain.includes("planning mode") ||
		plain.includes("⚠") ||
		plain.includes("warning");

	assert.ok(hasLabel, `Banner must contain a recognisable planning-active label. Plain text:\n${plain}`);
});

// ---------------------------------------------------------------------------
// Requirement: warning includes the planning session title
// ---------------------------------------------------------------------------

test("active planning warning includes the planning session title for user context", () => {
	const format = getWarningFormatter();
	const output = format({ active: true, title: "My Unique Feature Plan" });

	const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

	assert.ok(
		plain.includes("My Unique Feature Plan"),
		`Banner must include the planning session title. Plain text:\n${plain}`,
	);
});

// ---------------------------------------------------------------------------
// Edge case: inactive planning session should NOT show colored/bordered warning
// ---------------------------------------------------------------------------

test("edge case: no visible colored banner when planning session is inactive", () => {
	const format = getWarningFormatter();
	const output = format({ active: false, title: "Inactive Plan" });

	const isEmpty = !output || output.trim() === "";
	const hasYellow = /\x1b\[33m|\x1b\[93m/.test(output);
	const hasRed = /\x1b\[31m|\x1b\[91m/.test(output);

	assert.ok(
		isEmpty || (!hasYellow && !hasRed),
		`Expected no colored banner for inactive session. Got:\n${JSON.stringify(output)}`,
	);
});

// ---------------------------------------------------------------------------
// Edge case: empty title should still render a visible warning
// ---------------------------------------------------------------------------

test("edge case: banner renders with color and borders even when planning title is empty", () => {
	const format = getWarningFormatter();
	const output = format({ active: true, title: "" });

	const hasColor = /\x1b\[33m|\x1b\[93m|\x1b\[31m|\x1b\[91m/.test(output);
	const hasBorders =
		/[─━╔╗╚╝║┌┐└┘┃╭╮╰╯]/.test(output) || /[-=]{3,}/.test(output);

	assert.ok(hasColor, "Expected yellow/red ANSI codes even when planning title is empty");
	assert.ok(hasBorders, "Expected border characters even when planning title is empty");
});

// ---------------------------------------------------------------------------
// Edge case: undefined/null state should not throw
// ---------------------------------------------------------------------------

test("edge case: formatting function handles undefined or missing active field gracefully", () => {
	const format = getWarningFormatter();

	// Should not throw for edge-case inputs
	assert.doesNotThrow(() => format({} as Record<string, unknown>));
	assert.doesNotThrow(() => format({ active: undefined, title: undefined } as unknown as Record<string, unknown>));
});
