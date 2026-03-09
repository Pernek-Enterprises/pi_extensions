import test from "node:test";
import assert from "node:assert/strict";

import tddPlanExtension, { __testables } from "../../extensions/tdd-plan.ts";

test("parseTddPlanArgs recognizes loop and run flags", () => {
	assert.deepEqual(__testables.parseTddPlanArgs(".pi/plans/feature.plan.md --run --loop-auto"), {
		planInput: ".pi/plans/feature.plan.md",
		runTests: true,
		loopMode: "auto-fix",
	});

	assert.deepEqual(__testables.parseTddPlanArgs(".pi/plans/feature.plan.md --loop"), {
		planInput: ".pi/plans/feature.plan.md",
		runTests: false,
		loopMode: "ask-each-round",
	});
});

test("detectSuperficialPatterns flags plan-file and markdown-content assertions", () => {
	const findings = __testables.detectSuperficialPatterns(`
		import { readFileSync } from "node:fs";
		it("checks the plan", () => {
			const markdown = readFileSync(".pi/plans/feature.plan.md", "utf8");
			expect(markdown).toContain("## Acceptance criteria");
		});
	`);

	assert.ok(findings.some((finding: { category: string }) => finding.category === "superficial-source-tests"));
	assert.ok(findings.some((finding: { title: string }) => /markdown|plan/i.test(finding.title)));
});

test("detectSuperficialPatterns does not flag markdown terms outside assertion contexts", () => {
	const findings = __testables.detectSuperficialPatterns(`
		// markdown notes for future maintainers
		const testTitle = "shows acceptance criteria in admin copy";
		it(testTitle, async () => {
			const result = await renderFeature();
			expect(result.status).toBe("ready");
		});
	`);

	assert.deepEqual(findings, []);
});

test("detectCoverageGaps reports uncovered major requirements", () => {
	const findings = __testables.detectCoverageGaps([
		{ heading: "Acceptance criteria", text: "users can pause recurring invoices" },
		{ heading: "Edge cases", text: "resuming recalculates the next run date" },
	], ["users can pause recurring invoices"]);

	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.category, "missing-major-plan-coverage");
	assert.match(findings[0]?.details ?? "", /resuming recalculates the next run date/i);
});

test("requirementCoverageMatches accepts close paraphrases", () => {
	assert.equal(
		__testables.requirementCoverageMatches(
			"resuming recalculates the next run date",
			"resume updates the next run date after recalculation",
		),
		true,
	);
});

test("buildLoopIterationPaths stages iteration artifacts under .pi/generated-tdd/<slug>", () => {
	const repoContext = {
		framework: "vitest" as const,
		packageJsonPath: "package.json",
		testFileExamples: [],
		testDirectories: ["tests"],
		testNamingPatterns: [".spec.ts"],
		testConfigDirectories: [],
		testConfigPatterns: [],
		testScriptDirectories: [],
		testScriptPatterns: [],
		sourceDirectories: ["src"],
		hasTestingLibrary: false,
		hasPlaywright: false,
		hasNodeEnvironment: false,
		hasReact: false,
		scripts: {},
	};
	const paths = __testables.buildLoopIterationPaths("/repo", "/repo/.pi/plans/feature.plan.md", repoContext, 2);
	assert.equal(paths.stagedOutputPath, "/repo/.pi/generated-tdd/feature-plan/feature-plan.plan.spec.iteration-2.ts");
	assert.equal(paths.coveragePath, "/repo/.pi/generated-tdd/feature-plan/iteration-2.coverage.json");
	assert.equal(paths.findingsPath, "/repo/.pi/generated-tdd/feature-plan/iteration-2.findings.json");
	assert.equal(paths.findingsSummaryPath, "/repo/.pi/generated-tdd/feature-plan/iteration-2.findings.md");
});

