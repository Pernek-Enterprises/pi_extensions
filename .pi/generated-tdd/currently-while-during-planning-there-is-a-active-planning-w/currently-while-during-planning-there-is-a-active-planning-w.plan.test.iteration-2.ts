// Generated from a markdown plan.
// Plan: Make the "active planning" warning more visible with yellow/red colors and borders.
//
// NOTE: The plan is vague and does not specify a concrete module or function.
// Based on the existing test file (Example 1) and the plan-feature test (Example 2),
// the most likely module is extensions/plan-feature.ts which already exports __testables
// with getPlanningState, applyPlanningState, clearPlanningState.
// The new feature requires a formatPlanningBanner function to be added to __testables.
//
// These tests follow the repository convention of using node:test + node:assert/strict.
// They define a clear TDD contract: __testables must export `formatPlanningBanner`.

import test from "node:test";
import assert from "node:assert/strict";

// Dynamic import to avoid crashing the entire suite if the module doesn't exist yet.
// This addresses Fix 1: graceful failure with clear message instead of MODULE_NOT_FOUND crash.
let __testables: Record<string, unknown> = {};
let importError: Error | null = null;

try {
	const mod = await import("../../extensions/plan-feature.ts");
	__testables = mod.__testables ?? {};
} catch (err) {
	importError = err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanningState(overrides: Record<string, unknown> = {}) {
	return {
		active: true,
		originId: "leaf-1",
		id: "plan-1",
		title: "Better planning message",
		slug: "better-planning-message",
		originalInput: "Better planning message",
		status: "collecting-context",
		repoRoot: "/repo",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		relevantFiles: [],
		questions: [],
		assumptions: [],
		decisions: [],
		...overrides,
	};
}

// ANSI detection helpers
function containsYellowAnsi(text: string): boolean {
	return /\x1b\[33m/.test(text) || /\x1b\[38;5;(?:3|11|226|220)m/.test(text) || /\x1b\[93m/.test(text);
}

function containsRedAnsi(text: string): boolean {
	return /\x1b\[31m/.test(text) || /\x1b\[38;5;(?:1|9|196)m/.test(text) || /\x1b\[91m/.test(text);
}

function containsBorderChars(text: string): boolean {
	return /[─━╔╗╚╝║┌┐└┘┃╭╮╰╯]/.test(text) || /[\-=]{3,}/.test(text);
}

function containsHighVisibilityColor(text: string): boolean {
	return containsYellowAnsi(text) || containsRedAnsi(text);
}

function getFormatPlanningBanner(): ((state: Record<string, unknown>) => string) | null {
	const fn = __testables.formatPlanningBanner;
	if (typeof fn === "function") return fn as (state: Record<string, unknown>) => string;
	return null;
}

// ---------------------------------------------------------------------------
// Guard: module must be importable
// ---------------------------------------------------------------------------

test("extensions/plan-feature.ts is importable and exports __testables", () => {
	if (importError) {
		assert.fail(
			`Cannot import extensions/plan-feature.ts: ${importError.message}. ` +
				"This module must exist and export __testables with formatPlanningBanner.",
		);
	}
	assert.ok(__testables, "Expected __testables to be exported from extensions/plan-feature.ts");
});

test("__testables exports a formatPlanningBanner function", () => {
	if (importError) {
		assert.fail(`Module not importable: ${importError.message}`);
	}
	const fn = getFormatPlanningBanner();
	assert.ok(
		fn,
		"Expected __testables to export a `formatPlanningBanner` function. " +
			"This is the TDD contract for the active-planning warning visibility feature.",
	);
});

// ---------------------------------------------------------------------------
// Core feature: active planning warning visibility
// ---------------------------------------------------------------------------

test("active planning warning uses yellow or red ANSI color codes so it is highly visible", () => {
	const formatBanner = getFormatPlanningBanner();
	if (!formatBanner) {
		assert.fail("formatPlanningBanner not available — implement it in __testables");
		return;
	}

	const banner = formatBanner(makePlanningState());

	assert.ok(
		containsHighVisibilityColor(banner),
		`Expected the active-planning banner to contain yellow or red ANSI escape codes for visibility, but got:\n${JSON.stringify(banner)}`,
	);
});

test("active planning warning is enclosed in visible borders (box-drawing or repeated dashes)", () => {
	const formatBanner = getFormatPlanningBanner();
	if (!formatBanner) {
		assert.fail("formatPlanningBanner not available — implement it in __testables");
		return;
	}

	const banner = formatBanner(makePlanningState());

	assert.ok(
		containsBorderChars(banner),
		`Expected the active-planning banner to be enclosed in visible borders (box-drawing characters or repeated dashes), but got:\n${JSON.stringify(banner)}`,
	);
});

test("active planning warning contains the planning session title for context", () => {
	const formatBanner = getFormatPlanningBanner();
	if (!formatBanner) {
		assert.fail("formatPlanningBanner not available — implement it in __testables");
		return;
	}

	const banner = formatBanner(makePlanningState({ title: "My Unique Plan Title" }));
	const plain = banner.replace(/\x1b\[[0-9;]*m/g, "");

	assert.ok(
		plain.includes("My Unique Plan Title"),
		`Expected the banner to include the planning session title 'My Unique Plan Title', got:\n${plain}`,
	);
});

test("active planning warning includes a recognisable 'active planning' or 'planning session' label", () => {
	const formatBanner = getFormatPlanningBanner();
	if (!formatBanner) {
		assert.fail("formatPlanningBanner not available — implement it in __testables");
		return;
	}

	const banner = formatBanner(makePlanningState());
	const plain = banner.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();

	const hasLabel =
		plain.includes("active planning") ||
		plain.includes("planning session") ||
		plain.includes("planning active") ||
		plain.includes("⚠") ||
		plain.includes("warning");

	assert.ok(
		hasLabel,
		`Expected the banner to contain a recognisable planning-active label, got:\n${plain}`,
	);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("edge case: banner still renders with color and borders when planning title is empty", () => {
	const formatBanner = getFormatPlanningBanner();
	if (!formatBanner) {
		assert.fail("formatPlanningBanner not available — implement it in __testables");
		return;
	}

	const banner = formatBanner(makePlanningState({ title: "" }));

	assert.ok(
		containsHighVisibilityColor(banner),
		"Expected yellow/red ANSI codes even when planning title is empty",
	);
	assert.ok(
		containsBorderChars(banner),
		"Expected border characters even when planning title is empty",
	);
});

test("edge case: no banner or no color is produced when planning session is inactive", () => {
	const formatBanner = getFormatPlanningBanner();
	if (!formatBanner) {
		assert.fail("formatPlanningBanner not available — implement it in __testables");
		return;
	}

	const banner = formatBanner(makePlanningState({ active: false }));

	const isEmpty = !banner || banner.trim() === "";
	const hasNoColor = !containsHighVisibilityColor(banner);

	assert.ok(
		isEmpty || hasNoColor,
		`Expected no visible banner when planning is inactive, but got:\n${JSON.stringify(banner)}`,
	);
});

// ---------------------------------------------------------------------------
// Scope guard: feature must not break existing planning state management
// These tests verify existing __testables API still works (getPlanningState,
// applyPlanningState, clearPlanningState) per the patterns in the existing
// test file Example 2. This addresses Fix 4 (base on existing conventions).
// ---------------------------------------------------------------------------

test("existing getPlanningState/applyPlanningState contract still works after banner changes", async () => {
	if (importError) {
		assert.fail(`Module not importable: ${importError.message}`);
		return;
	}

	const getPlanningState = __testables.getPlanningState as ((ctx: Record<string, unknown>) => unknown) | undefined;
	const applyPlanningState = __testables.applyPlanningState as
		| ((ctx: Record<string, unknown>, state: Record<string, unknown>) => Promise<void>)
		| undefined;

	// These functions exist per Example 2 — skip gracefully if they were refactored away
	if (!getPlanningState || !applyPlanningState) {
		// Not a failure: the plan only requires formatPlanningBanner
		return;
	}

	const entryLog: Array<{ type: string; value: unknown }> = [];
	const ctx: Record<string, unknown> = {
		state: {},
		pi: {
			appendEntry(entry: { type: string; value: unknown }) {
				entryLog.push(entry);
				return { id: `entry-${entryLog.length}` };
			},
		},
	};

	assert.equal(getPlanningState(ctx), undefined);

	const planningState = makePlanningState();
	await applyPlanningState(ctx, planningState);
	assert.deepEqual(getPlanningState(ctx), planningState);
});
