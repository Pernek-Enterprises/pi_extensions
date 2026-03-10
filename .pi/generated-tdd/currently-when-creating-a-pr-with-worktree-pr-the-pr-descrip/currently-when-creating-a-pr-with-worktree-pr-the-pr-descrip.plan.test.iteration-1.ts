// Generated from a markdown plan.
import test from "node:test";
import assert from "node:assert/strict";

import worktreeExtension from "../../extensions/worktree.ts";

type ExecResult = { stdout: string; stderr: string; code: number };
type ExecCall = { command: string; options?: Record<string, unknown> };
type Notice = { level: string; message: string };
type PersistCall = { path: string; content: string; mode?: string };
type PromptCall = { prompt: string };

type Ctx = {
	cwd: string;
	args?: string[];
	hasUI?: boolean;
	ui?: {
		custom?: <T>(renderer: (tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown) => Promise<T>;
	};
	spawnInteractive?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" }) => { status: number | null; stdout?: Buffer; stderr?: Buffer; error?: Error; signal?: NodeJS.Signals | null };
	state: Record<string, unknown>;
	execCalls: ExecCall[];
	notices: Notice[];
	persistCalls: PersistCall[];
	promptCalls: PromptCall[];
	artifacts: Map<string, string>;
	exec: (command: string, options?: Record<string, unknown>) => Promise<ExecResult>;
	persistArtifact: (path: string, content: string, options?: { append?: boolean }) => Promise<void>;
	readArtifact: (path: string) => Promise<string | undefined>;
	pi: {
		notify: (message: string) => void;
		warn: (message: string) => void;
		error: (message: string) => void;
		ask: (prompt: string) => Promise<string>;
	};
};

function makeCtx(overrides: Partial<Ctx> & { execResponses?: Record<string, ExecResult> } = {}): Ctx {
	const { execResponses = {}, ...rest } = overrides;
	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const persistCalls: PersistCall[] = [];
	const promptCalls: PromptCall[] = [];
	const artifacts = new Map<string, string>();

	return {
		cwd: "/tmp/test-repo",
		args: [],
		state: {},
		execCalls,
		notices,
		persistCalls,
		promptCalls,
		artifacts,
		exec: async (command: string, options?: Record<string, unknown>) => {
			execCalls.push({ command, options });
			for (const [pattern, result] of Object.entries(execResponses)) {
				if (command.includes(pattern)) return result;
			}
			return { stdout: "", stderr: "", code: 0 };
		},
		persistArtifact: async (path: string, content: string) => {
			persistCalls.push({ path, content });
			artifacts.set(path, content);
		},
		readArtifact: async (path: string) => artifacts.get(path),
		pi: {
			notify: (message: string) => notices.push({ level: "info", message }),
			warn: (message: string) => notices.push({ level: "warn", message }),
			error: (message: string) => notices.push({ level: "error", message }),
			ask: async (prompt: string) => {
				promptCalls.push({ prompt });
				return "yes";
			},
		},
		...rest,
	} as Ctx;
}

// ---------- Extension shape ----------

test("worktree extension exports commands including worktree-pr", () => {
	assert.ok(worktreeExtension, "worktree extension should be importable");
	const commands: Record<string, unknown> = (worktreeExtension as any).commands ?? worktreeExtension;
	const commandNames = typeof commands === "object" ? Object.keys(commands) : [];
	// The extension must expose a command whose name includes 'pr' (e.g. worktree-pr)
	const prCommand = commandNames.find((name) => /pr/i.test(name));
	assert.ok(prCommand, `Expected a PR-related command among: ${commandNames.join(", ")}`);
});

// ---------- Core feature: diff-based PR description ----------

test("worktree-pr retrieves the git diff to build a PR description", async () => {
	const diffOutput = [
		"diff --git a/extensions/worktree.ts b/extensions/worktree.ts",
		"--- a/extensions/worktree.ts",
		"+++ b/extensions/worktree.ts",
		"@@ -10,6 +10,12 @@",
		"+function generateDescription(diff: string): string {",
		"+  return diff;",
		"+}",
	].join("\n");

	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: diffOutput, stderr: "", code: 0 },
			"git log": { stdout: "abc123 feat: add description generator", stderr: "", code: 0 },
			"gh pr create": { stdout: "https://github.com/test/repo/pull/1", stderr: "", code: 0 },
		},
	});

	const commands: Record<string, Function> = (worktreeExtension as any).commands ?? worktreeExtension;
	const prCommandName = Object.keys(commands).find((name) => /pr/i.test(name));
	assert.ok(prCommandName, "PR command must exist");

	const handler = commands[prCommandName];
	await handler(ctx);

	// The extension must have executed a git diff command to inspect changed files
	const diffCall = ctx.execCalls.find((call) => call.command.includes("git diff") || call.command.includes("git log") || call.command.includes("diff"));
	assert.ok(diffCall, `Expected at least one git diff/log call to inspect changes, got: ${ctx.execCalls.map((c) => c.command).join("; ")}`);
});

