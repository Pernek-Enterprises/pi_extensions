// Generated from a markdown plan — tests for diff-based PR description feature.
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

type CommandHandler = (ctx: Ctx, ...args: string[]) => Promise<unknown> | unknown;

/**
 * Extract the --body value from a `gh pr create` command.
 * The implementation uses POSIX single-quote escaping (shQuote),
 * so the body appears as --body '...' with embedded single quotes escaped as '\''
 */
function extractPrBody(command: string): string {
	// Match --body followed by a POSIX single-quoted string
	// POSIX single-quoting: '...' with embedded single quotes as '\''
	const bodyIdx = command.indexOf("--body ");
	if (bodyIdx === -1) return "";

	const afterBody = command.substring(bodyIdx + 7).trimStart();
	if (afterBody[0] !== "'") {
		// Fallback: unquoted value until next flag or end
		const unquotedMatch = afterBody.match(/^(\S+)/);
		return unquotedMatch ? unquotedMatch[1] : "";
	}

	// Parse POSIX single-quoted string: collect segments between single quotes,
	// handling '\'' (end quote, escaped quote, start quote) as embedded single quotes
	let result = "";
	let i = 1; // skip opening quote
	while (i < afterBody.length) {
		const closeIdx = afterBody.indexOf("'", i);
		if (closeIdx === -1) {
			// Unterminated quote, take rest
			result += afterBody.substring(i);
			break;
		}
		result += afterBody.substring(i, closeIdx);
		// Check if this is '\'' (escaped single quote)
		if (afterBody.substring(closeIdx, closeIdx + 4) === "'\\''" ) {
			result += "'";
			i = closeIdx + 4;
		} else {
			// End of quoted string
			break;
		}
	}
	return result;
}

const TEST_WORKTREE_ROOT = "/tmp/pi-worktrees";
process.env.PI_WORKTREE_ROOT = TEST_WORKTREE_ROOT;

function worktreePath(slug: string): string {
	return `${TEST_WORKTREE_ROOT}/repo/${slug}`;
}

