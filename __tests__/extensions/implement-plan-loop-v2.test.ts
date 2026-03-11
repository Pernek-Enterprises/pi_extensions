import test from "node:test";
import assert from "node:assert/strict";

import implementPlanLoopV2Extension, { __testables } from "../../extensions/implement-plan-loop-v2.ts";
import { buildImplementationLoopArtifactPaths, slugFromContractPath } from "../../extensions/implement-v2/loop-artifacts.ts";

test("slugFromContractPath derives a stable slug for implementation loop artifacts", () => {
	assert.equal(slugFromContractPath(".pi/plans/fix-login.plan.contract.json"), "fix-login");
});

test("buildImplementationLoopArtifactPaths stages iteration artifacts under .pi/generated-implementation-v2", () => {
	const paths = buildImplementationLoopArtifactPaths("/repo", ".pi/plans/fix-login.plan.contract.json", 2);
	assert.equal(paths.implementationSummaryPath, "/repo/.pi/generated-implementation-v2/fix-login/iteration-2.implementation-summary.md");
	assert.equal(paths.reviewJsonPath, "/repo/.pi/generated-implementation-v2/fix-login/iteration-2.review.json");
	assert.equal(paths.triageJsonPath, "/repo/.pi/generated-implementation-v2/fix-login/iteration-2.triage.json");
	assert.equal(paths.evidenceBundlePath, "/repo/.pi/generated-implementation-v2/fix-login/iteration-2.evidence-bundle.json");
	assert.equal(paths.externalValidationPath, "/repo/.pi/generated-implementation-v2/fix-login/iteration-2.external-validation.md");
});

test("implement-plan-loop-v2 registers the expected command surface", () => {
	const commands: string[] = [];
	implementPlanLoopV2Extension({
		registerCommand(name: string) {
			commands.push(name);
		},
		on() {},
	} as any);
	assert.deepEqual(commands.sort(), ["end-implement-plan-loop-v2", "implement-plan-loop-v2", "implement-plan-loop-v2-status"]);
});

test("implement loop state helpers persist and clear active state", async () => {
	const entryLog: any[] = [];
	const ctx = {
		state: {},
		pi: {
			appendEntry(entry: any) {
				entryLog.push(entry);
				return { id: `entry-${entryLog.length}` };
			},
		},
	};
	const state = {
		active: true,
		repoRoot: "/repo",
		contractPath: ".pi/plans/fix-login.plan.contract.json",
		slug: "fix-login",
		status: "preflight" as const,
		iteration: 0,
		maxIterations: __testables.IMPLEMENT_LOOP_V2_MAX_ITERATIONS,
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		changedFiles: [],
		iterations: [],
	};
	await __testables.applyImplementLoopV2State(ctx, state);
	assert.deepEqual(__testables.getImplementLoopV2State(ctx), state);
	await __testables.clearImplementLoopV2State(ctx);
	assert.equal(__testables.getImplementLoopV2State(ctx), undefined);
	assert.ok(entryLog.some((entry) => entry.type === "custom" && entry.customType === "implement-plan-loop-v2-session"));
});

test("extractImplementationSummary prefers explicit summary section", () => {
	const summary = __testables.extractImplementationSummary("# Done\n\n## Implementation summary\nChanged files:\n- src/App.tsx");
	assert.match(summary, /Changed files/i);
});

test("parseChangedFilesFromPorcelain preserves file names and excludes .pi paths", () => {
	const changed = __testables.parseChangedFilesFromPorcelain([" M index.html", " M src/App.tsx", "?? .pi/generated-implementation-v2/foo/bar.md", "?? app.html"].join("\n"));
	assert.deepEqual(changed, ["index.html", "src/App.tsx", "app.html"]);
});

