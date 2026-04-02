// Generated from a markdown plan: .pi/plans/i-want-to-create-an-extension-that-helps-me-with-sending-git.plan.md
import test from "node:test";
import assert from "node:assert/strict";

import inlineGitExtension from "../../extensions/inline-git-commands.ts";

// ---------- helpers ----------

type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
type ExecCall = { command: string; args?: string[]; options?: Record<string, unknown> };
type Notice = { level: string; message: string };

function ok(stdout = "", code = 0): ExecResult {
	return { stdout, stderr: "", code };
}
function fail(stderr = "", code = 1): ExecResult {
	return { stdout: "", stderr, code };
}

/**
 * Creates a test context matching the current Pi extension API.
 *
 * Registration pattern (matches worktree.ts and inline-git-commands.ts):
 *   export default function extension(pi: PiApi) { pi.registerCommand(...) }
 *
 * The extension uses pi.exec("sh", ["-c", "<command>"]) for shell execution,
 * and ctx.ui.notify(message, level) for all notification levels.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const execResponses: Map<string, ExecResult> = new Map();
	let confirmResult = true;
	let selectResult: string | undefined;
	let inputResult: string | undefined;

	const ctx = {
		cwd: "/repo",
		execCalls,
		notices,
		execResponses,
		set confirmResult(v: boolean) { confirmResult = v; },
		set selectResult(v: string) { selectResult = v; },
		set inputResult(v: string) { inputResult = v; },
		ui: {
			notify: (message: string, level?: string) => { notices.push({ level: level ?? "info", message }); },
			confirm: async (_title: string, _message?: string) => confirmResult,
			select: async (_prompt: string, choices: string[]) => {
				if (selectResult) return selectResult;
				return choices[0] ?? "";
			},
			input: async (_prompt: string) => inputResult ?? "default message",
		},
		...overrides,
	};
	return ctx;
}

/**
 * Collects registered commands by calling the extension with a mock PiApi.
 *
 * The extension stores pi globally and uses pi.exec("sh", ["-c", cmd]) for
 * all shell execution. The mock pi.exec intercepts these calls, extracts the
 * actual shell command from the ["-c", cmd] args pattern, and matches against
 * execResponses set on the context.
 *
 * Returns a map of command name -> handler(args, ctx).
 */
function collectRegisteredCommands(
	ext: unknown,
	ctxForExec?: ReturnType<typeof makeCtx>,
): Map<string, (args: string, ctx: ReturnType<typeof makeCtx>) => Promise<unknown>> {
	const map = new Map<string, (args: string, ctx: ReturnType<typeof makeCtx>) => Promise<unknown>>();


	const mockPi = {
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => {
			map.set(name, options.handler);
		},
		exec: async (command: string, args?: string[], options?: Record<string, unknown>): Promise<ExecResult> => {
			// The extension calls pi.exec("sh", ["-c", "actual command"])
			const shellCommand = (args && args.length >= 2 && args[0] === "-c") ? args[1] : `${command} ${(args ?? []).join(" ")}`.trim();

			if (ctxForExec) {
				ctxForExec.execCalls.push({ command: shellCommand, args, options });
				for (const [pattern, result] of ctxForExec.execResponses.entries()) {
					if (shellCommand.includes(pattern)) return result;
				}
			}
			return ok();
		},
	};

	if (typeof ext === "function") {
		try { (ext as any)(mockPi); } catch { /* ignore */ }
	} else if (ext && typeof (ext as any).default === "function") {
		try { (ext as any).default(mockPi); } catch { /* ignore */ }
	}
	return map;
}

/**
 * Helper to register commands with a specific context wired for exec responses.
 * Returns the handler for a specific command.
 */
function getHandler(commandName: string, ctx: ReturnType<typeof makeCtx>) {
	const commands = collectRegisteredCommands(inlineGitExtension, ctx);
	const handler = commands.get(commandName);
	assert.ok(handler, `${commandName} command handler must exist`);
	return handler;
}

// ---------- tests ----------

// Requirement 30: Extension loads via the existing discovery
test("extension module exports a valid extension object or function", () => {
	assert.ok(inlineGitExtension != null, "inline-git-commands extension must export a non-null value");
	const extType = typeof inlineGitExtension;
	assert.ok(
		extType === "function" || extType === "object",
		`extension must export a function or object, got ${extType}`,
	);
});

