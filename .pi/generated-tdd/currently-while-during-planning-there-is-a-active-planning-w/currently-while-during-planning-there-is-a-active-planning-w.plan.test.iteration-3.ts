// Generated from a markdown plan.
// Plan: Make the "active planning" warning more visible with yellow/red colors and borders.
//
// BLOCKING AMBIGUITY: The plan does not specify:
//   1. Which source module contains the banner/warning rendering logic
//   2. What function or API produces the "active planning" warning
//   3. How the warning is integrated into CLI output
//
// The plan's only concrete scope item is:
//   "Review and update __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts"
//
// The plan's own edge cases acknowledge:
//   "No obvious existing module is found for the request."
//   "Critical behavior remains ambiguous and needs clarification before implementation."
//
// Given this ambiguity, the tests below document the required behavioral contract
// as explicitly failing tests. They target the existing test file's extension module
// (worktree.ts from Example 1) as a baseline and define the contract that ANY
// implementation of the banner feature must satisfy.
//
// These tests use node:test + node:assert/strict to match the existing repo conventions
// visible in all four test examples.

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// AMBIGUITY: The plan does not name the module that renders the active-planning
// warning. We attempt to import the existing test file's module (worktree.ts)
// and plan-feature.ts, but the real implementation module is unknown.
// ---------------------------------------------------------------------------

let worktreeExtension: Record<string, unknown> | null = null;
let planFeatureTestables: Record<string, unknown> | null = null;

try {
	const mod = await import("../../extensions/worktree.ts");
	worktreeExtension = mod.default ?? mod;
} catch {
	worktreeExtension = null;
}

try {
	const mod = await import("../../extensions/plan-feature.ts");
	planFeatureTestables = mod.__testables ?? null;
} catch {
	planFeatureTestables = null;
}

// ---------------------------------------------------------------------------
// Requirement: The plan is too ambiguous to derive a concrete module target.
// These tests document what MUST be true once the feature is implemented.
// They will fail until an implementation exists.
// ---------------------------------------------------------------------------

test("BLOCKING AMBIGUITY: plan does not specify which module renders the active-planning warning — implementation must expose a banner formatting function", () => {
	// The plan says the warning exists but is "barely visible".
	// The implementation must add or modify a function that formats the warning.
	// Until we know which module, we check both known candidates.

	const hasFormatInWorktree =
		worktreeExtension !== null &&
		typeof (worktreeExtension as Record<string, unknown>).formatPlanningBanner === "function";

	const hasFormatInPlanFeature =
		planFeatureTestables !== null &&
		typeof planFeatureTestables.formatPlanningBanner === "function";

	// Also check for any exported function whose name suggests banner/warning rendering
	const hasBannerLikeFn = [worktreeExtension, planFeatureTestables]
		.filter(Boolean)
		.some((mod) =>
			Object.keys(mod as Record<string, unknown>).some(
				(key) =>
					(/banner|warning|planning.*display|render.*planning/i.test(key) &&
						typeof (mod as Record<string, unknown>)[key] === "function"),
			),
		);

	assert.ok(
		hasFormatInWorktree || hasFormatInPlanFeature || hasBannerLikeFn,
		"No module exports a planning-banner formatting function. " +
			"The plan requires making the active-planning warning more visible, " +
			"but does not specify which module to modify. " +
			"Implementation must expose a function (e.g. formatPlanningBanner) in a known extension module.",
	);
});

