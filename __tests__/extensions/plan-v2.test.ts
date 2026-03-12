import test from "node:test";
import assert from "node:assert/strict";

import planV2Extension, { __testables } from "../../extensions/plan-v2.ts";
import { normalizeExecutionContract, validateExecutionContract } from "../../extensions/planning-v2/contract-validator.ts";
import { extractOpenQuestionsFromRawPlan, mergeQuestions } from "../../extensions/planning-v2/question-loop.ts";

test("slugify produces stable v2 plan slugs", () => {
	assert.equal(__testables.slugify("Fix login 401 flood"), "fix-login-401-flood");
});

test("renderRawPlanMarkdown produces a raw v2 plan skeleton", () => {
	const markdown = __testables.renderRawPlanMarkdown({
		title: "Fix login",
		requestedFeature: "Fix login",
		repoContextSummary: "Found auth files.",
		sections: [{ heading: "Observed behavior", items: ["401 flood on dashboard fetch"] }],
	});
	assert.match(markdown, /^# Plan: Fix login/m);
	assert.match(markdown, /^## Requested feature$/m);
	assert.match(markdown, /^## Observed behavior$/m);
});

test("buildExecutionContractPath writes a v2 .plan.contract.json sibling", () => {
	assert.equal(
		__testables.buildExecutionContractPath(".pi/plans/fix-login.plan.md"),
		".pi/plans/fix-login.plan.contract.json",
	);
});

test("normalizeExecutionContract backfills empty arrays and validateExecutionContract marks weak contracts draft", () => {
	const normalized = normalizeExecutionContract({ goal: "Fix login" });
	assert.deepEqual(normalized.requirements, []);
	assert.deepEqual(normalized.checks, []);
	assert.deepEqual(normalized.advisoryNotes, []);
	const validated = validateExecutionContract(normalized);
	assert.equal(validated.status, "draft");
	assert.match(validated.contractIssues.join(" "), /No executable requirements or checks were compiled/i);
});

test("validateExecutionContract keeps semantically strong contracts ready when notes are advisory", () => {
	const validated = validateExecutionContract({
		artifactType: "execution-contract",
		version: 1,
		generatedAt: "2026-03-11T00:00:00Z",
		source: { rawArtifactPath: ".pi/plans/test.plan.md", rawArtifactKind: "markdown" },
		goal: "Restore Google sign-in",
		requirements: [{ id: "REQ-1", text: "Expose Google sign-in on production login", kind: "behavioral", priority: "primary" }],
		checks: [{ id: "CHK-1", text: "Verify production Google login succeeds", kind: "test" }],
		ambiguities: [{ id: "AMB-1", text: "Exact gating mechanism is not fixed", blocksExecution: false }],
		evidence: [],
		outOfScope: [],
		status: "draft",
		contractIssues: [
			"The contract includes required production runtime/provider configuration that cannot be completed by code changes alone.",
			"Generated timestamp was normalized because the raw artifact did not supply one.",
		],
		advisoryNotes: [],
	});
	assert.equal(validated.status, "ready");
	assert.deepEqual(validated.contractIssues, []);
	assert.equal(validated.advisoryNotes.length, 2);
});

test("question-loop extracts open questions and preserves answered ones", () => {
	const questions = extractOpenQuestionsFromRawPlan(`# Plan: Test\n\n## Open questions\n- Should we keep retries?\n- Is the bug still reproducible?\n`);
	assert.equal(questions.length, 2);
	const merged = mergeQuestions([{ ...questions[0], answer: "No", status: "answered" }], questions);
	assert.equal(merged[0]?.status, "answered");
	assert.equal(merged[0]?.answer, "No");
	assert.equal(merged[1]?.status, "open");
});

test("plan-v2 registers the clean-slate command surface", () => {
	const commands: string[] = [];
	planV2Extension({
		registerCommand(name: string) {
			commands.push(name);
		},
		on() {},
	} as any);
	assert.deepEqual(commands.sort(), ["end-planning-v2", "plan-answer-v2", "plan-save-v2", "plan-status-v2", "plan-tests-v2", "plan-v2"]);
});
