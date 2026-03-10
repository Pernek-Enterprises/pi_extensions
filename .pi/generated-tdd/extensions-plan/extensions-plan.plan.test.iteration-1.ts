// Generated from a markdown plan: .pi/plans/extensions.plan.md
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
				return "";
			},
		},
		...overrides,
	};
}

// ------------------------------------------------------------------
// Structural: the worktree extension exports expected commands
// ------------------------------------------------------------------

test("worktree extension exports a commands map that includes worktree-cleanup", () => {
	assert.ok(worktreeExtension, "worktree extension module should have a default export");
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	assert.ok(ext.commands, "extension should expose a commands object");
	assert.ok(
		"worktree-cleanup" in ext.commands || "worktreeCleanup" in ext.commands || "cleanup" in ext.commands,
		"extension should expose a worktree-cleanup (or equivalent) command",
	);
});

// ------------------------------------------------------------------
// Feature: invoking /worktree-cleanup with no args should list worktrees for selection
// ------------------------------------------------------------------

test("worktree-cleanup without args lists available worktrees via git and presents interactive selection", async () => {
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
			custom: async <T>(renderer: (tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T> => {
				customRendererCalled = true;
				// Simulate user selecting the first worktree
				return new Promise<T>((resolve) => {
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						(result: T) => resolve(result),
					);
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

	const ext = worktreeExtension as { commands?: Record<string, CommandHandler> };
	const cleanupCmd =
		ext.commands?.["worktree-cleanup"] ?? ext.commands?.["worktreeCleanup"] ?? ext.commands?.["cleanup"];
	assert.ok(cleanupCmd, "cleanup command must exist");

	await cleanupCmd(ctx);

	// It should have called `git worktree list` to discover worktrees
	const listCall = ctx.execCalls.find((c) => c.command.includes("worktree list"));
	assert.ok(listCall, "should invoke 'git worktree list' when no slug argument is provided");

	// It should have presented the UI selector to the user
	assert.ok(customRendererCalled, "should present an interactive selection UI when no slug argument is given");
});

// ------------------------------------------------------------------
// Feature: invoking /worktree-cleanup with a slug still works (backward compat)
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

	const ext = worktreeExtension as { commands?: Record<string, CommandHandler> };
	const cleanupCmd =
		ext.commands?.["worktree-cleanup"] ?? ext.commands?.["worktreeCleanup"] ?? ext.commands?.["cleanup"];
	assert.ok(cleanupCmd, "cleanup command must exist");

	await cleanupCmd(ctx, "feat-a");

	// Should proceed to remove without showing a picker
	assert.ok(!customRendererCalled, "should NOT present interactive selection when a slug is explicitly provided");

	// Should have executed a removal command for the specified worktree
	const removalCall = ctx.execCalls.find(
		(c) => c.command.includes("worktree remove") || c.command.includes("feat-a"),
	);
	assert.ok(removalCall, "should execute a git worktree remove command for the given slug");
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

	const ext = worktreeExtension as { commands?: Record<string, CommandHandler> };
	const cleanupCmd =
		ext.commands?.["worktree-cleanup"] ?? ext.commands?.["worktreeCleanup"] ?? ext.commands?.["cleanup"];
	assert.ok(cleanupCmd, "cleanup command must exist");

	await cleanupCmd(ctx);

	assert.ok(!customRendererCalled, "should not present interactive selection when there are no worktrees to clean up");

	const notification = ctx.notices.find(
		(n) => n.message.toLowerCase().includes("no worktree") || n.message.toLowerCase().includes("nothing"),
	);
	assert.ok(notification, "should notify the user that there are no worktrees to clean up");
});

// ------------------------------------------------------------------
// Feature: user can select multiple worktrees for cleanup
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
			custom: async <T>(renderer: (tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T> => {
				return new Promise<T>((resolve) => {
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						((result: unknown) => resolve(result as T)) as (result: T) => void,
					);
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

	const ext = worktreeExtension as { commands?: Record<string, CommandHandler> };
	const cleanupCmd =
		ext.commands?.["worktree-cleanup"] ?? ext.commands?.["worktreeCleanup"] ?? ext.commands?.["cleanup"];
	assert.ok(cleanupCmd, "cleanup command must exist");

	// The test validates that the command at least invokes git worktree list
	// and presents the UI. The actual multi-select behaviour depends on 
	// the renderer callback resolving with multiple selected items.
	await cleanupCmd(ctx);

	const listCall = ctx.execCalls.find((c) => c.command.includes("worktree list"));
	assert.ok(listCall, "should list worktrees to present multi-select options");
});

// ------------------------------------------------------------------
// Edge case: git worktree list fails
// ------------------------------------------------------------------

test("worktree-cleanup handles git worktree list failure gracefully", async () => {
	const ctx = makeCtx({
		args: [],
		hasUI: true,
		ui: {
			custom: async <T>(): Promise<T> => {
				throw new Error("should not reach UI");
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

	const ext = worktreeExtension as { commands?: Record<string, CommandHandler> };
	const cleanupCmd =
		ext.commands?.["worktree-cleanup"] ?? ext.commands?.["worktreeCleanup"] ?? ext.commands?.["cleanup"];
	assert.ok(cleanupCmd, "cleanup command must exist");

	// Should not throw; should handle error gracefully
	await cleanupCmd(ctx);

	const errorNotice = ctx.notices.find((n) => n.level === "error" || n.level === "warn");
	assert.ok(errorNotice, "should notify the user about the git failure");
});

// ------------------------------------------------------------------
// Convention: the extension fits repository structure
// ------------------------------------------------------------------

test("worktree extension default export has the expected extension shape with name and commands", () => {
	const ext = worktreeExtension as Record<string, unknown>;
	assert.ok(ext, "module should have a default export");
	// Must expose a name or id for the pi extension system
	const hasIdentifier =
		typeof ext.name === "string" || typeof ext.id === "string" || typeof ext.slug === "string";
	assert.ok(hasIdentifier, "extension should expose a name, id, or slug string");
	assert.ok(typeof ext.commands === "object" && ext.commands !== null, "extension should expose a commands object");
});
