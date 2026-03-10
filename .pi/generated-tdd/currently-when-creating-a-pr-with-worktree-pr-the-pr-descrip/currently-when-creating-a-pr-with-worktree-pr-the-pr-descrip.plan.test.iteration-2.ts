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

/**
 * Helper to extract the --body content from a `gh pr create` command string.
 * Handles both quoted (single/double) and unquoted body values.
 */
function extractPrBody(command: string): string {
	// Try --body '...' or --body "..."
	const singleQuoteMatch = command.match(/--body\s+'([^']*(?:''[^']*)*)'/s);
	if (singleQuoteMatch) return singleQuoteMatch[1];

	const doubleQuoteMatch = command.match(/--body\s+"([^"]*(?:""[^"]*)*)"/s);
	if (doubleQuoteMatch) return doubleQuoteMatch[1];

	// Try --body $'...' (bash ANSI-C quoting)
	const dollarQuoteMatch = command.match(/--body\s+\$'([^']*)'/s);
	if (dollarQuoteMatch) return dollarQuoteMatch[1];

	// Fallback: unquoted value until next flag or end
	const unquotedMatch = command.match(/--body\s+(\S+)/s);
	if (unquotedMatch) return unquotedMatch[1];

	return "";
}

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

function findPrCommandName(ext: unknown): string {
	const commands: Record<string, unknown> = (ext as any).commands ?? (ext as Record<string, unknown>);
	const names = typeof commands === "object" && commands !== null ? Object.keys(commands) : [];
	const prCmd = names.find((name) => /pr/i.test(name));
	if (!prCmd) throw new Error(`Expected a PR-related command among: ${names.join(", ")}`);
	return prCmd;
}

function getPrHandler(ext: unknown): Function {
	const commands: Record<string, unknown> = (ext as any).commands ?? (ext as Record<string, unknown>);
	const name = findPrCommandName(ext);
	return commands[name] as Function;
}

// ---------- Extension shape ----------

test("worktree extension exports commands including worktree-pr", () => {
	assert.ok(worktreeExtension, "worktree extension should be importable");
	const commands: Record<string, unknown> = (worktreeExtension as any).commands ?? worktreeExtension;
	const commandNames = typeof commands === "object" ? Object.keys(commands) : [];
	const prCommand = commandNames.find((name) => /pr/i.test(name));
	assert.ok(prCommand, `Expected a PR-related command among: ${commandNames.join(", ")}`);
});

// ---------- Core feature: diff-based PR description with actual file paths ----------

test("worktree-pr produces a PR description that references actual changed file paths from the diff", async () => {
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

	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: diffOutput, stderr: "", code: 0 },
			"git log": { stdout: "abc123 feat: improve PR description\ndef456 refactor: extract utils", stderr: "", code: 0 },
			"gh pr create": { stdout: "https://github.com/test/repo/pull/2", stderr: "", code: 0 },
		},
	});

	const handler = getPrHandler(worktreeExtension);
	await handler(ctx);

	// Find the gh pr create call
	const prCreateCall = ctx.execCalls.find((call) => call.command.includes("gh pr create") || call.command.includes("gh pr"));
	assert.ok(prCreateCall, "Expected a `gh pr create` call");

	const prBody = extractPrBody(prCreateCall.command);
	const fullCommand = prCreateCall.command;

	// The PR body must reference the actual file paths from the diff, not generic words
	const mentionsWorktreeTs = fullCommand.includes("worktree.ts") || prBody.includes("worktree.ts");
	const mentionsUtilsTs = fullCommand.includes("utils.ts") || prBody.includes("utils.ts");

	assert.ok(
		mentionsWorktreeTs,
		`PR body must reference 'worktree.ts' (an actual changed file). Body: ${prBody.substring(0, 500) || fullCommand.substring(0, 500)}`,
	);
	assert.ok(
		mentionsUtilsTs,
		`PR body must reference 'utils.ts' (an actual changed file). Body: ${prBody.substring(0, 500) || fullCommand.substring(0, 500)}`,
	);
});

test("worktree-pr description is not a hardcoded or trivially short placeholder — body has meaningful diff-derived content", async () => {
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

	const handler = getPrHandler(worktreeExtension);
	await handler(ctx);

	const prCreateCall = ctx.execCalls.find((call) => call.command.includes("gh pr create") || call.command.includes("gh pr"));
	assert.ok(prCreateCall, "Expected a gh pr create call");

	const prBody = extractPrBody(prCreateCall.command);

	// (1) The body text must exceed a meaningful threshold
	assert.ok(
		prBody.length >= 50,
		`PR body should be at least 50 characters of meaningful description. Got ${prBody.length} chars: '${prBody.substring(0, 200)}'`,
	);

	// (2) The body must contain content derived from the diff (file names)
	assert.ok(
		prBody.includes("worktree.ts") || prBody.includes("worktree"),
		`PR body should reference files/content from the diff. Body: '${prBody.substring(0, 300)}'`,
	);

	// (3) The body must not be a known trivial placeholder
	const knownPlaceholders = [
		"",
		"description",
		"PR description",
		"no description",
		"Created by worktree",
		"Worktree PR",
		"Auto-generated PR",
	];
	for (const placeholder of knownPlaceholders) {
		assert.notEqual(
			prBody.trim().toLowerCase(),
			placeholder.toLowerCase(),
			`PR body must not be the trivial placeholder '${placeholder}'`,
		);
	}
});