// Requirement 16: Individual commands, not a single /git dispatcher
test("extension registers individual git slash commands, not a single /git dispatcher", () => {
	const commands = collectRegisteredCommands(inlineGitExtension);
	const names = [...commands.keys()];

	const expectedCommands = [
		"git-status",
		"git-diff",
		"git-checkout",
		"git-create-branch",
		"git-remote-main",
		"git-commit",
		"git-pr",
		"git-pr-update",
	];

	for (const cmd of expectedCommands) {
		assert.ok(
			names.some((n) => n === cmd || n === `/${cmd}` || n.endsWith(cmd)),
			`expected command "${cmd}" to be registered, found: [${names.join(", ")}]`,
		);
	}
});

// Requirement 3 / Scope: `/git-status` — show `git status --short`, notify result
test("/git-status runs 'git status --short' and notifies result", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status", ok(" M src/index.ts\n?? newfile.ts"));

	const handler = getHandler("git-status", ctx);
	await handler("", ctx);

	const statusCall = ctx.execCalls.find((c) => c.command.includes("git status"));
	assert.ok(statusCall, "must execute git status");
	assert.ok(
		ctx.notices.some((n) => n.message.includes("M src/index.ts") || n.message.includes("newfile.ts")),
		"must notify with status output",
	);
});

// Requirement 4: /git-diff shows truncated diff
test("/git-diff shows truncated diff output (staged + unstaged)", async () => {
	const longDiff = "diff --git a/file.ts\n" + "+added line\n".repeat(500);
	const ctx = makeCtx();
	ctx.execResponses.set("git diff", ok(longDiff));

	const handler = getHandler("git-diff", ctx);
	await handler("", ctx);

	const diffCall = ctx.execCalls.find((c) => c.command.includes("git diff"));
	assert.ok(diffCall, "must execute git diff");
	assert.ok(ctx.notices.length > 0, "must notify with diff output");
	// Truncation: the notification should not contain the full 500-line diff
	const totalNoticeLength = ctx.notices.map((n) => n.message).join("").length;
	assert.ok(totalNoticeLength < longDiff.length, "diff output should be truncated for notification");
});

// Requirement 4: /git-diff with optional path argument
test("/git-diff accepts optional path argument", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git diff", ok("diff output for src/index.ts"));

	const handler = getHandler("git-diff", ctx);
	await handler("src/index.ts", ctx);

	const diffCall = ctx.execCalls.find((c) => c.command.includes("git diff") && c.command.includes("src/index.ts"));
	assert.ok(diffCall, "must execute git diff with the specified path");
});

// Requirement 5 / 25 / Scope: `/git-checkout <branch>` — switch branch; interactive picker via `ctx.ui.select()` when no argument given; prompt to stash on dirty tree
test("/git-checkout without arguments shows an interactive branch picker via ctx.ui.select()", async () => {
	let selectCalled = false;
	const ctx = makeCtx();
	ctx.execResponses.set("git branch -a", ok("  main\n  feature/foo\n  remotes/bitehive/HEAD -> bitehive/main\n  remotes/bitehive/feature/bar\n"));
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched to branch 'feature/foo'"));

	ctx.ui.select = async (_prompt: string, choices: string[]) => {
		selectCalled = true;
		assert.ok(
			!choices.some((c) => c.includes("remotes/")),
			"branch picker should strip the remotes/ prefix from display labels",
		);
		assert.ok(
			!choices.some((c) => c.includes(" -> ")),
			"branch picker should omit symbolic remote HEAD entries",
		);
		assert.ok(choices.includes("feature/foo"), "branch picker should include local branches");
		assert.ok(choices.includes("bitehive/feature/bar"), "branch picker should preserve remote identity for remote branches");
		return "feature/foo";
	};

	const handler = getHandler("git-checkout", ctx);
	await handler("", ctx);

	assert.ok(selectCalled, "must call ctx.ui.select() for branch picking when no argument given");
});

// Requirement 5: /git-checkout with branch argument switches directly
test("/git-checkout with branch argument switches branch directly", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched to branch 'feature/foo'"));

	const handler = getHandler("git-checkout", ctx);
	await handler("feature/foo", ctx);

	const checkoutCall = ctx.execCalls.find((c) => c.command.includes("git checkout") && c.command.includes("feature/foo"));
	assert.ok(checkoutCall, "must execute git checkout with the specified branch");
});

