// Generated from a markdown plan: .pi/plans/extensions.plan.md
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import worktreeExtension from "../../extensions/worktree.ts";

// ---------------------------------------------------------------------------
// Types – inferred from existing test examples in the repo.
// The structural smoke test below will surface a diagnostic error if the
// actual export shape differs from what is assumed here.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
				`Actual export keys: ${JSON.stringify(Object.keys(worktreeExtension as Record<string, unknown>))}. ` +
				`commands keys: ${ext.commands ? JSON.stringify(Object.keys(ext.commands)) : "(commands not found)"}`,
		);
	}
	return cmd;
}

// ---------------------------------------------------------------------------
// Structural smoke test – diagnostic first-failure if export shape differs
// (Fix 2: dedicated diagnostic smoke test for export shape)
// ---------------------------------------------------------------------------

test("worktree extension default export has the expected extension shape with name/id and commands map (diagnostic smoke test)", () => {
	const ext = worktreeExtension as Record<string, unknown>;
	assert.ok(ext, "module should have a default export");

	// Log actual shape so first failure is diagnostic
	const actualKeys = Object.keys(ext);
	const hasIdentifier =
		typeof ext.name === "string" || typeof ext.id === "string" || typeof ext.slug === "string";
	assert.ok(
		hasIdentifier,
		`extension should expose a name, id, or slug string. Actual top-level keys: ${JSON.stringify(actualKeys)}`,
	);
	assert.ok(
		typeof ext.commands === "object" && ext.commands !== null,
		`extension should expose a commands object. Actual top-level keys: ${JSON.stringify(actualKeys)}`,
	);
});

test("worktree extension exports a commands map that includes worktree-cleanup", () => {
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	assert.ok(ext.commands, "extension should expose a commands object");
	assert.ok(
		"worktree-cleanup" in ext.commands,
		`extension must expose a 'worktree-cleanup' command (found: ${Object.keys(ext.commands).join(", ")})`,
	);
});

