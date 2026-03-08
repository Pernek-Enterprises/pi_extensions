// Generated from a markdown plan.
import test from "node:test";
import assert from "node:assert/strict";

import { __testables } from "../../extensions/plan-feature.ts";

test("getPlanningState/applyPlanningState/clearPlanningState persist and clear planning session state", async () => {
	const entryLog: Array<{ type: string; value: unknown }> = [];
	const ctx = {
		state: {},
		pi: {
			appendEntry(entry: { type: string; value: unknown }) {
				entryLog.push(entry);
				return { id: `entry-${entryLog.length}` };
			},
		},
	};

	assert.equal(__testables.getPlanningState(ctx), undefined);

	const planningState = {
		active: true,
		originId: "leaf-1",
		id: "plan-1",
		title: "Add recurring invoices",
		slug: "add-recurring-invoices",
		originalInput: "Add recurring invoices",
		status: "collecting-context",
		repoRoot: "/repo",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		relevantFiles: [],
		questions: [],
		assumptions: [],
		decisions: [],
	};

	await __testables.applyPlanningState(ctx, planningState);
	assert.deepEqual(__testables.getPlanningState(ctx), planningState);
	assert.ok(entryLog.some((entry) => entry.type === "planning-session"), "expected a planning-session entry to be persisted");

	await __testables.clearPlanningState(ctx);
	assert.equal(__testables.getPlanningState(ctx), undefined);
});

test("applyPlanningState only persists materially changed state and draft payloads", async () => {
	const entryLog: Array<{ type: string; value: unknown }> = [];
	const ctx = {
		state: {},
		pi: {
			appendEntry(entry: { type: string; value: unknown }) {
				entryLog.push(entry);
				return { id: `entry-${entryLog.length}` };
			},
		},
	};

	const planningState = {
		active: true,
		originId: "leaf-1",
		id: "plan-1",
		title: "Add recurring invoices",
		slug: "add-recurring-invoices",
		originalInput: "Add recurring invoices",
		status: "drafting",
		repoRoot: "/repo",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		relevantFiles: [],
		questions: [],
		assumptions: [],
		decisions: [],
		currentDraft: "# Plan: Add recurring invoices\n",
	};

	await __testables.applyPlanningState(ctx, planningState);
	await __testables.applyPlanningState(ctx, planningState);

	assert.equal(entryLog.filter((entry) => entry.type === "planning-session").length, 1);
	assert.equal(entryLog.filter((entry) => entry.type === "planning-draft").length, 1);
});

test("setPlanningWidget(ctx, active) shows 'Planning session active, return with /end-planning' and clears it when inactive", async () => {
	const widgetCalls: string[] = [];
	const cleared: string[] = [];
	const ctx = {
		ui: {
			setWidget(text: string) {
				widgetCalls.push(text);
			},
			clearWidget(id: string) {
				cleared.push(id);
			},
		},
	};

	await __testables.setPlanningWidget(ctx, true, false);
	assert.deepEqual(widgetCalls, ["Planning session active, return with /end-planning"]);

	await __testables.setPlanningWidget(ctx, true, true);
	assert.equal(widgetCalls[1], "Planning session active (draft ready), return with /end-planning");

	await __testables.setPlanningWidget(ctx, false, false);
	assert.ok(cleared.length > 0, "expected widget removal when planning becomes inactive");
});

test("Start behavior blocks and asks user to finish it first if a planning session is already active", async () => {
	const notifications: string[] = [];
	const ctx = {
		state: {
			planning: {
				active: true,
				originId: "leaf-1",
				id: "plan-1",
				title: "Existing plan",
				slug: "existing-plan",
				originalInput: "Existing plan",
				status: "clarifying",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
			},
		},
		notify(message: string) {
			notifications.push(message);
		},
	};

	await assert.rejects(() => __testables.startPlanningSession(ctx, "Add recurring invoices"), /finish it first|end-planning/i);
	assert.ok(notifications.some((message) => /finish it first|end-planning/i.test(message)));
});