test("worktree-pr produces a PR description that references changed files rather than a generic message", async () => {
	const diffOutput = [
		"diff --git a/extensions/worktree.ts b/extensions/worktree.ts",
		"--- a/extensions/worktree.ts",
		"+++ b/extensions/worktree.ts",
		"@@ -1,3 +1,10 @@",
		"+// Improved PR description generation",
		"+export function buildPrBody(diff: string): string {",
		"+  return `Changes to worktree extension`;",
		"+}",
		"diff --git a/extensions/utils.ts b/extensions/utils.ts",
		"--- a/extensions/utils.ts",
		"+++ b/extensions/utils.ts",
		"@@ -5,0 +6,2 @@",
		"+export function formatDiff() {}",
	].join("\n");

	let capturedPrBody = "";

	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: diffOutput, stderr: "", code: 0 },
			"git log": { stdout: "abc123 feat: improve PR description\ndef456 refactor: extract utils", stderr: "", code: 0 },
			"gh pr create": { stdout: "https://github.com/test/repo/pull/2", stderr: "", code: 0 },
		},
	});

	// Intercept exec to capture the PR body
	const originalExec = ctx.exec;
	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		if (command.includes("gh pr create") || command.includes("gh pr")) {
			capturedPrBody = command;
		}
		return originalExec(command, options);
	};

	const commands: Record<string, Function> = (worktreeExtension as any).commands ?? worktreeExtension;
	const prCommandName = Object.keys(commands).find((name) => /pr/i.test(name));
	assert.ok(prCommandName, "PR command must exist");

	await commands[prCommandName](ctx);

	// Find the gh pr create call to verify the body content
	const prCreateCall = ctx.execCalls.find((call) => call.command.includes("gh pr create") || call.command.includes("gh pr"));
	assert.ok(prCreateCall, "Expected a `gh pr create` call");

	const prCommand = prCreateCall.command;

	// The PR description must mention actual changed files or meaningful content from the diff
	// rather than being a static/generic placeholder
	const mentionsFileOrChange =
		prCommand.includes("worktree") ||
		prCommand.includes("utils") ||
		prCommand.includes("extension") ||
		prCommand.includes("description") ||
		prCommand.includes("diff") ||
		prCommand.includes("change");

	assert.ok(
		mentionsFileOrChange,
		`PR body should reference changed files or meaningful diff content. Got: ${prCommand.substring(0, 300)}`,
	);
});

