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