test("Start behavior if there is no leaf yet, append a lightweight planning anchor entry first", async () => {
	const appended: Array<{ type: string; value: unknown }> = [];
	const ctx = {
		cwd: "/repo",
		currentLeafId: undefined,
		pi: {
			appendEntry(entry: { type: string; value: unknown }) {
				appended.push(entry);
				return { id: "anchor-1" };
			},
		},
		navigateFromEntry() {
			return { leafId: "branch-1" };
		},
		ui: {
			setWidget() {},
		},
		notify() {},
	};

	const state = await __testables.startPlanningSession(ctx, "Add recurring invoices");
	assert.equal(state.originId, "anchor-1");
	assert.ok(appended.some((entry) => entry.type === "planning-anchor"), "expected a planning-anchor entry to be appended");
});

test("Start behavior if there is an existing conversation, capture the origin leaf and branch away in isolated context labeled feature-planning", async () => {
	const navigations: Array<{ originId: string; options: unknown }> = [];
	const persisted: Array<{ type: string; value: unknown }> = [];
	const widgetMessages: string[] = [];
	const notifications: string[] = [];
	const ctx = {
		cwd: "/repo",
		currentLeafId: "leaf-42",
		pi: {
			appendEntry(entry: { type: string; value: unknown }) {
				persisted.push(entry);
				return { id: "persisted-1" };
			},
		},
		navigateFromEntry(originId: string, options: unknown) {
			navigations.push({ originId, options });
			return { leafId: "branch-2" };
		},
		ui: {
			setWidget(text: string) {
				widgetMessages.push(text);
			},
		},
		notify(message: string) {
			notifications.push(message);
		},
	};

	const state = await __testables.startPlanningSession(ctx, "Add recurring invoices");
	assert.equal(state.originId, "leaf-42");
	assert.equal(navigations.length, 1);
	assert.match(JSON.stringify(navigations[0].options), /feature-planning/);
	assert.ok(widgetMessages.includes("Planning session active, return with /end-planning"));
	assert.ok(persisted.some((entry) => entry.type === "planning-session"), "expected planning state persistence");
	assert.ok(notifications.some((message) => /planning started/i.test(message)));
});

test("Start behavior restore locked origin id after navigation events", async () => {
	const ctx = {
		state: {
			planning: {
				active: true,
				originId: "origin-locked",
				id: "plan-1",
				title: "Plan",
				slug: "plan",
				originalInput: "Plan",
				status: "clarifying",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
			},
		},
	};

	const restoredFromStart = await __testables.restorePlanningStateOnEvent(ctx, { type: "session_start", leafId: "other-leaf" });
	assert.equal(restoredFromStart.originId, "origin-locked");

	const restoredFromSwitch = await __testables.restorePlanningStateOnEvent(ctx, { type: "session_switch", leafId: "other-leaf" });
	assert.equal(restoredFromSwitch.originId, "origin-locked");

	const restoredFromTree = await __testables.restorePlanningStateOnEvent(ctx, { type: "session_tree", leafId: "other-leaf" });
	assert.equal(restoredFromTree.originId, "origin-locked");
});

test("End behavior looks up active origin id from memory or persisted custom entry and calls ctx.navigateTree(originId, { summarize: false })", async () => {
	const navigations: Array<{ id: string; options: unknown }> = [];
	const widgetsCleared: string[] = [];
	const notifications: string[] = [];
	const ctx = {
		state: {
			planning: {
				active: true,
				originId: "origin-77",
				id: "plan-1",
				title: "Plan",
				slug: "plan",
				originalInput: "Plan",
				status: "finalized",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
			},
		},
		navigateTree(id: string, options: unknown) {
			navigations.push({ id, options });
		},
		ui: {
			clearWidget(id: string) {
				widgetsCleared.push(id);
			},
		},
		notify(message: string) {
			notifications.push(message);
		},
	};

	await __testables.endPlanningSession(ctx);
	assert.deepEqual(navigations, [{ id: "origin-77", options: { summarize: false } }]);
	assert.equal(__testables.getPlanningState(ctx), undefined);
	assert.ok(widgetsCleared.length > 0, "expected planning widget to be removed");
	assert.ok(notifications.some((message) => /planning returned to original position|success/i.test(message)));
});