test("BLOCKING AMBIGUITY: plan does not specify the warning's integration point — active planning warning must appear in CLI output with ANSI color codes", () => {
	// This test documents that whatever module renders the warning, it must
	// produce output with yellow or red ANSI escape codes.
	// Without knowing the module, we fail explicitly.

	const candidates = [
		{ name: "plan-feature.__testables", mod: planFeatureTestables },
		{ name: "worktree", mod: worktreeExtension },
	];

	let bannerFn: ((state: unknown) => string) | null = null;

	for (const { mod } of candidates) {
		if (mod && typeof (mod as Record<string, unknown>).formatPlanningBanner === "function") {
			bannerFn = (mod as Record<string, unknown>).formatPlanningBanner as (state: unknown) => string;
			break;
		}
	}

	if (!bannerFn) {
		assert.fail(
			"Cannot locate formatPlanningBanner in any known extension module. " +
				"The plan requires the active-planning warning to use yellow or red coloring, " +
				"but the implementation module is not specified in the plan. " +
				"Clarify which module to modify before proceeding.",
		);
		return;
	}

	const output = bannerFn({ active: true, title: "Test Plan" });
	const hasYellow = /\x1b\[33m|\x1b\[93m|\x1b\[38;5;(?:3|11|226|220)m/.test(output);
	const hasRed = /\x1b\[31m|\x1b\[91m|\x1b\[38;5;(?:1|9|196)m/.test(output);

	assert.ok(
		hasYellow || hasRed,
		`Active planning warning must use yellow or red ANSI codes for visibility. Got:\n${JSON.stringify(output)}`,
	);
});

test("active planning warning is enclosed within visible borders (yellow borders or box-drawing characters)", () => {
	const candidates = [planFeatureTestables, worktreeExtension].filter(Boolean);
	let bannerFn: ((state: unknown) => string) | null = null;

	for (const mod of candidates) {
		if (typeof (mod as Record<string, unknown>).formatPlanningBanner === "function") {
			bannerFn = (mod as Record<string, unknown>).formatPlanningBanner as (state: unknown) => string;
			break;
		}
	}

	if (!bannerFn) {
		assert.fail(
			"formatPlanningBanner not found — cannot verify border rendering. " +
				"Implementation must add this function to make the planning warning visible with borders.",
		);
		return;
	}

	const output = bannerFn({ active: true, title: "Test Plan" });
	const hasBorders =
		/[─━╔╗╚╝║┌┐└┘┃╭╮╰╯]/.test(output) || /[\-=]{3,}/.test(output) || /[█▀▄▌▐]/.test(output);

	assert.ok(
		hasBorders,
		`Active planning warning must be enclosed in visible borders. Got:\n${JSON.stringify(output)}`,
	);
});

test("active planning warning includes the planning session title for user context", () => {
	const candidates = [planFeatureTestables, worktreeExtension].filter(Boolean);
	let bannerFn: ((state: unknown) => string) | null = null;

	for (const mod of candidates) {
		if (typeof (mod as Record<string, unknown>).formatPlanningBanner === "function") {
			bannerFn = (mod as Record<string, unknown>).formatPlanningBanner as (state: unknown) => string;
			break;
		}
	}

	if (!bannerFn) {
		assert.fail("formatPlanningBanner not found — cannot verify title inclusion.");
		return;
	}

	const output = bannerFn({ active: true, title: "My Unique Feature Plan" });
	const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

	assert.ok(
		plain.includes("My Unique Feature Plan"),
		`Banner must include the planning session title. Plain text:\n${plain}`,
	);
});

test("active planning warning includes a recognisable label like 'active planning' or 'planning session'", () => {
	const candidates = [planFeatureTestables, worktreeExtension].filter(Boolean);
	let bannerFn: ((state: unknown) => string) | null = null;

	for (const mod of candidates) {
		if (typeof (mod as Record<string, unknown>).formatPlanningBanner === "function") {
			bannerFn = (mod as Record<string, unknown>).formatPlanningBanner as (state: unknown) => string;
			break;
		}
	}

	if (!bannerFn) {
		assert.fail("formatPlanningBanner not found — cannot verify label.");
		return;
	}

	const output = bannerFn({ active: true, title: "Some Plan" });
	const plain = output.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();

	const hasLabel =
		plain.includes("active planning") ||
		plain.includes("planning session") ||
		plain.includes("planning active") ||
		plain.includes("⚠") ||
		plain.includes("warning");

	assert.ok(hasLabel, `Banner must contain a recognisable planning-active label. Plain text:\n${plain}`);
});

// ---------------------------------------------------------------------------
// Edge case: inactive planning session should not show a prominent warning
// ---------------------------------------------------------------------------

test("edge case: no visible colored banner when planning session is inactive", () => {
	const candidates = [planFeatureTestables, worktreeExtension].filter(Boolean);
	let bannerFn: ((state: unknown) => string) | null = null;

	for (const mod of candidates) {
		if (typeof (mod as Record<string, unknown>).formatPlanningBanner === "function") {
			bannerFn = (mod as Record<string, unknown>).formatPlanningBanner as (state: unknown) => string;
			break;
		}
	}

	if (!bannerFn) {
		assert.fail("formatPlanningBanner not found — cannot verify inactive behavior.");
		return;
	}

	const output = bannerFn({ active: false, title: "Inactive Plan" });
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
	const candidates = [planFeatureTestables, worktreeExtension].filter(Boolean);
	let bannerFn: ((state: unknown) => string) | null = null;

	for (const mod of candidates) {
		if (typeof (mod as Record<string, unknown>).formatPlanningBanner === "function") {
			bannerFn = (mod as Record<string, unknown>).formatPlanningBanner as (state: unknown) => string;
			break;
		}
	}

	if (!bannerFn) {
		assert.fail("formatPlanningBanner not found — cannot verify empty-title behavior.");
		return;
	}

	const output = bannerFn({ active: true, title: "" });
	const hasColor = /\x1b\[33m|\x1b\[93m|\x1b\[31m|\x1b\[91m/.test(output);
	const hasBorders =
		/[─━╔╗╚╝║┌┐└┘┃╭╮╰╯]/.test(output) || /[\-=]{3,}/.test(output);

	assert.ok(hasColor, "Expected yellow/red ANSI codes even when planning title is empty");
	assert.ok(hasBorders, "Expected border characters even when planning title is empty");
});

// ---------------------------------------------------------------------------
// Scope: out-of-scope guard — no unconfirmed product changes
// ---------------------------------------------------------------------------

test("out of scope: existing getPlanningState/applyPlanningState/clearPlanningState API must not be removed", async () => {
	if (!planFeatureTestables) {
		// plan-feature.ts may not exist yet; this is not a failure for the banner feature
		// but documents the constraint that existing API must be preserved
		assert.fail(
			"extensions/plan-feature.ts is not importable. " +
				"If the banner feature is implemented in this module, " +
				"ensure getPlanningState, applyPlanningState, and clearPlanningState still exist.",
		);
		return;
	}

	assert.equal(
		typeof planFeatureTestables.getPlanningState,
		"function",
		"getPlanningState must still be exported from __testables",
	);
	assert.equal(
		typeof planFeatureTestables.applyPlanningState,
		"function",
		"applyPlanningState must still be exported from __testables",
	);
	assert.equal(
		typeof planFeatureTestables.clearPlanningState,
		"function",
		"clearPlanningState must still be exported from __testables",
	);
});
