import test from "node:test";
import assert from "node:assert/strict";

import { __testables } from "../../extensions/tdd-plan.ts";

test("detectFramework falls back to test scripts when dependencies are absent", () => {
	assert.equal(__testables.detectFramework({ scripts: { test: "vitest run" } }), "vitest");
	assert.equal(__testables.detectFramework({ scripts: { test: "jest --runInBand" } }), "jest");
});

test("detectFramework ignores unrelated non-test scripts", () => {
	assert.equal(
		__testables.detectFramework({ scripts: { coverage: "node tools/jest-report.js", bench: "vitest-bench" } }),
		"unknown",
	);
});

test("inferScriptTestDirectories extracts colocated and dedicated test directories", () => {
	const entries: Array<[string, string]> = [
		["test", "vitest run src/**/*.test.ts tests/smoke"],
		["test:unit", "node --test __tests__/api/**/*.test.ts"],
	];

	assert.deepEqual(__testables.inferScriptTestDirectories(entries), ["src", "tests/smoke", "__tests__/api"]);
});

test("inferScriptTestPatterns preserves real script suffixes like .tests.mjs", () => {
	const entries: Array<[string, string]> = [["test", "npm run mocha tests/**/*.tests.mjs"]];
	assert.deepEqual(__testables.inferScriptTestPatterns(entries), [".tests.mjs"]);
});

test("config-file discovery extracts directories and patterns before script fallback", () => {
	const configText = `export default defineConfig({ test: { include: ["tests/**/*.tests.mjs"] } })`;
	assert.deepEqual(__testables.inferTestDirectoriesFromText([configText]), ["tests"]);
	assert.deepEqual(__testables.inferTestPatternsFromText([configText]), [".tests.mjs"]);
});

test("node --test fallback keeps TypeScript output when no explicit suffix is present", () => {
	const entries: Array<[string, string]> = [["test", "node --test"]];
	assert.deepEqual(__testables.inferScriptTestPatterns(entries), [".test.ts"]);
});

test("classifyBehavioralHeading prioritizes goal and acceptance sections while excluding plan-metadata sections", () => {
	assert.equal(__testables.classifyBehavioralHeading("Acceptance criteria"), "acceptance");
	assert.equal(__testables.classifyBehavioralHeading("Requested feature"), "goal");
	assert.equal(__testables.classifyBehavioralHeading("User story"), "goal");
	assert.equal(__testables.classifyBehavioralHeading("Clarified decisions"), "decision");
	assert.equal(__testables.classifyBehavioralHeading("Existing codebase context"), null);
	assert.equal(__testables.classifyBehavioralHeading("Implementation plan"), null);
	assert.equal(__testables.classifyBehavioralHeading("Behavior validation"), null);
});

test("collectBehavioralTargets extracts user-visible goals and ignores markdown-plan validation sections", () => {
	const markdown = `# Plan: Frontend deploy workflow

## Requested feature
Create a GitHub Action that deploys the frontend to Cloudflare Pages.

## Existing codebase context
- src/app.tsx already builds the frontend bundle.

## Acceptance criteria
- pushes to main deploy the frontend to Cloudflare Pages
- pull requests run a non-production validation build

## Edge cases
- deployment is skipped when Cloudflare credentials are missing

## Implementation plan
- create .github/workflows/frontend-deploy.yml

## Test ideas
- verify the plan includes primary flow and edge case headings
`;

	const requirements = [
		{ heading: "Acceptance criteria", text: "pushes to main deploy the frontend to Cloudflare Pages" },
		{ heading: "Acceptance criteria", text: "pull requests run a non-production validation build" },
		{ heading: "Edge cases", text: "deployment is skipped when Cloudflare credentials are missing" },
		{ heading: "Test ideas", text: "verify the plan includes primary flow and edge case headings" },
	];

	assert.deepEqual(__testables.collectBehavioralTargets(markdown, requirements), [
		{
			heading: "Requested feature",
			text: "Create a GitHub Action that deploys the frontend to Cloudflare Pages.",
			source: "goal",
		},
		{
			heading: "Acceptance criteria",
			text: "pushes to main deploy the frontend to Cloudflare Pages",
			source: "acceptance",
		},
		{
			heading: "Acceptance criteria",
			text: "pull requests run a non-production validation build",
			source: "acceptance",
		},
		{
			heading: "Edge cases",
			text: "deployment is skipped when Cloudflare credentials are missing",
			source: "edge-case",
		},
	]);
});

test("collectBehavioralTargets keeps prose acceptance criteria while still excluding validation-only headings", () => {
	const markdown = `# Plan: Notifications

## User story
As an admin, I can retry a failed notification from the dashboard.

## Acceptance criteria
Retrying a failed notification queues exactly one new delivery attempt and leaves the failed attempt in history.

## Behavior validation
- verify the plan mentions dashboard retry controls
`;

	assert.deepEqual(__testables.collectBehavioralTargets(markdown, []), [
		{
			heading: "User story",
			text: "As an admin, I can retry a failed notification from the dashboard.",
			source: "goal",
		},
		{
			heading: "Acceptance criteria",
			text: "Retrying a failed notification queues exactly one new delivery attempt and leaves the failed attempt in history.",
			source: "acceptance",
		},
	]);
});