test("End behavior when no active planning session exists notifies 'no active planning session'", async () => {
	const notifications: string[] = [];
	const ctx = {
		state: {},
		notify(message: string) {
			notifications.push(message);
		},
	};

	await assert.rejects(() => __testables.endPlanningSession(ctx), /no active planning session/i);
	assert.ok(notifications.some((message) => /no active planning session/i.test(message)));
});

test("end-planning detects an unsaved plan and lets the user save it before returning", async () => {
	const navigations: Array<{ id: string; options: unknown }> = [];
	const notifications: string[] = [];
	const writes: string[] = [];
	const ctx = {
		hasUI: true,
		state: {
			planning: {
				active: true,
				originId: "origin-88",
				id: "plan-1",
				title: "Plan",
				slug: "plan",
				originalInput: "Plan",
				status: "finalized",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
				currentDraft: "# Plan: Plan\n",
			},
		},
		ui: {
			async select() {
				return "Save plan";
			},
			clearWidget() {},
		},
		pi: {
			appendEntry() {
				return { id: "entry-1" };
			},
		},
		navigateTree(id: string, options: unknown) {
			navigations.push({ id, options });
		},
		notify(message: string) {
			notifications.push(message);
		},
	};

	const originalWriteFile = __testables.__fsWriteFile;
	const originalMkdir = __testables.__fsMkdir;
	__testables.__fsWriteFile = async (filePath: string) => {
		writes.push(filePath);
	};
	__testables.__fsMkdir = async () => {};
	try {
		await __testables.endPlanningSession(ctx);
	} finally {
		__testables.__fsWriteFile = originalWriteFile;
		__testables.__fsMkdir = originalMkdir;
	}

	assert.ok(writes.some((file) => file.endsWith(".pi/plans/plan.plan.md")));
	assert.ok(notifications.some((message) => /Plan saved:/i.test(message)));
	assert.deepEqual(navigations, [{ id: "origin-88", options: { summarize: false } }]);
});

test("end-planning detects an unsaved plan and lets the user discard it before returning", async () => {
	const navigations: Array<{ id: string; options: unknown }> = [];
	const ctx = {
		hasUI: true,
		state: {
			planning: {
				active: true,
				originId: "origin-99",
				id: "plan-1",
				title: "Plan",
				slug: "plan",
				originalInput: "Plan",
				status: "finalized",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
				currentDraft: "# Plan: Plan\n",
			},
		},
		ui: {
			async select() {
				return "Discard plan";
			},
			clearWidget() {},
		},
		navigateTree(id: string, options: unknown) {
			navigations.push({ id, options });
		},
		notify() {},
	};

	await __testables.endPlanningSession(ctx);
	assert.deepEqual(navigations, [{ id: "origin-99", options: { summarize: false } }]);
});

test("/plan-tests ensure a saved plan file exists and if not saved yet, prompt to save first", async () => {
	const prompts: string[] = [];
	const ctx = {
		state: {
			planning: {
				active: true,
				id: "plan-1",
				title: "Plan",
				slug: "plan",
				originalInput: "Plan",
				status: "finalized",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
			},
		},
		notify(message: string) {
			prompts.push(message);
		},
	};

	await assert.rejects(() => __testables.handlePlanTests(ctx), /save first|saved plan file exists/i);
	assert.ok(prompts.some((message) => /save first/i.test(message)));
});

test("/plan-tests then instruct the user to run /tdd-plan <path> when a saved plan exists", async () => {
	const outputs: string[] = [];
	const ctx = {
		state: {
			planning: {
				active: true,
				id: "plan-1",
				title: "Plan",
				slug: "plan",
				originalInput: "Plan",
				status: "finalized",
				repoRoot: "/repo",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				relevantFiles: [],
				questions: [],
				assumptions: [],
				decisions: [],
				savedPath: ".pi/plans/add-recurring-invoices.plan.md",
			},
		},
		notify(message: string) {
			outputs.push(message);
		},
	};

	const result = await __testables.handlePlanTests(ctx);
	assert.match(String(result), /\/tdd-plan \.pi\/plans\/add-recurring-invoices\.plan\.md/);
	assert.ok(outputs.some((message) => /\/tdd-plan \.pi\/plans\/add-recurring-invoices\.plan\.md/.test(message)));
});

