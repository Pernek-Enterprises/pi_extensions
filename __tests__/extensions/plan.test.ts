import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import planExtension, { __testables } from "../../extensions/plan.ts";
import { normalizeExecutionContract, validateExecutionContract } from "../../extensions/planning/contract-validator.ts";
import { extractOpenQuestionsFromRawPlan, mergeQuestions } from "../../extensions/planning/question-loop.ts";

test("slugify produces stable plan slugs", () => {
	assert.equal(__testables.slugify("Fix login 401 flood"), "fix-login-401-flood");
});

test("plan URL detection and title helpers are stable", () => {
	assert.equal(__testables.isProbablyUrl("https://github.com/org/repo/issues/123"), true);
	assert.equal(__testables.isProbablyUrl("Fix login"), false);
	assert.equal(__testables.deriveTitleFromLink("https://github.com/org/repo/issues/123"), "Issue 123");
	assert.deepEqual(
		__testables.parseGithubWorkItemLink("https://github.com/org/repo/issues/123"),
		{ owner: "org", repo: "repo", kind: "issue", number: "123" },
	);
	assert.deepEqual(
		__testables.deriveSmartLinkIdentity("https://github.com/org/repo/issues/123", "Fix login 401 flood · org/repo · GitHub"),
		{ title: "Issue 123: Fix login 401 flood", slug: "repo-issue-123-fix-login-401-flood" },
	);
	assert.deepEqual(
		__testables.deriveSmartFileIdentity("docs/issue.md", "# Problem\n\nUsers see login failures.\n"),
		{ title: "Problem", slug: "docs-issue-problem" },
	);
});

test("renderRawPlanMarkdown produces a raw plan skeleton", () => {
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

test("buildExecutionContractPath writes a .plan.contract.json sibling", () => {
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

test("plan initializes a canonical draft under .pi/plans", async () => {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const messages: string[] = [];
	planExtension({
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, def.handler);
		},
		on() {},
		sendUserMessage(message: string) {
			messages.push(message);
		},
	} as any);

	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-ext-"));
	await fs.writeFile(path.join(repoRoot, "package.json"), "{}\n", "utf8");
	const notices: string[] = [];
	const ctx = {
		cwd: repoRoot,
		state: {},
		notify(message: string) {
			notices.push(message);
		},
	};

	await commands.get("plan")?.("Fix login", ctx);
	const planningState = (ctx.state as any).planning;
	assert.equal(planningState.savedPath, ".pi/plans/fix-login.plan.md");
	const savedDraft = await fs.readFile(path.join(repoRoot, ".pi/plans/fix-login.plan.md"), "utf8");
	assert.match(savedDraft, /^# Plan: Fix login/m);
	assert.ok(messages.some((message) => message.includes("Canonical raw plan path: .pi/plans/fix-login.plan.md")));
	assert.ok(notices.some((message) => message.includes("Canonical draft path: .pi/plans/fix-login.plan.md")));
});

test("resolvePlanSaveInput prefers the saved draft file over stale in-memory markdown", async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-resolve-"));
	await fs.mkdir(path.join(repoRoot, ".pi/plans"), { recursive: true });
	await fs.writeFile(path.join(repoRoot, ".pi/plans/fix-login.plan.md"), "# Plan: Disk copy\n\n## Requested feature\nDisk version\n", "utf8");
	const resolved = await __testables.resolvePlanSaveInput({
		repoRoot,
		state: {
			active: true,
			title: "Fix login",
			slug: "fix-login",
			originalInput: "Fix login",
			repoRoot,
			relevantFiles: [],
			rawDraft: "# Plan: Memory copy\n",
			questions: [],
			savedPath: ".pi/plans/fix-login.plan.md",
		},
	});
	assert.equal(resolved?.source, "active-file");
	assert.equal(resolved?.rawDraft.includes("Disk version"), true);
});

test("plan-from-file seeds planning from a source file and still uses the canonical draft path", async () => {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const messages: string[] = [];
	planExtension({
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, def.handler);
		},
		on() {},
		sendUserMessage(message: string) {
			messages.push(message);
		},
	} as any);

	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-file-"));
	await fs.writeFile(path.join(repoRoot, "package.json"), "{}\n", "utf8");
	await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
	await fs.writeFile(path.join(repoRoot, "docs", "issue.md"), "# Problem\n\nUsers see login failures.\n", "utf8");
	const ctx = { cwd: repoRoot, state: {}, notify() {} };

	await commands.get("plan-from-file")?.("docs/issue.md", ctx);
	const planningState = (ctx.state as any).planning;
	assert.equal(planningState.source.kind, "file");
	assert.equal(planningState.source.value, path.join("docs", "issue.md"));
	assert.equal(planningState.savedPath, ".pi/plans/docs-issue-problem.plan.md");
	assert.ok(messages.some((message) => message.includes("Primary source file: docs/issue.md")));
	assert.ok(messages.some((message) => message.includes("Users see login failures.")));
});