function seedArtifact(ctx: Ctx, path: string, value: unknown) {
	ctx.artifacts.set(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function getRegisteredCommands(extension: unknown): Array<{ name: string; handler: CommandHandler }> {
	if (typeof extension !== "function") {
		throw new Error("Expected ../../extensions/worktree.ts to export a registration function");
	}
	const commands: Array<{ name: string; handler: CommandHandler }> = [];
	(extension as (pi: {
		registerCommand: (name: string, config: { handler: (args: string | undefined, ctx: Ctx) => Promise<unknown> | unknown }) => void;
	}) => void)({
		registerCommand(name, config) {
			commands.push({
				name,
				handler: async (ctx: Ctx, ...args: string[]) => await config.handler(args.join(" ").trim() || undefined, ctx),
			});
		},
	});
	if (commands.length === 0) {
		throw new Error("Expected ../../extensions/worktree.ts to register commands via registerCommand()");
	}
	return commands;
}

function getCommand(extension: unknown, name: string): CommandHandler {
	const commands = getRegisteredCommands(extension);
	const match = commands.find((command) => command.name === name || command.name === `/${name}`);
	assert.ok(match, `expected extension to register command ${name}`);
	return match!.handler;
}

/**
 * Create a Ctx that satisfies the real handleWorktreePr flow.
 * The real flow calls:
 * 1. detectManagedWorktreeFromCwd -> git rev-parse --show-toplevel, git branch --show-current, readMetadata
 * 2. ensureGhAuthenticated -> gh auth status
 * 3. git diff main (full diff)
 * 4. git status --short
 * 5. getGeneratedTexts (may call pi.ask)
 * 6. git add -A, git commit, git push
 * 7. gh pr view (lookup existing), gh pr create
 * 8. persistMetadata, appendHistory
 */
function makePrCtx(opts: {
	slug: string;
	diffOutput: string;
	statusOutput?: string;
	aiResponse?: string;
	existingPr?: string;
}): Ctx {
	const { slug, diffOutput, statusOutput = "", aiResponse, existingPr } = opts;
	const branch = `worktree/${slug}`;
	const wtPath = worktreePath(slug);

	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const persistCalls: PersistCall[] = [];
	const promptCalls: PromptCall[] = [];
	const artifacts = new Map<string, string>();

	// Seed metadata so detectManagedWorktreeFromCwd succeeds
	const metadata = {
		slug,
		branch,
		repoRoot: "/repo",
		mainCheckoutPath: "/repo",
		worktreePath: wtPath,
		createdAt: "2025-01-01T00:00:00.000Z",
	};
	artifacts.set(`.pi/worktrees/${slug}.json`, `${JSON.stringify(metadata, null, 2)}\n`);

	const hasChanges = statusOutput.trim().length > 0;

	const ctx: Ctx = {
		cwd: wtPath,
		args: [],
		state: {},
		execCalls,
		notices,
		persistCalls,
		promptCalls,
		artifacts,
		exec: async (command: string, options?: Record<string, unknown>) => {
			execCalls.push({ command, options });
			// All commands run in the worktree cwd
			if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
			if (command === "git branch --show-current") return { stdout: `${branch}\n`, stderr: "", code: 0 };
			if (command === "gh auth status") return { stdout: "Logged in to github.com\n", stderr: "", code: 0 };
			if (command === "git diff main") return { stdout: diffOutput, stderr: "", code: 0 };
			if (command === "git status --short") return { stdout: statusOutput, stderr: "", code: 0 };
			if (command.startsWith("git add ")) return { stdout: "", stderr: "", code: 0 };
			if (command.startsWith("git commit -m ")) return { stdout: `[${branch} abc123] commit\n`, stderr: "", code: 0 };
			if (command === `git push -u origin ${branch}`) return { stdout: "", stderr: "", code: 0 };
			if (command.startsWith("gh pr view ")) {
				if (existingPr) return { stdout: `${existingPr}\n`, stderr: "", code: 0 };
				return { stdout: "", stderr: "not found", code: 1 };
			}
			if (command.startsWith("gh pr create ")) return { stdout: `https://github.com/org/repo/pull/42\n`, stderr: "", code: 0 };
			// git rev-parse --git-common-dir for shared metadata detection
			if (command === "git rev-parse --git-common-dir") return { stdout: "/repo/.git\n", stderr: "", code: 0 };
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
				if (aiResponse !== undefined) return aiResponse;
				// Default AI response that references the files
				return `worktree(${slug}): update\n\nworktree/${slug}: update\n\nUpdated files in ${slug}.`;
			},
		},
	};

	return ctx;
}

// ---------- Extension shape ----------

test("worktree extension exports commands including worktree-pr via registerCommand", () => {
	assert.ok(worktreeExtension, "worktree extension should be importable");
	assert.equal(typeof worktreeExtension, "function", "extension should be a callable function");

	// Verify registerCommand path
	const registered = getRegisteredCommands(worktreeExtension);
	const prCmd = registered.find((c) => c.name === "worktree-pr");
	assert.ok(prCmd, "Expected worktree-pr registered via registerCommand");
});

// ---------- Core feature: diff-based PR description with actual file paths ----------

test("worktree-pr produces a PR body that references actual changed file paths from the diff", async () => {
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

	const ctx = makePrCtx({
		slug: "feature-ref-files",
		diffOutput,
		statusOutput: "M extensions/worktree.ts\nM extensions/utils.ts\n",
	});

	const handler = getCommand(worktreeExtension, "worktree-pr");
	await handler(ctx);

	// Find the gh pr create call
	const prCreateCall = ctx.execCalls.find((c) => c.command.startsWith("gh pr create "));
	assert.ok(prCreateCall, "Expected a `gh pr create` command");

	const prBody = extractPrBody(prCreateCall.command);
	assert.ok(prBody.length > 0, `extractPrBody should extract non-empty body. Command: ${prCreateCall.command.substring(0, 300)}`);

	// The PR body must reference actual file paths from the diff
	assert.ok(
		prBody.includes("worktree.ts"),
		`PR body must reference 'worktree.ts' (changed file). Body: ${prBody.substring(0, 500)}`,
	);
	assert.ok(
		prBody.includes("utils.ts"),
		`PR body must reference 'utils.ts' (changed file). Body: ${prBody.substring(0, 500)}`,
	);
});

test("worktree-pr PR body is not a hardcoded placeholder — has meaningful diff-derived content over 50 chars", async () => {
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

	const ctx = makePrCtx({
		slug: "feature-no-placeholder",
		diffOutput,
		statusOutput: "M extensions/worktree.ts\n",
	});

	const handler = getCommand(worktreeExtension, "worktree-pr");
	await handler(ctx);

	const prCreateCall = ctx.execCalls.find((c) => c.command.startsWith("gh pr create "));
	assert.ok(prCreateCall, "Expected a gh pr create call");

	const prBody = extractPrBody(prCreateCall.command);

	// Body must be meaningfully long
	assert.ok(
		prBody.length >= 50,
		`PR body should be at least 50 characters. Got ${prBody.length} chars: '${prBody.substring(0, 200)}'`,
	);

	// Body must contain diff-derived content (file reference)
	assert.ok(
		prBody.includes("worktree.ts"),
		`PR body should reference files from the diff. Body: '${prBody.substring(0, 300)}'`,
	);

	// Body must not be a known trivial placeholder
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

	const ctx = makePrCtx({
		slug: "feature-all-files",
		diffOutput,
		statusOutput: "M src/auth.ts\nM src/api.ts\nM README.md\n",
	});

	const handler = getCommand(worktreeExtension, "worktree-pr");
	await handler(ctx);

	const prCreateCall = ctx.execCalls.find((c) => c.command.startsWith("gh pr create "));
	assert.ok(prCreateCall, "Expected a `gh pr create` call");

	const prBody = extractPrBody(prCreateCall.command);

	// All three changed files must appear in the PR body
	assert.ok(prBody.includes("auth.ts"), `PR body must mention 'auth.ts'. Got: ${prBody.substring(0, 500)}`);
	assert.ok(prBody.includes("api.ts"), `PR body must mention 'api.ts'. Got: ${prBody.substring(0, 500)}`);
	assert.ok(prBody.includes("README.md"), `PR body must mention 'README.md'. Got: ${prBody.substring(0, 500)}`);
});

test("worktree-pr handles empty diff gracefully — creates PR with informative body, no crash", async () => {
	const ctx = makePrCtx({
		slug: "feature-empty-diff",
		diffOutput: "",
		statusOutput: "", // no uncommitted changes
	});

	const handler = getCommand(worktreeExtension, "worktree-pr");

	// Must not throw
	await handler(ctx);

	// Should still push and create/find a PR
	const pushCall = ctx.execCalls.find((c) => c.command.includes("git push"));
	assert.ok(pushCall, "Should still push even with empty diff");

	// Either creates a new PR or finds an existing one
	const prCreateCall = ctx.execCalls.find((c) => c.command.startsWith("gh pr create "));
	const prViewCall = ctx.execCalls.find((c) => c.command.startsWith("gh pr view "));
	assert.ok(prCreateCall || prViewCall, "Should attempt to create or find a PR");

	if (prCreateCall) {
		const prBody = extractPrBody(prCreateCall.command);
		// Even with empty diff, body should be informative (not empty)
		assert.ok(
			prBody.length > 20,
			`Empty-diff PR body should still be informative. Got: '${prBody}'`,
		);
		// Body should mention the branch or slug as context
		assert.ok(
			prBody.includes("feature-empty-diff") || prBody.includes("worktree/feature-empty-diff"),
			`Empty-diff body should reference the branch or slug for context. Got: '${prBody.substring(0, 300)}'`,
		);
	}
});

test("worktree-pr retrieves git diff main before building the PR description", async () => {
	const diffOutput = [
		"diff --git a/extensions/worktree.ts b/extensions/worktree.ts",
		"--- a/extensions/worktree.ts",
		"+++ b/extensions/worktree.ts",
		"@@ -10,6 +10,12 @@",
		"+function generateDescription(diff: string): string {",
		"+  return diff;",
		"+}",
	].join("\n");

	const ctx = makePrCtx({
		slug: "feature-diff-order",
		diffOutput,
		statusOutput: "M extensions/worktree.ts\n",
	});

	const handler = getCommand(worktreeExtension, "worktree-pr");
	await handler(ctx);

	// Must call git diff main
	const diffCall = ctx.execCalls.find((c) => c.command === "git diff main");
	assert.ok(diffCall, `Expected a 'git diff main' call. Got: ${ctx.execCalls.map((c) => c.command).join("; ")}`);

	// Diff must be called BEFORE gh pr create
	const diffCallIndex = ctx.execCalls.findIndex((c) => c.command === "git diff main");
	const prCallIndex = ctx.execCalls.findIndex((c) => c.command.startsWith("gh pr create "));
	if (prCallIndex >= 0) {
		assert.ok(
			diffCallIndex < prCallIndex,
			`git diff main (index ${diffCallIndex}) must happen before gh pr create (index ${prCallIndex})`,
		);
	}
});

test("worktree-pr falls back to programmatic diff-based body when AI returns weak response", async () => {
	const diffOutput = [
		"diff --git a/src/handler.ts b/src/handler.ts",
		"--- a/src/handler.ts",
		"+++ b/src/handler.ts",
		"@@ -1,3 +1,8 @@",
		"+// new handler logic",
		"+export function handleRequest() {}",
	].join("\n");

	const ctx = makePrCtx({
		slug: "feature-ai-fallback",
		diffOutput,
		statusOutput: "M src/handler.ts\n",
		// AI returns a weak/empty response
		aiResponse: "\n\n   \n\n",
	});

	const handler = getCommand(worktreeExtension, "worktree-pr");
	await handler(ctx);

	const prCreateCall = ctx.execCalls.find((c) => c.command.startsWith("gh pr create "));
	assert.ok(prCreateCall, "Expected gh pr create even with bad AI response");

	// Should use the programmatic fallback body
	const prBody = extractPrBody(prCreateCall.command);
	assert.ok(prBody.includes("handler.ts"), `Fallback body should reference changed file. Got: '${prBody.substring(0, 300)}'`);
	assert.ok(prBody.length >= 50, `Fallback body should be substantial. Got ${prBody.length} chars`);

	// The commit message should use the deterministic fallback
	const commitCall = ctx.execCalls.find((c) => c.command.startsWith("git commit -m "));
	assert.ok(commitCall, "Expected a commit");
	assert.match(commitCall.command, /worktree\(feature-ai-fallback\): update/i);
});

test("worktree extension does not introduce unrelated commands", () => {
	const registered = getRegisteredCommands(worktreeExtension);
	for (const cmd of registered) {
		assert.ok(
			/worktree/i.test(cmd.name),
			`Command '${cmd.name}' should be worktree-related`,
		);
	}
});