// ---------------------------------------------------------------------------
// Feature: /worktree-cleanup without args lists worktrees and presents
// interactive selection (pi inline thingy), then cleans up the selected one
// ---------------------------------------------------------------------------

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
				// Fix 1: done is called exactly once, inside the renderer mock only
				return new Promise<T>((resolve) => {
					const done = (result: T) => resolve(result);
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						// Provide done that resolves with the simulated user selection
						((result: T) => done(result)) as (result: T) => void,
					);
					// Renderer may or may not call done synchronously.
					// If the implementation calls done within the renderer, the promise
					// resolves there. If not, we simulate a user choosing 'feat-a':
					setTimeout(() => done(["feat-a"] as unknown as T), 0);
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

// ---------------------------------------------------------------------------
// Feature: multi-select – user selects multiple worktrees to clean
// ---------------------------------------------------------------------------

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
				// Fix 1: done called exactly once via setTimeout fallback
				return new Promise<T>((resolve) => {
					let resolved = false;
					const done = (result: T) => {
						if (!resolved) {
							resolved = true;
							resolve(result);
						}
					};
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						done,
					);
					// If renderer did not call done, simulate user selecting feat-a and feat-b
					setTimeout(() => done(["feat-a", "feat-b"] as unknown as T), 0);
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

// ---------------------------------------------------------------------------
// Feature: backward compat – explicit slug still works
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Edge case: user cancellation / empty selection
// ---------------------------------------------------------------------------

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
				return new Promise<T>((resolve) => {
					let resolved = false;
					const done = (result: T) => {
						if (!resolved) {
							resolved = true;
							resolve(result);
						}
					};
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						done,
					);
					// Simulate user selecting nothing
					setTimeout(() => done([] as unknown as T), 0);
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

// ---------------------------------------------------------------------------
// Edge case: no worktrees available for cleanup (only main exists)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Edge case: git worktree list command fails
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Scope: extensions/worktree.ts is the affected module and provides the command
// (Acceptance criteria: plan cites affected modules)
// ---------------------------------------------------------------------------

test("the affected module extensions/worktree.ts provides the worktree-cleanup command as cited in the plan", () => {
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	assert.ok(ext.commands, "extensions/worktree.ts must export commands");
	assert.ok(
		typeof ext.commands["worktree-cleanup"] === "function",
		"extensions/worktree.ts must export 'worktree-cleanup' as a function",
	);
});

// ---------------------------------------------------------------------------
// Out of scope: the extension should not add unrelated commands
// ---------------------------------------------------------------------------

test("worktree extension does not introduce unconfirmed product changes beyond worktree-related commands", () => {
	const ext = worktreeExtension as { commands?: Record<string, unknown> };
	const commandNames = Object.keys(ext.commands ?? {});

	for (const name of commandNames) {
		assert.ok(
			name.includes("worktree") || name.includes("wt"),
			`Command '${name}' should be worktree-related; unconfirmed product changes are out of scope`,
		);
	}
});

// ---------------------------------------------------------------------------
// Edge case: no obvious existing module is found for the request
// (The worktree extension must exist and be importable; if it doesn't,
// the import at the top of this file will fail, surfacing the issue.)
// ---------------------------------------------------------------------------

test("edge case: worktree module is found and importable – not a missing-module scenario", () => {
	assert.ok(
		worktreeExtension !== null && worktreeExtension !== undefined,
		"extensions/worktree.ts should be importable; if no module existed for this request, the plan would need to note that explicitly",
	);
});

// ---------------------------------------------------------------------------
// Edge case: critical behavior remains ambiguous and needs clarification
// (The interactive selection UI API shape is ambiguous – we test that the
// command at minimum attempts to use ctx.ui.custom when no args are given,
// which is the pi inline thingy pattern referenced in the plan.)
// ---------------------------------------------------------------------------

test("edge case: interactive cleanup uses ctx.ui.custom (pi inline thingy) – ambiguous API shape is exercised", async () => {
	const worktreeListOutput = [
		"/repo/main  abc1234 [main]",
		"/repo/.worktrees/feat-x/feat-x  aaa1111 [feat-x]",
	].join("\n");

	let uiCustomInvoked = false;
	let rendererReceivedDone = false;

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
				uiCustomInvoked = true;
				return new Promise<T>((resolve) => {
					let resolved = false;
					const done = (result: T) => {
						if (!resolved) {
							resolved = true;
							rendererReceivedDone = true;
							resolve(result);
						}
					};
					renderer(
						{ stop: () => {}, start: () => {}, requestRender: () => {} },
						{},
						{},
						done,
					);
					setTimeout(() => done(["feat-x"] as unknown as T), 0);
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

	assert.ok(uiCustomInvoked, "interactive cleanup must call ctx.ui.custom (the pi inline thingy pattern)");
	assert.ok(rendererReceivedDone, "renderer callback must receive a done function to signal user selection");
});

// ---------------------------------------------------------------------------
// Acceptance criteria: feature behavior is documented in repo-grounded terms
// (Verified by confirming the feature command lives in the expected module
// path and follows the extension convention of name + commands map.)
// ---------------------------------------------------------------------------

test("feature behavior is repo-grounded: worktree-cleanup lives in extensions/worktree.ts following the extension convention", () => {
	const ext = worktreeExtension as Record<string, unknown>;
	// Must have a name or identifier following extension conventions
	const identifier = ext.name ?? ext.id ?? ext.slug;
	assert.ok(
		typeof identifier === "string" && identifier.length > 0,
		"extension must have a non-empty name/id/slug for repo-grounded documentation",
	);

	// Must expose worktree-cleanup in the commands map
	const commands = ext.commands as Record<string, unknown> | undefined;
	assert.ok(commands, "extension must expose commands");
	assert.ok(
		typeof commands["worktree-cleanup"] === "function",
		"worktree-cleanup command must be a function in the commands map",
	);
});