test("loop state helpers persist, restore, and clear active loop state", async () => {
	const entryLog: Array<any> = [];
	const ctx = {
		state: {},
		pi: {
			appendEntry(entry: any) {
				entryLog.push(entry);
				return { id: `entry-${entryLog.length}` };
			},
		},
		ui: {
			setWidget() {},
			clearWidget() {},
		},
	};
	const state = {
		active: true,
		repoRoot: "/repo",
		planPath: ".pi/plans/feature.plan.md",
		slug: "feature-plan",
		loopMode: "auto-fix" as const,
		status: "generating" as const,
		iteration: 1,
		maxIterations: __testables.LOOP_MAX_ITERATIONS,
		startedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		iterations: [],
	};

	await __testables.applyLoopState(ctx, state);
	assert.deepEqual(__testables.getLoopState(ctx), state);
	assert.ok(entryLog.some((entry) => entry.type === "custom" && entry.customType === "tdd-plan-loop-session" && entry.data?.active === true));

	await __testables.clearLoopState(ctx);
	assert.equal(__testables.getLoopState(ctx), undefined);
	assert.ok(entryLog.some((entry) => entry.type === "custom" && entry.customType === "tdd-plan-loop-session" && entry.data?.active === false));
});


test("loadPersistedLoopState restores loop state from custom session entries", () => {
	const persisted = {
		active: true,
		repoRoot: "/repo",
		planPath: ".pi/plans/feature.plan.md",
		slug: "feature-plan",
		loopMode: "ask-each-round" as const,
		status: "assessing" as const,
		iteration: 2,
		maxIterations: __testables.LOOP_MAX_ITERATIONS,
		startedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:01:00.000Z",
		iterations: [],
	};
	const ctx = {
		state: {},
		sessionManager: {
			getEntries() {
				return [
					{ type: "custom", customType: "tdd-plan-loop-session", data: persisted },
					{ type: "custom", customType: "tdd-plan-loop-session", data: { active: false } },
					{ type: "custom", customType: "tdd-plan-loop-session", value: persisted },
				];
			},
		},
	};

	assert.deepEqual(__testables.loadPersistedLoopState(ctx), persisted);
	assert.deepEqual(__testables.getLoopState(ctx), persisted);
});

test("loop widget reflects iteration, mode, and status", async () => {
	const widgetCalls: any[] = [];
	const cleared: string[] = [];
	const ctx = {
		ui: {
			setWidget(id: string, lines: string[]) {
				widgetCalls.push({ id, lines });
			},
			clearWidget(id: string) {
				cleared.push(id);
			},
		},
	};
	await __testables.setLoopWidget(ctx, {
		active: true,
		repoRoot: "/repo",
		planPath: ".pi/plans/feature.plan.md",
		slug: "feature-plan",
		loopMode: "ask-each-round",
		status: "assessing",
		iteration: 2,
		maxIterations: 4,
		startedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		lastSummary: "2 findings remain",
		iterations: [],
	});
	assert.equal(widgetCalls[0]?.id, "tdd-plan-loop");
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /2\/4/);
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /ask-each-round/);
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /assessing/);

	await __testables.setLoopWidget(ctx, undefined);
	assert.deepEqual(cleared, ["tdd-plan-loop"]);
});

test("loop state helpers support appendEntry(customType, data) signature too", async () => {
	const calls: Array<{ customType: string; data: any }> = [];
	const ctx = {
		state: {},
		pi: {
			appendEntry(customType: string, data: any) {
				calls.push({ customType, data });
				return { id: `entry-${calls.length}` };
			},
		},
	};
	const state = {
		active: true,
		repoRoot: "/repo",
		planPath: ".pi/plans/feature.plan.md",
		slug: "feature-plan",
		loopMode: "auto-fix" as const,
		status: "generating" as const,
		iteration: 1,
		maxIterations: __testables.LOOP_MAX_ITERATIONS,
		startedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		iterations: [],
	};

	await __testables.applyLoopState(ctx, state);
	assert.deepEqual(calls[0], { customType: "tdd-plan-loop-session", data: state });
});