test("pickDefaultOutputPath ignores unsafe model output outside the repo", () => {
	const rootDir = "/repo";
	const planPath = "/repo/plans/feature.md";
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

	assert.equal(
		__testables.pickDefaultOutputPath(rootDir, planPath, repoContext, "../../outside.spec.ts"),
		"/repo/tests/feature.plan.spec.ts",
	);
});

test("pickDefaultOutputPath honors safe non-generic model output inside the repo", () => {
	const rootDir = "/repo";
	const planPath = "/repo/plans/feature.md";
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

	assert.equal(
		__testables.pickDefaultOutputPath(rootDir, planPath, repoContext, "src/generated/feature.plan.test.ts"),
		"/repo/src/generated/feature.plan.test.ts",
	);
});

test("choosePreferredTestDirectory prefers dedicated test directories over src", () => {
	assert.equal(
		__testables.choosePreferredTestDirectory({
			framework: "vitest",
			packageJsonPath: "package.json",
			testFileExamples: [],
			testDirectories: ["tests"],
			testNamingPatterns: [".spec.ts"],
			testConfigDirectories: [],
			testConfigPatterns: [],
			testScriptDirectories: ["src", "tests"],
			testScriptPatterns: [".test.ts"],
			sourceDirectories: ["src"],
			hasTestingLibrary: false,
			hasPlaywright: false,
			hasNodeEnvironment: false,
			hasReact: false,
			scripts: { test: "vitest run src/**/*.test.ts tests/**/*.spec.ts" },
		}),
		"tests",
	);
});

test("buildDiscoveryAwareOutputPath honors config-derived tests dir and .tests.mjs pattern", () => {
	const rootDir = "/repo";
	const planPath = "/repo/plans/login.md";
	const repoContext = {
		framework: "unknown" as const,
		packageJsonPath: "package.json",
		testFileExamples: [],
		testDirectories: ["test"],
		testNamingPatterns: [".test.js"],
		testConfigDirectories: ["tests"],
		testConfigPatterns: [".tests.mjs"],
		testScriptDirectories: ["test"],
		testScriptPatterns: [".test.js"],
		sourceDirectories: ["src"],
		hasTestingLibrary: false,
		hasPlaywright: false,
		hasNodeEnvironment: false,
		hasReact: false,
		scripts: { test: "npm run test test/**/*.test.js" },
	};

	assert.equal(
		__testables.buildDiscoveryAwareOutputPath(rootDir, planPath, repoContext),
		"/repo/tests/login.plan.tests.mjs",
	);
});

test("choosePreferredTestDirectory still uses src for colocated-only setups", () => {
	assert.equal(
		__testables.choosePreferredTestDirectory({
			framework: "vitest",
			packageJsonPath: "package.json",
			testFileExamples: [],
			testDirectories: [],
			testNamingPatterns: [".test.ts"],
			testConfigDirectories: [],
			testConfigPatterns: [],
			testScriptDirectories: ["src"],
			testScriptPatterns: [".test.ts"],
			sourceDirectories: ["src"],
			hasTestingLibrary: false,
			hasPlaywright: false,
			hasNodeEnvironment: false,
			hasReact: false,
			scripts: { test: "vitest run src/**/*.test.ts" },
		}),
		"src",
	);
});

test("choosePreferredTestPattern keeps TypeScript fallback for jest when no repo hints exist", () => {
	assert.equal(
		__testables.choosePreferredTestPattern({
			framework: "jest",
			packageJsonPath: "package.json",
			testFileExamples: [],
			testDirectories: [],
			testNamingPatterns: [],
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
		}),
		".test.ts",
	);
});

test("system prompt explicitly forbids tests against plan markdown itself", () => {
	assert.match(__testables.systemPrompt, /never write tests that assert on the plan file itself/i);
	assert.match(__testables.systemPrompt, /markdown headings/i);
	assert.match(__testables.systemPrompt, /documentation content/i);
	assert.match(__testables.systemPrompt, /intended product or system behavior/i);
	assert.match(__testables.systemPrompt, /mandatory fix queue/i);
	assert.match(__testables.systemPrompt, /rewrite freely when needed/i);
});

test("assessor prompt requires discrete actionable findings and only passes when the loop should stop", () => {
	assert.match(__testables.assessorSystemPrompt, /behave like a code reviewer/i);
	assert.match(__testables.assessorSystemPrompt, /only return verdict="pass" when you would be comfortable stopping the loop now/i);
	assert.match(__testables.assessorSystemPrompt, /findings must contain at least one actionable item/i);
	assert.match(__testables.assessorSystemPrompt, /concrete evidence/i);
});