test("worktree-pr inspects all files in the diff — PR body references every changed file", async () => {
	const diffOutput = [
		"diff --git a/src/auth.ts b/src/auth.ts",
		"--- a/src/auth.ts",
		"+++ b/src/auth.ts",
		"@@ -1,3 +1,5 @@",
		"+// improved auth flow",
		"diff --git a/src/api.ts b/src/api.ts",
		"--- a/src/api.ts",
		"+++ b/src/api.ts",
		"@@ -10,3 +10,7 @@",
		"+// new api endpoint",
		"diff --git a/README.md b/README.md",
		"--- a/README.md",
		"+++ b/README.md",
		"@@ -1,2 +1,4 @@",
		"+## Updated docs",
	].join("\n");

	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: diffOutput, stderr: "", code: 0 },
			"git log": { stdout: "abc feat: multi-file change", stderr: "", code: 0 },
			"gh pr create": { stdout: "https://github.com/test/repo/pull/3", stderr: "", code: 0 },
		},
	});

	const handler = getPrHandler(worktreeExtension);
	await handler(ctx);

	const prCreateCall = ctx.execCalls.find((call) => call.command.includes("gh pr create") || call.command.includes("gh pr"));
	assert.ok(prCreateCall, "Expected a `gh pr create` call");

	const prBody = extractPrBody(prCreateCall.command);
	const fullCommand = prCreateCall.command;
	const searchTarget = prBody || fullCommand;

	// All three changed files must be referenced in the PR description
	assert.ok(
		searchTarget.includes("auth.ts"),
		`PR body must mention 'auth.ts' (changed file). Got: ${searchTarget.substring(0, 500)}`,
	);
	assert.ok(
		searchTarget.includes("api.ts"),
		`PR body must mention 'api.ts' (changed file). Got: ${searchTarget.substring(0, 500)}`,
	);
	assert.ok(
		searchTarget.includes("README.md"),
		`PR body must mention 'README.md' (changed file). Got: ${searchTarget.substring(0, 500)}`,
	);
});

test("worktree-pr handles empty diff gracefully without crashing", async () => {
	const ctx = makeCtx({
		args: [],
		execResponses: {
			"git diff": { stdout: "", stderr: "", code: 0 },
			"git log": { stdout: "", stderr: "", code: 0 },
			"gh pr create": { stdout: "", stderr: "", code: 0 },
		},
	});

	const handler = getPrHandler(worktreeExtension);

	// The command should either complete successfully or emit a warn/error notice
	// but it must NOT throw an unhandled exception
	let threwUnexpected = false;
	let caughtError: unknown = null;
	try {
		await handler(ctx);
	} catch (err) {
		caughtError = err;
		// Only acceptable if the extension emitted a deliberate warn or error notice
		const hasGracefulNotice = ctx.notices.some((n) => n.level === "error" || n.level === "warn");
		if (!hasGracefulNotice) {
			threwUnexpected = true;
		}
	}

	assert.ok(
		!threwUnexpected,
		`worktree-pr must handle empty diff gracefully. Got unexpected throw: ${caughtError}`,
	);

	// If it completed, verify it either created a PR with a sensible message or notified
	if (!caughtError) {
		const prCall = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
		const hasNotice = ctx.notices.length > 0;
		assert.ok(
			prCall || hasNotice,
			"On empty diff, should either create a PR or emit a notice informing the user",
		);
	}
});

test("worktree-pr retrieves the git diff before building the PR description", async () => {
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

	const handler = getPrHandler(worktreeExtension);
	await handler(ctx);

	// The extension must have executed a git diff command to inspect changed files
	const diffCall = ctx.execCalls.find(
		(call) => call.command.includes("git diff") || call.command.includes("git log") || call.command.includes("diff"),
	);
	assert.ok(
		diffCall,
		`Expected at least one git diff/log call to inspect changes, got: ${ctx.execCalls.map((c) => c.command).join("; ")}`,
	);

	// The diff call must occur BEFORE the gh pr create call
	const diffCallIndex = ctx.execCalls.findIndex(
		(call) => call.command.includes("git diff") || call.command.includes("git log"),
	);
	const prCallIndex = ctx.execCalls.findIndex((call) => call.command.includes("gh pr create"));
	if (prCallIndex >= 0) {
		assert.ok(
			diffCallIndex < prCallIndex,
			`Diff inspection (index ${diffCallIndex}) must happen before PR creation (index ${prCallIndex})`,
		);
	}
});

// ---------- Scope: extensions/worktree.ts is the module being updated ----------

test("worktree extension module (extensions/worktree.ts) is the updated module that contains PR description logic", async () => {
	// This test verifies that the worktree extension is the correct module being updated
	// and that it contains the PR command that now generates diff-based descriptions.
	assert.ok(worktreeExtension, "extensions/worktree.ts must be importable");

	const commands: Record<string, unknown> = (worktreeExtension as any).commands ?? worktreeExtension;
	const prCommandName = Object.keys(commands).find((name) => /pr/i.test(name));
	assert.ok(prCommandName, "extensions/worktree.ts must export a PR command");
	assert.equal(typeof commands[prCommandName], "function", "The PR command must be a callable function");
});

// ---------- Out of scope: no unrelated command changes ----------

test("worktree extension does not introduce unrelated commands beyond existing ones plus PR improvements", () => {
	const commands: Record<string, unknown> = (worktreeExtension as any).commands ?? worktreeExtension;
	const commandNames = typeof commands === "object" && commands !== null ? Object.keys(commands) : [];

	// All commands should be worktree-related
	for (const name of commandNames) {
		assert.ok(
			/worktree/i.test(name) || /pr/i.test(name) || /wt/i.test(name),
			`Command '${name}' should be worktree-related (no unconfirmed product changes beyond the requested feature)`,
		);
	}
});