// Requirement 18 / 26: /git-checkout prompts to stash on dirty tree, auto-stash if confirmed, auto-unstash after
test("/git-checkout on dirty tree prompts to stash, auto-stashes if confirmed, and unstashes after checkout", async () => {
	let confirmCalled = false;
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M dirty-file.ts\n"));
	ctx.execResponses.set("git stash", ok("Saved working directory"));
	ctx.execResponses.set("git checkout", ok("Switched to branch 'feature/foo'"));
	ctx.execResponses.set("git stash pop", ok("Applied stash"));

	ctx.ui.confirm = async (_title: string, _message?: string) => {
		confirmCalled = true;
		return true;
	};

	const handler = getHandler("git-checkout", ctx);
	await handler("feature/foo", ctx);

	assert.ok(confirmCalled, "must prompt user via ctx.ui.confirm() for dirty tree");
	const stashCall = ctx.execCalls.find((c) => c.command.includes("git stash") && !c.command.includes("pop"));
	assert.ok(stashCall, "must auto-stash when user confirms");
	const popCall = ctx.execCalls.find((c) => c.command.includes("git stash pop"));
	assert.ok(popCall, "must auto-unstash after checkout");
});

// Requirement 6: /git-create-branch creates and checks out new branch
test("/git-create-branch creates and checks out a new branch", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git checkout -b", ok("Switched to a new branch 'feature/new-thing'"));

	const handler = getHandler("git-create-branch", ctx);
	await handler("feature/new-thing", ctx);

	const createCall = ctx.execCalls.find((c) => c.command.includes("git checkout -b") && c.command.includes("feature/new-thing"));
	assert.ok(createCall, "must execute git checkout -b with the branch slug");
	assert.ok(ctx.notices.length > 0, "must notify on success");
});

// Requirement 7 / 19: /git-remote-main checks out main and pulls
test("/git-remote-main checks out main and pulls from the resolved remote", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/something"));
	ctx.execResponses.set("branch.main.remote", ok("bitehive"));
	ctx.execResponses.set("git checkout main", ok("Switched to branch 'main'"));
	ctx.execResponses.set("git pull 'bitehive' main", ok("Already up to date."));

	const handler = getHandler("git-remote-main", ctx);
	await handler("", ctx);

	const checkoutMain = ctx.execCalls.find((c) => c.command.includes("git checkout main"));
	assert.ok(checkoutMain, "must checkout main");
	const pullMain = ctx.execCalls.find((c) => c.command.includes("git pull 'bitehive' main"));
	assert.ok(pullMain, "must pull from the resolved remote main branch");
});

// Requirement 26: /git-remote-main prompts to stash on dirty tree
test("/git-remote-main prompts to stash on dirty working tree", async () => {
	let confirmCalled = false;
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M file.ts\n"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/x"));
	ctx.execResponses.set("branch.main.remote", ok("bitehive"));
	ctx.execResponses.set("git stash", ok("Saved"));
	ctx.execResponses.set("git checkout main", ok("Switched"));
	ctx.execResponses.set("git pull 'bitehive' main", ok("Up to date"));
	ctx.execResponses.set("git stash pop", ok("Applied"));

	ctx.ui.confirm = async () => { confirmCalled = true; return true; };

	const handler = getHandler("git-remote-main", ctx);
	await handler("", ctx);

	assert.ok(confirmCalled, "must prompt via ctx.ui.confirm() on dirty tree");
});

// Requirement 32: /git-remote-main when already on main skips checkout, just pulls
test("/git-remote-main when already on main skips checkout and just pulls", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("main"));
	ctx.execResponses.set("branch.main.remote", ok("bitehive"));
	ctx.execResponses.set("git pull 'bitehive' main", ok("Already up to date."));

	const handler = getHandler("git-remote-main", ctx);
	await handler("", ctx);

	const checkoutCall = ctx.execCalls.find((c) => c.command.includes("git checkout main"));
	assert.ok(!checkoutCall, "should NOT checkout main when already on main");
	const pullCall = ctx.execCalls.find((c) => c.command.includes("git pull 'bitehive' main"));
	assert.ok(pullCall, "must still pull from the resolved remote main branch");
});

