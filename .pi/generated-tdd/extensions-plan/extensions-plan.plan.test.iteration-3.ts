// Generated from a markdown plan: .pi/plans/extensions.plan.md
//
// NOTE: The context shape (Ctx) and ui.custom renderer API are inferred from
// existing test examples in this repo (e.g. the worktree plan test) and the
// /ss command pattern mentioned in the plan. If the actual implementation uses
// a different UI selection API, these mocks will need updating.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

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
		custom?: <T>(
			renderer: (
				tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void },
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
		) => Promise<T>;
	};
	spawnInteractive?: (
		command: string,
		args: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
	) => { status: number | null; stdout?: Buffer; stderr?: Buffer; error?: Error; signal?: NodeJS.Signals | null };
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

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const persistCalls: PersistCall[] = [];
	const promptCalls: PromptCall[] = [];
	const artifacts = new Map<string, string>();

	return {
		cwd: "/test-repo",
		args: [],
		hasUI: true,
		state: {},
		execCalls,
		notices,
		persistCalls,
		promptCalls,
		artifacts,
		exec: async (command: string, options?: Record<string, unknown>) => {
			execCalls.push({ command, options });
			return { stdout: "", stderr: "", code: 0 };
		},
		persistArtifact: async (p: string, content: string) => {
			persistCalls.push({ path: p, content });
			artifacts.set(p, content);
		},
		readArtifact: async (p: string) => artifacts.get(p),
		pi: {
			notify: (message: string) => notices.push({ level: "info", message }),
			warn: (message: string) => notices.push({ level: "warn", message }),
			error: (message: string) => notices.push({ level: "error", message }),
			ask: async (prompt: string) => {
				promptCalls.push({ prompt });
				return "";
			},
		},
		...overrides,
	};
}

function getCleanupCommand(): CommandHandler {
	const ext = worktreeExtension as { commands?: Record<string, CommandHandler> };
	const cmd = ext.commands?.["worktree-cleanup"];
	if (!cmd) {
		throw new Error(
			"Extension must expose a 'worktree-cleanup' command. " +
				`Found commands: ${ext.commands ? Object.keys(ext.commands).join(", ") : "(none)"}`,
		);
	}
	return cmd;
}

// ------------------------------------------------------------------
// Structural: the worktree extension exports expected shape
// ------------------------------------------------------------------

test("worktree extension default export has the expected extension shape with name and commands", () => {
	const ext = worktreeExtension as Record<string, unknown>;
	assert.ok(ext, "module should have a default export");
	const hasIdentifier =
		typeof ext.name === "string" || typeof ext.id === "string" || typeof ext.slug === "string";
	assert.ok(hasIdentifier, "extension should expose a name, id, or slug string");
	assert.ok(typeof ext.commands === "object" && ext.commands !== null, "extension should expose a commands object");
});

test("worktree extension exports a commands map that includes worktree-cleanup", () => {
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	assert.ok(ext.commands, "extension should expose a commands object");
	assert.ok(
		"worktree-cleanup" in ext.commands,
		`extension must expose a 'worktree-cleanup' command (found: ${Object.keys(ext.commands).join(", ")})`,
	);
});

// ------------------------------------------------------------------
// Feature: /worktree-cleanup without args lists worktrees and
// presents interactive selection, then cleans up the selected one
// ------------------------------------------------------------------