test("normalizeReview infers evidence resolution type for under-evidenced blockers", () => {
	const review = __testables.normalizeReview({
		verdict: "fail",
		summary: "Need more proof",
		satisfiedRequirementIds: [],
		partialRequirementIds: [],
		unsatisfiedRequirementIds: [],
		supportedCheckIds: [],
		unsupportedCheckIds: ["CHK-15"],
		findings: [
			{
				category: "config-gap",
				disposition: "blocking",
				title: "Build wiring is not evidenced end-to-end",
				details: "The provided repository evidence does not demonstrate that app.html is emitted.",
				suggestedFix: "Provide stronger repository-visible evidence.",
				targetIds: ["REQ-15"],
				targetFiles: ["app.html"],
			} as any,
		],
	});
	assert.equal(review.findings[0].resolutionType, "evidence");
});

test("triage routes implementation blockers to repairing", () => {
	const decision = __testables.buildTriageDecision({
		verdict: "fail",
		summary: "Need repo changes",
		satisfiedRequirementIds: [],
		partialRequirementIds: [],
		unsatisfiedRequirementIds: ["REQ-4"],
		supportedCheckIds: [],
		unsupportedCheckIds: [],
		findings: [
			{
				category: "runtime-behavior",
				disposition: "blocking",
				resolutionType: "implementation",
				title: "Marketing page still links to an unprefixed app route",
				details: "Needs code change.",
				suggestedFix: "Fix the route.",
				targetIds: ["REQ-4"],
				targetFiles: ["index.html"],
			},
		],
		strengths: [],
	}, undefined, "implementing");
	assert.equal(decision.nextState, "repairing");
});

test("triage routes evidence blockers to gathering-evidence", () => {
	const decision = __testables.buildTriageDecision({
		verdict: "fail",
		summary: "Need better proof",
		satisfiedRequirementIds: [],
		partialRequirementIds: [],
		unsatisfiedRequirementIds: [],
		supportedCheckIds: [],
		unsupportedCheckIds: ["CHK-15"],
		findings: [
			{
				category: "config-gap",
				disposition: "blocking",
				resolutionType: "evidence",
				title: "Split-entry build is not evidenced",
				details: "Need file/build proof.",
				suggestedFix: "Gather stronger evidence.",
				targetIds: ["REQ-15"],
				targetFiles: ["app.html", "vite.config.ts"],
			},
		],
		strengths: [],
	}, undefined, "repairing");
	assert.equal(decision.nextState, "gathering-evidence");
});

test("triage falls back to repairing after repeated evidence blockers in evidence mode", () => {
	const repeatedSignature = "evidence|config-gap|REQ-15|app.html|split entry";
	const decision = __testables.buildTriageDecision({
		verdict: "fail",
		summary: "Still not proven",
		satisfiedRequirementIds: [],
		partialRequirementIds: [],
		unsatisfiedRequirementIds: [],
		supportedCheckIds: [],
		unsupportedCheckIds: ["CHK-15"],
		findings: [
			{
				category: "config-gap",
				disposition: "blocking",
				resolutionType: "evidence",
				title: "Split entry",
				details: "Still not evidenced.",
				suggestedFix: "Prove or repair.",
				targetIds: ["REQ-15"],
				targetFiles: ["app.html"],
			},
		],
		strengths: [],
	}, {
		iteration: 1,
		mode: "gathering-evidence",
		reviewJsonPath: "iteration-1.review.json",
		reviewMarkdownPath: "iteration-1.review.md",
		changedFilesPath: "iteration-1.changed-files.json",
		diffPath: "iteration-1.diff.patch",
		blockingCount: 1,
		advisoryCount: 0,
		implementationBlockingCount: 0,
		evidenceBlockingCount: 1,
		externalValidationBlockingCount: 0,
		summary: "Still not proven",
		targetIds: ["REQ-15"],
		targetFiles: ["app.html"],
		changedFiles: ["app.html"],
		blockerSignatures: [repeatedSignature],
		triageDecision: "gathering-evidence",
	} as any, "gathering-evidence");
	assert.equal(decision.nextState, "repairing");
});