// Requirement 8 / 21: /git-commit stages all and commits with message argument
test("/git-commit stages all changes (git add -A) and commits with provided message", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M file.ts\n"));
	ctx.execResponses.set("git add -A", ok(""));
	ctx.execResponses.set("git commit", ok("[main abc1234] my commit message"));

	const handler = getHandler("git-commit", ctx);
	await handler("my commit message", ctx);

	const addCall = ctx.execCalls.find((c) => c.command.includes("git add -A"));
	assert.ok(addCall, "must stage all changes with git add -A");
	const commitCall = ctx.execCalls.find((c) => c.command.includes("git commit") && c.command.includes("my commit message"));
	assert.ok(commitCall, "must commit with the provided message");
});

// Requirement 27: /git-commit without message prompts interactively
// Finding 2 fix: also verify the prompted message is used in the commit command
test("/git-commit without a message argument prompts for one interactively", async () => {
	let inputCalled = false;
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M file.ts\n"));
	ctx.execResponses.set("git add -A", ok(""));
	ctx.execResponses.set("git commit", ok("[main abc1234] prompted message"));

	ctx.ui.input = async (_prompt: string) => {
		inputCalled = true;
		return "prompted message";
	};

	const handler = getHandler("git-commit", ctx);
	await handler("", ctx);

	assert.ok(inputCalled, "must prompt for commit message via ctx.ui.input() when no argument given");
	assert.ok(
		ctx.execCalls.find((c) => c.command.includes("git commit") && c.command.includes("prompted message")),
		"must use the interactively provided message in the commit",
	);
});

// Requirement 33: /git-commit with no changes notifies "nothing to commit"
test("/git-commit with no changes notifies nothing to commit", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));

	const handler = getHandler("git-commit", ctx);
	await handler("some message", ctx);

	assert.ok(
		ctx.notices.some((n) => /nothing to commit/i.test(n.message)),
		"must notify that there is nothing to commit",
	);
});

// Requirement 9 / 28: /git-pr creates a new PR against main
test("/git-pr creates a new PR via gh pr create against main", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/cool"));
	ctx.execResponses.set("gh pr view", fail("no pull requests found", 1));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("git rev-parse --abbrev-ref --symbolic-full-name @{u}", fail("no upstream", 128));
	ctx.execResponses.set("branch.feature/cool.remote", ok("bitehive"));
	ctx.execResponses.set("git push -u 'bitehive'", ok(""));
	ctx.execResponses.set("gh pr create", ok("https://github.com/org/repo/pull/42"));

	const handler = getHandler("git-pr", ctx);
	await handler("", ctx);

	const prCreate = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
	assert.ok(prCreate, "must call gh pr create");
	assert.ok(
		prCreate.command.includes("main"),
		"PR must target main as base branch",
	);
});

// Requirement 9: /git-pr detects existing PR and updates instead
test("/git-pr detects existing PR and updates instead of creating", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/cool"));
	ctx.execResponses.set("gh pr view", ok("title:\tMy PR\nurl:\thttps://github.com/org/repo/pull/42"));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("git rev-parse --abbrev-ref --symbolic-full-name @{u}", ok("origin/feature/cool"));

	const handler = getHandler("git-pr", ctx);
	await handler("", ctx);

	const prCreate = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
	assert.ok(!prCreate, "must NOT call gh pr create when PR already exists");
	assert.ok(
		ctx.notices.some((n) => n.message.includes("pull/42") || n.message.includes("already exists") || n.message.includes("existing")),
		"must notify about existing PR",
	);
});

// Requirement 34: /git-pr on main refuses with helpful message
test("/git-pr on main branch refuses with a helpful message", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("main"));

	const handler = getHandler("git-pr", ctx);
	await handler("", ctx);

	assert.ok(
		ctx.notices.some((n) => /main/i.test(n.message) && (n.level === "warning" || n.level === "error")),
		"must refuse and notify when on main branch",
	);
	const prCreate = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
	assert.ok(!prCreate, "must NOT attempt to create PR from main");
});

// Requirement 35: /git-pr when branch has no upstream pushes with -u first
test("/git-pr pushes with -u <resolved-remote> <branch> when branch has no upstream", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/no-upstream"));
	ctx.execResponses.set("git rev-parse --abbrev-ref --symbolic-full-name @{u}", fail("fatal: no upstream", 128));
	ctx.execResponses.set("branch.feature/no-upstream.remote", ok("bitehive"));
	ctx.execResponses.set("gh pr view", fail("no pull requests found", 1));
	ctx.execResponses.set("git push -u 'bitehive'", ok(""));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("gh pr create", ok("https://github.com/org/repo/pull/99"));

	const handler = getHandler("git-pr", ctx);
	await handler("", ctx);

	const pushUpstream = ctx.execCalls.find((c) => c.command.includes("git push") && c.command.includes("-u") && c.command.includes("'bitehive'"));
	assert.ok(pushUpstream, "must push with -u <resolved-remote> <branch> when no upstream exists");
});