test("worktree-cleanup without args lists available worktrees via git and presents interactive selection then removes the selected worktree", async () => {
	const worktreeListOutput = [
		"/repo/main  abc1234 [main]",
		"/repo/.worktrees/feat-a/feat-a  def5678 [feat-a]",
		"/repo/.worktrees/feat-b/feat-b  ghi9012 [feat-b]",
	].join("\n");

	let customRendererCalled = false;

	const ctx = makeCtx({
		args: [],
		hasUI: true,
		ui: {
			custom: async <T>(
				renderer: (
					tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void },
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
			): Promise<T> => {
				customRendererCalled = true;
				// Simulate user selecting 'feat-a' by calling done() synchronously
				return new Promise<T>((resolve) => {
					const done = (result: T) => resolve(result);
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						done,
					);
					// If renderer does not call done internally, call it ourselves
					done(["feat-a"] as unknown as T);
				});
			},
		},
		exec: async (command: string) => {
			ctx.execCalls.push({ command });
			if (command.includes("worktree list")) {
				return { stdout: worktreeListOutput, stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const cleanupCmd = getCleanupCommand();
	await cleanupCmd(ctx);

	const listCall = ctx.execCalls.find((c) => c.command.includes("worktree list"));
	assert.ok(listCall, "should invoke 'git worktree list' when no slug argument is provided");

	assert.ok(customRendererCalled, "should present an interactive selection UI when no slug argument is given");

	const removeCall = ctx.execCalls.find(
		(c) => c.command.includes("worktree remove") && c.command.includes("feat-a"),
	);
	assert.ok(removeCall, "should execute 'git worktree remove' for the selected worktree 'feat-a'");
});

// ------------------------------------------------------------------
// Feature: multi-select – user selects multiple worktrees to clean
// ------------------------------------------------------------------

test("worktree-cleanup interactive mode allows selecting multiple worktrees and cleans all of them", async () => {
	const worktreeListOutput = [
		"/repo/main  abc1234 [main]",
		"/repo/.worktrees/feat-a/feat-a  def5678 [feat-a]",
		"/repo/.worktrees/feat-b/feat-b  ghi9012 [feat-b]",
		"/repo/.worktrees/feat-c/feat-c  jkl3456 [feat-c]",
	].join("\n");

	const ctx = makeCtx({
		args: [],
		hasUI: true,
		ui: {
			custom: async <T>(
				renderer: (
					tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void },
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
			): Promise<T> => {
				// Simulate user selecting feat-a AND feat-b synchronously via done()
				return new Promise<T>((resolve) => {
					const done = (result: T) => resolve(result);
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						done,
					);
					done(["feat-a", "feat-b"] as unknown as T);
				});
			},
		},
		exec: async (command: string) => {
			ctx.execCalls.push({ command });
			if (command.includes("worktree list")) {
				return { stdout: worktreeListOutput, stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const cleanupCmd = getCleanupCommand();
	await cleanupCmd(ctx);

	const listCall = ctx.execCalls.find((c) => c.command.includes("worktree list"));
	assert.ok(listCall, "should invoke 'git worktree list' for multi-select");

	const removeFeatA = ctx.execCalls.find(
		(c) => c.command.includes("worktree remove") && c.command.includes("feat-a"),
	);
	const removeFeatB = ctx.execCalls.find(
		(c) => c.command.includes("worktree remove") && c.command.includes("feat-b"),
	);
	assert.ok(removeFeatA, "should execute 'git worktree remove' for selected worktree 'feat-a'");
	assert.ok(removeFeatB, "should execute 'git worktree remove' for selected worktree 'feat-b'");

	const removeFeatC = ctx.execCalls.find(
		(c) => c.command.includes("worktree remove") && c.command.includes("feat-c"),
	);
	assert.ok(!removeFeatC, "should NOT remove worktrees that were not selected (feat-c)");
});

// ------------------------------------------------------------------
// Feature: backward compat – explicit slug still works
// ------------------------------------------------------------------

test("worktree-cleanup with an explicit slug argument cleans up that specific worktree without interactive selection", async () => {
	let customRendererCalled = false;

	const ctx = makeCtx({
		args: ["feat-a"],
		hasUI: true,
		ui: {
			custom: async <T>(): Promise<T> => {
				customRendererCalled = true;
				return undefined as unknown as T;
			},
		},
		exec: async (command: string) => {
			ctx.execCalls.push({ command });
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const cleanupCmd = getCleanupCommand();
	await cleanupCmd(ctx, "feat-a");

	assert.ok(!customRendererCalled, "should NOT present interactive selection when a slug is explicitly provided");

	const removalCall = ctx.execCalls.find(
		(c) => c.command.includes("worktree remove") && c.command.includes("feat-a"),
	);
	assert.ok(removalCall, "should execute a 'git worktree remove' command for the given slug 'feat-a'");
});

// ------------------------------------------------------------------
// Edge case: user cancellation / empty selection
// ------------------------------------------------------------------

test("worktree-cleanup interactive mode with empty selection does not remove any worktrees and notifies user", async () => {
	const worktreeListOutput = [
		"/repo/main  abc1234 [main]",
		"/repo/.worktrees/feat-a/feat-a  def5678 [feat-a]",
	].join("\n");

	const ctx = makeCtx({
		args: [],
		hasUI: true,
		ui: {
			custom: async <T>(
				renderer: (
					tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void },
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => unknown,
			): Promise<T> => {
				// Simulate user cancelling / selecting nothing
				return new Promise<T>((resolve) => {
					const done = (result: T) => resolve(result);
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						done,
					);
					done([] as unknown as T);
				});
			},
		},
		exec: async (command: string) => {
			ctx.execCalls.push({ command });
			if (command.includes("worktree list")) {
				return { stdout: worktreeListOutput, stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const cleanupCmd = getCleanupCommand();
	await cleanupCmd(ctx);

	const removeCall = ctx.execCalls.find((c) => c.command.includes("worktree remove"));
	assert.ok(!removeCall, "should NOT execute any 'git worktree remove' when user selects nothing");

	const notification = ctx.notices.find(
		(n) =>
			n.message.toLowerCase().includes("no worktree") ||
			n.message.toLowerCase().includes("nothing") ||
			n.message.toLowerCase().includes("cancel") ||
			n.message.toLowerCase().includes("no selection"),
	);
	assert.ok(notification, "should notify the user that no worktrees were selected for cleanup");
});

// ------------------------------------------------------------------
// Edge case: no worktrees available for cleanup
// ------------------------------------------------------------------

test("worktree-cleanup without args when only the main worktree exists notifies the user and does not show selector", async () => {
	const worktreeListOutput = "/repo/main  abc1234 [main]\n";
	let customRendererCalled = false;

	const ctx = makeCtx({
		args: [],
		hasUI: true,
		ui: {
			custom: async <T>(): Promise<T> => {
				customRendererCalled = true;
				return undefined as unknown as T;
			},
		},
		exec: async (command: string) => {
			ctx.execCalls.push({ command });
			if (command.includes("worktree list")) {
				return { stdout: worktreeListOutput, stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const cleanupCmd = getCleanupCommand();
	await cleanupCmd(ctx);

	assert.ok(!customRendererCalled, "should not present interactive selection when there are no worktrees to clean up");

	const notification = ctx.notices.find(
		(n) => n.message.toLowerCase().includes("no worktree") || n.message.toLowerCase().includes("nothing"),
	);
	assert.ok(notification, "should notify the user that there are no worktrees to clean up");
});

// ------------------------------------------------------------------
// Edge case: git worktree list fails
// ------------------------------------------------------------------

test("worktree-cleanup handles git worktree list failure gracefully", async () => {
	let customRendererCalled = false;

	const ctx = makeCtx({
		args: [],
		hasUI: true,
		ui: {
			custom: async <T>(): Promise<T> => {
				customRendererCalled = true;
				return undefined as unknown as T;
			},
		},
		exec: async (command: string) => {
			ctx.execCalls.push({ command });
			if (command.includes("worktree list")) {
				return { stdout: "", stderr: "fatal: not a git repository", code: 128 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
	});

	const cleanupCmd = getCleanupCommand();
	await cleanupCmd(ctx);

	assert.ok(!customRendererCalled, "should not present UI when git worktree list failed");

	const errorNotice = ctx.notices.find((n) => n.level === "error" || n.level === "warn");
	assert.ok(errorNotice, "should notify the user about the git failure");
});

// ------------------------------------------------------------------
// Scope: extensions/worktree.ts is the affected module
// ------------------------------------------------------------------

test("extensions/worktree.ts module is importable and is the module under change for interactive cleanup", () => {
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	assert.ok(ext.commands, "extensions/worktree.ts must export commands");
	assert.ok(
		typeof ext.commands["worktree-cleanup"] === "function",
		"extensions/worktree.ts must export 'worktree-cleanup' as a function",
	);
});

// ------------------------------------------------------------------
// Scope: related test files should exist (fs check, no import)
// ------------------------------------------------------------------

test("scoped test file for worktree extension plan exists on disk", () => {
	const filePath = path.resolve(
		__dirname,
		"currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts",
	);
	assert.ok(existsSync(filePath), `Expected scoped test file to exist at ${filePath}`);
});

test("scoped tdd-plan test file exists on disk", () => {
	const filePath = path.resolve(__dirname, "tdd-plan.test.ts");
	assert.ok(existsSync(filePath), `Expected scoped test file to exist at ${filePath}`);
});

test("scoped plan-feature-spec test file exists on disk", () => {
	const filePath = path.resolve(__dirname, "plan-feature-spec.plan.test.ts");
	assert.ok(existsSync(filePath), `Expected scoped test file to exist at ${filePath}`);
});

// ------------------------------------------------------------------
// Out of scope: the extension should not add unrelated commands
// ------------------------------------------------------------------

test("worktree extension does not introduce unconfirmed product changes beyond worktree-cleanup", () => {
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	const commandNames = Object.keys(ext.commands ?? {});

	for (const name of commandNames) {
		assert.ok(
			name.includes("worktree") || name.includes("wt"),
			`Command '${name}' should be worktree-related; unconfirmed product changes are out of scope`,
		);
	}
});

// ------------------------------------------------------------------
// Acceptance criteria: plan cites affected modules
// (verified by confirming the implementation module exists and
// provides the expected command – this is the repo-grounded proof)
// ------------------------------------------------------------------

test("the affected module extensions/worktree.ts exists and provides the worktree-cleanup command as cited in the plan", () => {
	const modulePath = path.resolve(__dirname, "../../extensions/worktree.ts");
	assert.ok(existsSync(modulePath), "extensions/worktree.ts must exist as cited in the plan scope");

	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	assert.ok(
		ext.commands && typeof ext.commands["worktree-cleanup"] === "function",
		"the cited module must expose the worktree-cleanup command",
	);
});