test("assessment isolation helpers branch to a dedicated assessment session and return to origin", async () => {
	const navigations: Array<{ targetId: string; options: unknown }> = [];
	const ctx = {
		currentLeafId: "origin-leaf",
		sessionManager: {
			getEntries() {
				return [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "assistant-1", type: "message", message: { role: "assistant" } },
				];
			},
			getLeafId() {
				return navigations.length === 0 ? "origin-leaf" : "assessment-leaf";
			},
		},
		navigateTree(targetId: string, options: unknown) {
			navigations.push({ targetId, options });
			return { cancelled: false };
		},
		ui: {
			setEditorText() {},
		},
	};

	const started = await __testables.startAssessmentIsolationBranch(ctx);
	assert.equal(started.originId, "origin-leaf");
	assert.equal(started.sessionId, "assessment-leaf");
	assert.equal(navigations[0]?.targetId, "user-1");
	assert.match(JSON.stringify(navigations[0]?.options), /tdd-plan-assessment/);

	await __testables.returnFromAssessmentIsolationBranch(ctx, started.originId);
	assert.deepEqual(navigations[1], { targetId: "origin-leaf", options: { summarize: false } });
});

test("buildAssessmentFeedbackPrompt turns findings into a review-style fix queue", () => {
	const prompt = __testables.buildAssessmentFeedbackPrompt({
		verdict: "fail",
		summary: "Still too superficial.",
		findings: [
			{
				category: "superficial-source-tests",
				severity: "high",
				title: "Reads markdown instead of behavior",
				details: "The suite reads the plan file and asserts on its contents.",
				fix: "Replace plan-file assertions with runtime behavior checks.",
				requirement: "users can pause recurring invoices",
				evidence: ["readFileSync('.pi/plans/feature.plan.md')"],
			},
		],
		strengths: ["Uses the local node:test style."],
	}, "test code here");

	assert.match(prompt, /mandatory fix queue/i);
	assert.match(prompt, /Overall verdict: needs attention/i);
	assert.match(prompt, /Reads markdown instead of behavior/);
	assert.match(prompt, /Required fix: Replace plan-file assertions with runtime behavior checks/i);
	assert.match(prompt, /Previous staged test file to improve/i);
});

test("normalizeAssessment creates an actionable finding when the assessor says fail without findings", () => {
	const normalized = __testables.normalizeAssessment({
		verdict: "fail",
		summary: "Needs more work.",
		findings: [],
		strengths: [],
	});

	assert.equal(normalized.verdict, "fail");
	assert.equal(normalized.findings.length, 1);
	assert.match(normalized.findings[0]?.title ?? "", /fail without actionable findings/i);
});

test("renderAssessmentSummary produces a concise human-readable review report", () => {
	const summary = __testables.renderAssessmentSummary({
		verdict: "fail",
		summary: "2 issues remain.",
		findings: [
			{
				category: "missing-major-plan-coverage",
				severity: "medium",
				title: "Missing pause/resume coverage",
				details: "No test proves pause/resume behavior.",
				fix: "Add explicit pause/resume behavior tests.",
			},
		],
		strengths: ["Uses realistic repository seams."],
	});

	assert.match(summary, /^Verdict: needs attention/m);
	assert.match(summary, /^Findings:$/m);
	assert.match(summary, /Missing pause\/resume coverage/);
	assert.match(summary, /^Fix queue:$/m);
	assert.match(summary, /Add explicit pause\/resume behavior tests/);
});

test("extension registers tdd-plan, tdd-plan-loop, and tdd-plan-status commands", () => {
	const commands = new Set<string>();
	tddPlanExtension({
		on() {},
		registerCommand(name: string) {
			commands.add(name);
		},
	} as any);

	assert.ok(commands.has("tdd-plan"));
	assert.ok(commands.has("tdd-plan-loop"));
	assert.ok(commands.has("tdd-plan-status"));
});
