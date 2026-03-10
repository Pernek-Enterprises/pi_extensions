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
	assert.equal(paths.fixHandoffPath, "/repo/.pi/generated-tdd/feature-plan/iteration-2.fix-handoff.md");
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
			setWidget(id: string, widget: any) {
				const rendered = typeof widget === "function"
					? String(widget(null, { fg: (_color: string, value: string) => value }).render(120))
					: String(widget);
				widgetCalls.push({ id, lines: rendered.split("\n") });
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
		lastBlockingCount: 1,
		lastAdvisoryCount: 1,
		lastHighestPriorityBand: "P1",
		iterations: [],
	});
	assert.equal(widgetCalls[0]?.id, "tdd-plan-loop");
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /2\/4/);
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /ask-each-round/);
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /assessing/);
	assert.match(widgetCalls[0]?.lines.join("\n") ?? "", /blockers: 1 \(P1\)/);

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

test("buildAssessmentFeedbackPrompt turns findings into a blocker-first review-style fix queue", () => {
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
			{
				category: "other",
				severity: "low",
				title: "Minor naming polish",
				details: "One test title could be clearer.",
				fix: "Rename the title if convenient.",
			},
		],
		strengths: ["Uses the local node:test style."],
	}, "test code here");

	assert.match(prompt, /mandatory fix queue/i);
	assert.match(prompt, /Overall verdict: needs attention/i);
	assert.match(prompt, /Blockers remaining: 1 \(highest blocker band: P1\)/i);
	assert.match(prompt, /^Blockers:$/m);
	assert.match(prompt, /^Advisories:$/m);
	assert.match(prompt, /Reads markdown instead of behavior/);
	assert.match(prompt, /Required fix: Replace plan-file assertions with runtime behavior checks/i);
	assert.match(prompt, /Keep every fix repo-grounded/i);
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

test("renderAssessmentSummary produces a blocker-aware human-readable review report", () => {
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
				requirement: "Users can pause and resume recurring invoices",
				evidence: ["section: Acceptance criteria"],
			},
		],
		strengths: ["Uses realistic repository seams."],
	});

	assert.match(summary, /^Verdict: needs attention/m);
	assert.match(summary, /^Blockers: 1$/m);
	assert.match(summary, /^Highest blocker band: P2$/m);
	assert.match(summary, /^Top blockers:$/m);
	assert.match(summary, /^Findings:$/m);
	assert.match(summary, /Missing pause\/resume coverage/);
	assert.match(summary, /^Fix queue:$/m);
	assert.match(summary, /Add explicit pause\/resume behavior tests/);
});

test("classifyFinding treats any high-severity finding as blocking", () => {
	assert.deepEqual(
		__testables.classifyFinding({
			category: "superficial-source-tests",
			severity: "high",
			title: "Bad test",
			details: "Details",
			fix: "Fix it",
		}),
		{ disposition: "blocking", priorityBand: "P1" },
	);
});

test("classifyFinding blocks medium unrealistic or non-executable findings", () => {
	assert.deepEqual(
		__testables.classifyFinding({
			category: "non-executable-or-unrealistic",
			severity: "medium",
			title: "Invented API",
			details: "The suite invents a non-existent API.",
			fix: "Use an existing seam.",
		}),
		{ disposition: "blocking", priorityBand: "P1" },
	);
});

test("classifyFinding blocks medium ambiguity only when it prevents repo-grounded tests", () => {
	assert.deepEqual(
		__testables.classifyFinding({
			category: "ambiguity",
			severity: "medium",
			title: "Cannot infer real seam",
			details: "The plan is too vague to write repo-grounded tests without inventing wiring.",
			fix: "Clarify the supported seam.",
		}),
		{ disposition: "blocking", priorityBand: "P2" },
	);
	assert.deepEqual(
		__testables.classifyFinding({
			category: "ambiguity",
			severity: "medium",
			title: "Minor wording ambiguity",
			details: "Some naming is vague but tests can still be grounded.",
			fix: "Clarify naming later.",
		}),
		{ disposition: "advisory", priorityBand: "P3" },
	);
});

test("classifyFinding blocks medium missing major coverage for primary behavior but not meta-only requirements", () => {
	assert.deepEqual(
		__testables.classifyFinding({
			category: "missing-major-plan-coverage",
			severity: "medium",
			title: "Missing primary flow",
			details: "No test proves the main behavior.",
			fix: "Add the missing coverage.",
			requirement: "Users can pause recurring invoices",
			evidence: ["section: Acceptance criteria"],
		}),
		{ disposition: "blocking", priorityBand: "P2" },
	);
	assert.deepEqual(
		__testables.classifyFinding({
			category: "missing-major-plan-coverage",
			severity: "medium",
			title: "Missing scope behavior",
			details: "No test proves the scoped operational guarantee.",
			fix: "Add the missing coverage.",
			requirement: "Audit log entries are visible after pause/resume",
			evidence: ["section: Scope"],
		}),
		{ disposition: "blocking", priorityBand: "P2" },
	);
	assert.deepEqual(
		__testables.classifyFinding({
			category: "missing-major-plan-coverage",
			severity: "medium",
			title: "Missing meta bullet",
			details: "No generated coverage entry clearly maps to the meta plan-quality item.",
			fix: "Optional.",
			requirement: "The plan cites affected modules or explicitly notes when no prior module exists.",
			evidence: ["section: Acceptance criteria"],
		}),
		{ disposition: "advisory", priorityBand: "P3" },
	);
});

test("hasBlockingFindings uses the richer blocker policy", () => {
	assert.equal(
		__testables.hasBlockingFindings({
			verdict: "fail",
			summary: "Issues found.",
			findings: [
				{ category: "other", severity: "low", title: "Minor issue", details: "Details", fix: "Fix it" },
				{ category: "non-executable-or-unrealistic", severity: "medium", title: "Invented API", details: "Details", fix: "Fix it" },
			],
			strengths: [],
		}),
		true,
	);
	assert.equal(
		__testables.hasBlockingFindings({
			verdict: "fail",
			summary: "Advisory only.",
			findings: [
				{ category: "other", severity: "low", title: "Minor issue", details: "Details", fix: "Fix it" },
				{ category: "other", severity: "medium", title: "Medium polish", details: "Details", fix: "Fix it" },
			],
			strengths: [],
		}),
		false,
	);
});

test("summarizeAssessmentFindings reports blocker counts, advisory counts, and highest priority", () => {
	const summary = __testables.summarizeAssessmentFindings({
		verdict: "fail",
		summary: "Mixed findings.",
		findings: [
			{ category: "non-executable-or-unrealistic", severity: "medium", title: "Invented API", details: "Details", fix: "Fix it" },
			{ category: "other", severity: "low", title: "Minor polish", details: "Details", fix: "Fix it" },
		],
		strengths: [],
	});

	assert.equal(summary.blockingCount, 1);
	assert.equal(summary.advisoryCount, 1);
	assert.equal(summary.highestPriorityBand, "P1");
	assert.equal(summary.severityCounts.medium, 1);
	assert.equal(summary.severityCounts.low, 1);
	assert.equal(summary.categoryCounts["non-executable-or-unrealistic"], 1);
});

test("hasBlockingFindings returns false when there are no findings", () => {
	assert.equal(
		__testables.hasBlockingFindings({
			verdict: "pass",
			summary: "All good.",
			findings: [],
			strengths: [],
		}),
		false,
	);
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