// Review fix: in origin+upstream repos, a brand-new branch without branch.<name>.remote should still push to a valid remote
test("/git-pr defaults a new branch to origin in a multi-remote repo when no branch remote is configured", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/first-push"));
	ctx.execResponses.set("git rev-parse --abbrev-ref --symbolic-full-name @{u}", fail("fatal: no upstream", 128));
	ctx.execResponses.set("git remote", ok("origin\nupstream\n"));
	ctx.execResponses.set("gh pr view", fail("no pull requests found", 1));
	ctx.execResponses.set("git push -u 'origin' 'feature/first-push'", ok(""));
	ctx.execResponses.set("gh pr create", ok("https://github.com/org/repo/pull/100"));

	const handler = getHandler("git-pr", ctx);
	await handler("", ctx);

	const pushOrigin = ctx.execCalls.find((c) => c.command.includes("git push -u 'origin' 'feature/first-push'"));
	assert.ok(pushOrigin, "must fall back to origin for a first push in a multi-remote repo");
	assert.ok(
		ctx.execCalls.some((c) => c.command.includes("gh pr create")),
		"must continue to PR creation after pushing the new branch",
	);
});

// Requirement 10 / 28 / Scope: `/git-pr-update` — push current branch, update existing PR (or notify if none exists)
test("/git-pr-update pushes current branch and reports existing PR URL", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/update-me"));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("gh pr view", ok("title:\tMy PR\nurl:\thttps://github.com/org/repo/pull/55"));

	const handler = getHandler("git-pr-update", ctx);
	await handler("", ctx);

	const pushCall = ctx.execCalls.find((c) => c.command.includes("git push"));
	assert.ok(pushCall, "must push current branch");
	assert.ok(
		ctx.notices.some((n) => n.message.includes("pull/55") || n.message.includes("PR")),
		"must report the PR URL in notification",
	);
});

// Requirement 10: /git-pr-update notifies when no PR exists
test("/git-pr-update notifies if no existing PR is found", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/orphan"));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("gh pr view", fail("no pull requests found", 1));

	const handler = getHandler("git-pr-update", ctx);
	await handler("", ctx);

	assert.ok(
		ctx.notices.some((n) => /no.*(pr|pull request)/i.test(n.message) || n.level === "warning" || n.level === "error"),
		"must notify that no existing PR was found",
	);
});

// Requirement 20: PR commands use gh CLI — ensureGhAuthenticated() check before PR operations
test("/git-pr checks gh authentication before proceeding", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", fail("not logged in", 1));

	const handler = getHandler("git-pr", ctx);
	await handler("", ctx);

	const ghAuth = ctx.execCalls.find((c) => c.command.includes("gh auth"));
	assert.ok(ghAuth, "must check gh auth status");
	const prCreate = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
	assert.ok(!prCreate, "must NOT proceed with PR creation if gh is not authenticated");
	assert.ok(
		ctx.notices.some((n) => n.level === "error" || n.level === "warning"),
		"must notify error about gh authentication",
	);
});

// Requirement 29: All commands notify success/failure via ctx.ui.notify()
test("all commands produce at least one notification on success", async () => {
	const commandsToTest = [
		{ name: "git-status", args: "", setup: (ctx: ReturnType<typeof makeCtx>) => { ctx.execResponses.set("git status", ok("nothing to commit")); } },
		{ name: "git-create-branch", args: "test-branch", setup: (ctx: ReturnType<typeof makeCtx>) => { ctx.execResponses.set("git checkout -b", ok("Switched")); } },
	];

	for (const { name, args, setup } of commandsToTest) {
		const ctx = makeCtx();
		setup(ctx);
		const handler = getHandler(name, ctx);
		await handler(args, ctx);
		assert.ok(ctx.notices.length > 0, `${name} must produce at least one notification`);
	}
});