test("buildPlanningSystemPrompt requires the agent to cite repo evidence explicitly, distinguish facts vs assumptions, ask concise high-value questions, avoid implementation code, and produce structured markdown", () => {
	const prompt = __testables.buildPlanningSystemPrompt();
	assert.match(prompt, /cite repo evidence explicitly/i);
	assert.match(prompt, /distinguish facts from assumptions|facts vs assumptions/i);
	assert.match(prompt, /ask concise, high-value questions/i);
	assert.match(prompt, /avoid implementation code|do not write implementation code/i);
	assert.match(prompt, /structured markdown/i);
	assert.doesNotMatch(prompt, /jump immediately into coding/i);
});

test("buildPlanningSystemPrompt includes important constraints for performance, rollout strategy, audit/logging, analytics, observability, and vertical-slice split guidance", () => {
	const prompt = __testables.buildPlanningSystemPrompt();
	assert.match(prompt, /performance/i);
	assert.match(prompt, /rollout/i);
	assert.match(prompt, /audit|logging/i);
	assert.match(prompt, /analytics/i);
	assert.match(prompt, /observability/i);
	assert.match(prompt, /recommended split/i);
	assert.match(prompt, /vertical slice/i);
	assert.match(prompt, /never split by frontend\/backend|never split by frontend\/backend layers/i);
});

test("buildFinalizationPrompt for /plan-done asks the agent to stop questioning and finalize the plan", () => {
	const prompt = __testables.buildFinalizationPrompt();
	assert.match(prompt, /stop questioning and finalize the plan/i);
	assert.match(prompt, /suggest \/plan-save/i);
});