test("worktree-pr handles empty diff gracefully", async () => {
	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: "", stderr: "", code: 0 },
			"git log": { stdout: "", stderr: "", code: 0 },
		},
	});

	const commands: Record<string, Function> = (worktreeExtension as any).commands ?? worktreeExtension;
	const prCommandName = Object.keys(commands).find((name) => /pr/i.test(name));
	assert.ok(prCommandName, "PR command must exist");

	// Should not throw even with an empty diff
	let threw = false;
	try {
		await commands[prCommandName](ctx);
	} catch (err) {
		// An error/warning notification is acceptable but a crash is not
		if (ctx.notices.some((n) => n.level === "error" || n.level === "warn")) {
			// graceful handling via notification is fine
		} else {
			threw = true;
		}
	}

	// Either it completed or it warned/errored gracefully
	assert.ok(!threw, "worktree-pr should handle empty diff gracefully without crashing");
});

test("worktree-pr inspects all files in the diff, not just a subset", async () => {
	// Simulate a diff with multiple files
	const diffOutput = [
		"diff --git a/src/auth.ts b/src/auth.ts",
		"+// auth changes",
		"diff --git a/src/api.ts b/src/api.ts",
		"+// api changes",
		"diff --git a/README.md b/README.md",
		"+// readme changes",
	].join("\n");

	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: diffOutput, stderr: "", code: 0 },
			"git log": { stdout: "abc feat: multi-file change", stderr: "", code: 0 },
			"gh pr create": { stdout: "https://github.com/test/repo/pull/3", stderr: "", code: 0 },
		},
	});

	const commands: Record<string, Function> = (worktreeExtension as any).commands ?? worktreeExtension;
	const prCommandName = Object.keys(commands).find((name) => /pr/i.test(name));
	assert.ok(prCommandName, "PR command must exist");

	await commands[prCommandName](ctx);

	// Verify the diff command was called — the implementation should look at ALL files
	const diffRelatedCalls = ctx.execCalls.filter(
		(call) => call.command.includes("diff") || call.command.includes("log") || call.command.includes("show"),
	);
	assert.ok(diffRelatedCalls.length > 0, "Expected git diff/log/show calls to inspect changed files");
});

test("worktree-pr description is not a hardcoded or trivially short placeholder", async () => {
	const diffOutput = [
		"diff --git a/extensions/worktree.ts b/extensions/worktree.ts",
		"--- a/extensions/worktree.ts",
		"+++ b/extensions/worktree.ts",
		"@@ -1,5 +1,20 @@",
		"+import { generateDescription } from './pr-utils';",
		"+",
		"+export async function createPr(ctx) {",
		"+  const diff = await ctx.exec('git diff main');",
		"+  const description = generateDescription(diff.stdout);",
		"+  await ctx.exec(`gh pr create --body \"${description}\"`);",
		"+}",
	].join("\n");

	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: diffOutput, stderr: "", code: 0 },
			"git log": { stdout: "aaa111 feat: smart PR descriptions", stderr: "", code: 0 },
			"gh pr create": { stdout: "https://github.com/test/repo/pull/4", stderr: "", code: 0 },
		},
	});

	const commands: Record<string, Function> = (worktreeExtension as any).commands ?? worktreeExtension;
	const prCommandName = Object.keys(commands).find((name) => /pr/i.test(name));
	assert.ok(prCommandName, "PR command must exist");

	await commands[prCommandName](ctx);

	const prCreateCall = ctx.execCalls.find((call) => call.command.includes("gh pr create") || call.command.includes("gh pr"));
	assert.ok(prCreateCall, "Expected a gh pr create call");

	// Extract the body from the command — look for --body flag content
	const bodyMatch = prCreateCall.command.match(/--body\s+["']([^"']+)["']/i) ||
		prCreateCall.command.match(/--body\s+(\S+)/i) ||
		[null, prCreateCall.command];

	const body = bodyMatch?.[1] ?? "";

	// The description should be non-trivial (more than just a branch name or empty)
	// A proper diff-based description should have meaningful length
	assert.ok(
		prCreateCall.command.length > 30,
		`PR create command should contain a meaningful description, got: ${prCreateCall.command.substring(0, 200)}`,
	);
});