// Requirement 31: /git-checkout on a remote-only branch auto-tracks
test("/git-checkout on a remote-only branch auto-tracks via git checkout <branch>", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched to a new branch 'remote-only' tracking 'origin/remote-only'"));

	const handler = getHandler("git-checkout", ctx);
	await handler("remote-only", ctx);

	const checkoutCall = ctx.execCalls.find((c) => c.command.includes("git checkout") && c.command.includes("remote-only"));
	assert.ok(checkoutCall, "must execute git checkout for remote-only branch (git handles auto-tracking)");
});

// Requirement 36: Stash pop conflict after checkout notifies error, leaves stash intact
test("stash pop conflict after checkout notifies error and leaves stash intact", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M conflicting.ts\n"));
	ctx.execResponses.set("git stash", ok("Saved"));
	ctx.execResponses.set("git checkout", ok("Switched"));
	ctx.execResponses.set("git stash pop", fail("CONFLICT (content): Merge conflict in conflicting.ts", 1));

	ctx.ui.confirm = async () => true;

	const handler = getHandler("git-checkout", ctx);
	await handler("feature/conflict", ctx);

	assert.ok(
		ctx.notices.some((n) => n.level === "error" || n.level === "warning" || /conflict|stash/i.test(n.message)),
		"must notify about stash pop conflict",
	);
	// Must not call git stash drop — stash should remain
	const stashDrop = ctx.execCalls.find((c) => c.command.includes("git stash drop"));
	assert.ok(!stashDrop, "must NOT drop stash on conflict — leave it intact");
});

// Review fix: branch picker strips the remotes/ prefix, omits HEAD aliases, and keeps remote branches distinct
test("branch picker strips remotes/ prefix, omits HEAD aliases, and preserves remote identity", async () => {
	let receivedChoices: string[] = [];
	const ctx = makeCtx();
	ctx.execResponses.set("git branch -a", ok("  main\n  feature/x\n  remotes/bitehive/HEAD -> bitehive/main\n  remotes/bitehive/main\n  remotes/bitehive/feature/x\n  remotes/bitehive/feature/remote-only\n"));
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched"));

	ctx.ui.select = async (_prompt: string, choices: string[]) => {
		receivedChoices = choices;
		return choices[0] ?? "main";
	};

	const handler = getHandler("git-checkout", ctx);
	await handler("", ctx);

	assert.ok(receivedChoices.length > 0, "must provide choices to select");
	for (const choice of receivedChoices) {
		assert.ok(
			!choice.includes("remotes/"),
			`branch label should not contain the literal remotes/ prefix, got: ${choice}`,
		);
		assert.ok(
			!choice.includes(" -> "),
			`branch label should not contain remote HEAD alias text, got: ${choice}`,
		);
	}
	const mainCount = receivedChoices.filter((c) => c === "main").length;
	assert.equal(mainCount, 1, `'main' should appear exactly once, got ${mainCount}`);
	const featureXCount = receivedChoices.filter((c) => c === "feature/x").length;
	assert.equal(featureXCount, 1, `'feature/x' should appear exactly once as a local branch, got ${featureXCount}`);
	assert.ok(receivedChoices.includes("bitehive/main"), "remote main should preserve its remote name");
	assert.ok(receivedChoices.includes("bitehive/feature/x"), "remote feature/x should preserve its remote name");
	assert.ok(receivedChoices.includes("bitehive/feature/remote-only"), "remote-only branches should preserve their remote name");
});

// Review fix: when the same branch exists on multiple remotes, the picker must not collapse them into one ambiguous checkout target
test("branch picker keeps same-named remote branches separate and checks out the selected remote branch unambiguously", async () => {
	let receivedChoices: string[] = [];
	const ctx = makeCtx();
	ctx.execResponses.set("git branch -a", ok("  main\n  remotes/origin/feature/foo\n  remotes/upstream/feature/foo\n"));
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout --track 'origin/feature/foo'", ok("branch 'feature/foo' set up to track 'origin/feature/foo'"));

	ctx.ui.select = async (_prompt: string, choices: string[]) => {
		receivedChoices = choices;
		return "origin/feature/foo";
	};

	const handler = getHandler("git-checkout", ctx);
	await handler("", ctx);

	assert.deepEqual(receivedChoices, ["main", "origin/feature/foo", "upstream/feature/foo"], "picker should keep both remote branches visible and distinct");
	assert.ok(
		ctx.execCalls.some((c) => c.command.includes("git checkout --track 'origin/feature/foo'")),
		"must checkout the selected remote branch with an unambiguous target",
	);
});