test("final plan markdown output includes Recommended Split conditionally and keeps scope/decisions/acceptance/edge cases", () => {
	const markdown = __testables.renderPlanMarkdown({
		title: "Add recurring invoices",
		originalInput: "Add recurring invoices",
		repoContextSummary: "Found invoice modules and tests.",
		recommendedSplit: [
			"Slice 1: create a recurring invoice for one supported schedule end-to-end.",
			"Slice 2: add pause/resume for active recurring invoices end-to-end.",
		],
		scope: ["Create recurring invoices"],
		outOfScope: ["Email reminders"],
		decisions: ["Only standard invoices in v1"],
		assumptions: ["Existing billing scheduler can be reused"],
		openQuestions: ["Should pause/resume emit audit logs?"],
		acceptanceCriteria: ["Users can pause an active recurring invoice"],
		edgeCases: ["Resuming recalculates next run date"],
	});

	assert.match(markdown, /^# Plan: Add recurring invoices/m);
	assert.match(markdown, /^## Recommended Split$/m);
	assert.match(markdown, /^## Scope$/m);
	assert.match(markdown, /^## Clarified decisions$/m);
	assert.match(markdown, /^## Acceptance criteria$/m);
	assert.match(markdown, /^## Edge cases$/m);
	assert.doesNotMatch(markdown, /^## Implementation plan$/m);
	assert.doesNotMatch(markdown, /^## Test ideas$/m);
});

test("final plan markdown output omits Recommended Split when not provided", () => {
	const markdown = __testables.renderPlanMarkdown({
		title: "Add recurring invoices",
		originalInput: "Add recurring invoices",
		repoContextSummary: "Found invoice modules and tests.",
		scope: ["Create recurring invoices"],
		acceptanceCriteria: ["Users can pause an active recurring invoice"],
		edgeCases: ["Resuming recalculates next run date"],
	});

	assert.doesNotMatch(markdown, /^## Recommended Split$/m);
});

test("resolvePlanOutputPath keeps saved plans inside the repo root", () => {
	assert.equal(
		__testables.resolvePlanOutputPath("/repo", ".pi/plans/feature.plan.md"),
		"/repo/.pi/plans/feature.plan.md",
	);
	assert.throws(
		() => __testables.resolvePlanOutputPath("/repo", "../outside.plan.md"),
		/inside the repository root/i,
	);
});

test("repo root detection and package.json loading fall back to ctx.cwd when no repo root or package.json exists", async () => {
	const repoRoot = await __testables.detectRepoRoot({ cwd: "/tmp/no-package" });
	assert.equal(repoRoot, "/tmp/no-package");

	const pkg = await __testables.loadPlanningPackageJson({ cwd: "/tmp/no-package" }, repoRoot);
	assert.equal(pkg, null);
});

test("keyword extraction, file scanning, and relevant file previews prioritize matching filenames, directories, nearby tests, and docs/specs/plans", async () => {
	const keywords = __testables.extractPlanningKeywords("Add recurring invoices with pause/resume and reminders");
	assert.ok(keywords.includes("recurring"));
	assert.ok(keywords.includes("invoices"));

	const files = [
		"src/invoices/createInvoice.ts",
		"src/billing/schedules.ts",
		"tests/invoices/createInvoice.spec.ts",
		"docs/recurring-invoices.md",
		"plans/old-billing.plan.md",
	];
	const ranked = __testables.rankRelevantFiles(keywords, files, {
		"src/invoices/createInvoice.ts": "create one-off invoices",
		"src/billing/schedules.ts": "billing schedule helpers",
		"tests/invoices/createInvoice.spec.ts": "invoice tests",
		"docs/recurring-invoices.md": "recurring invoice proposal",
		"plans/old-billing.plan.md": "prior billing plan",
	});

	assert.equal(ranked[0]?.path, "docs/recurring-invoices.md");
	assert.ok(ranked.some((entry: { path: string }) => entry.path === "tests/invoices/createInvoice.spec.ts"), "expected nearby tests to be included");
	assert.ok(ranked.some((entry: { preview?: string }) => typeof entry.preview === "string" && entry.preview.length > 0), "expected relevant file previews");
});

test("initial user prompt with repo evidence stays feature-generic and asks narrowing questions before drafting", () => {
	const prompt = __testables.buildInitialUserPrompt({
		originalInput: "add recurring invoices",
		repoContextSummary: "Found invoice schedule helpers in src/billing/schedules.ts and invoice creation in src/invoices/createInvoice.ts.",
		relevantFiles: [
			{ path: "src/billing/schedules.ts", reason: "invoice schedule helpers" },
			{ path: "src/invoices/createInvoice.ts", reason: "invoice creation flow" },
		],
	});

	assert.match(prompt, /directly relevant repo evidence|requested feature: add recurring invoices/i);
	assert.match(prompt, /ask narrowing questions before drafting|before i draft/i);
	assert.doesNotMatch(prompt, /billing-related code exists/i);
});

test("error handling shows 'No active model selected' and 'Authenticate the active model first' for missing model/auth", async () => {
	await assert.rejects(
		() => __testables.assertPlanningPrerequisites({ model: null, auth: { authenticated: true } }),
		/No active model selected/,
	);
	await assert.rejects(
		() => __testables.assertPlanningPrerequisites({ model: { id: "gpt" }, auth: { authenticated: false } }),
		/Authenticate the active model first/,
	);
});

test("shouldCaptureDraftUpdate skips finalized planning sessions and unchanged drafts", () => {
	const state = {
		active: true,
		originId: "leaf-1",
		id: "plan-1",
		title: "Add recurring invoices",
		slug: "add-recurring-invoices",
		originalInput: "Add recurring invoices",
		status: "finalized",
		repoRoot: "/repo",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		relevantFiles: [],
		questions: [],
		assumptions: [],
		decisions: [],
		currentDraft: "# Plan: Add recurring invoices\n",
	};

	assert.equal(__testables.shouldCaptureDraftUpdate(state, "# Plan: Something else\n"), false);
	assert.equal(__testables.shouldCaptureDraftUpdate({ ...state, status: "drafting" }, state.currentDraft), false);
	assert.equal(__testables.shouldCaptureDraftUpdate({ ...state, status: "drafting" }, "# Plan: New draft\n"), true);
});