test("plan with a URL routes to link-based planning and derives a better slug", async () => {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const notices: string[] = [];
	const messages: string[] = [];
	planExtension({
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, def.handler);
		},
		on() {},
		sendUserMessage(message: string) {
			messages.push(message);
		},
	} as any);

	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-link-"));
	await fs.writeFile(path.join(repoRoot, "package.json"), "{}\n", "utf8");
	const ctx = {
		cwd: repoRoot,
		state: {},
		notify(message: string) {
			notices.push(message);
		},
	};

	const originalFetch = globalThis.fetch;
	(globalThis as any).fetch = async () => ({
		ok: true,
		text: async () => '<html><head><meta property="og:title" content="Fix login 401 flood · org/repo · GitHub"></head></html>',
	}) as Response;
	try {
		await commands.get("plan")?.("https://github.com/org/repo/issues/123", ctx);
	} finally {
		(globalThis as any).fetch = originalFetch;
	}
	const planningState = (ctx.state as any).planning;
	assert.equal(planningState.source.kind, "link");
	assert.equal(planningState.source.value, "https://github.com/org/repo/issues/123");
	assert.equal(planningState.title, "Issue 123: Fix login 401 flood");
	assert.equal(planningState.savedPath, ".pi/plans/repo-issue-123-fix-login-401-flood.plan.md");
	assert.ok(notices.some((message) => message.includes("Detected a link")));
	assert.ok(messages.some((message) => message.includes("Fetch/read the link before drafting the plan.")));
	assert.ok(messages.some((message) => message.includes("Primary source link: https://github.com/org/repo/issues/123")));
});

test("resolvePlanSaveInput treats a missing requested path as the save destination when planning is active", async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-dest-"));
	const resolved = await __testables.resolvePlanSaveInput({
		repoRoot,
		requestedPath: "docs/fix-login.plan.md",
		state: {
			active: true,
			title: "Fix login",
			slug: "fix-login",
			originalInput: "Fix login",
			repoRoot,
			relevantFiles: [],
			rawDraft: "# Plan: Memory copy\n",
			questions: [],
		},
	});
	assert.equal(resolved?.source, "requested-state");
	assert.equal(resolved?.rawRelativePath, path.join("docs", "fix-login.plan.md"));
	assert.equal(resolved?.rawDraft, "# Plan: Memory copy\n");
});

test("resolvePathWithinRepo rejects repo-escaping paths and persistRawPlanDraft refuses to write them", async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-safe-path-"));
	assert.equal(__testables.resolvePathWithinRepo(repoRoot, "../outside.plan.md"), undefined);
	await assert.rejects(
		() => __testables.persistRawPlanDraft(repoRoot, "../outside.plan.md", "# nope\n"),
		/outside the repository root/i,
	);
});

test("resolvePlanSaveInput derives the title from an existing raw plan heading", async () => {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-heading-"));
	await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
	await fs.writeFile(
		path.join(repoRoot, "docs", "issue.plan.md"),
		"# Plan: Existing heading\n\n## Requested feature\nUse the heading\n",
		"utf8",
	);
	const resolved = await __testables.resolvePlanSaveInput({
		repoRoot,
		requestedPath: "docs/issue.plan.md",
	});
	assert.equal(resolved?.source, "requested-file");
	assert.equal(resolved?.title, "Existing heading");
	assert.equal(resolved?.originalInput, "Use the heading");
});

test("plan-from-file rejects files outside the repository root", async () => {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const messages: string[] = [];
	planExtension({
		registerCommand(name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, def.handler);
		},
		on() {},
		sendUserMessage(message: string) {
			messages.push(message);
		},
	} as any);

	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-file-outside-"));
	await fs.writeFile(path.join(repoRoot, "package.json"), "{}\n", "utf8");
	const parentFile = path.join(path.dirname(repoRoot), "external-issue.md");
	await fs.writeFile(parentFile, "# External\n", "utf8");
	const notices: string[] = [];
	const ctx = {
		cwd: repoRoot,
		state: {},
		notify(message: string) {
			notices.push(message);
		},
	};

	await commands.get("plan-from-file")?.("../external-issue.md", ctx);
	assert.equal((ctx.state as any).planning, undefined);
	assert.ok(notices.some((message) => message.includes("Source file must stay within the repository root")));
	assert.deepEqual(messages, []);
});

test("plan extension registers the clean-slate command surface", () => {
	const commands: string[] = [];
	planExtension({
		registerCommand(name: string) {
			commands.push(name);
		},
		on() {},
	} as any);
	assert.deepEqual(commands.sort(), [
		"end-planning",
		"plan",
		"plan-answer",
		"plan-from-file",
		"plan-from-link",
		"plan-from-scratch",
		"plan-next",
		"plan-save",
		"plan-status",
	]);
});
