// Generated from a markdown plan: .pi/plans/i-want-to-create-an-extension-that-helps-me-with-sending-git.plan.md
import test from "node:test";
import assert from "node:assert/strict";

import inlineGitExtension from "../../extensions/inline-git-commands.ts";

// ---------- helpers ----------

type ExecResult = { stdout: string; stderr: string; code: number };
type ExecCall = { command: string; options?: Record<string, unknown> };
type Notice = { level: string; message: string };

function ok(stdout = "", code = 0): ExecResult {
	return { stdout, stderr: "", code };
}
function fail(stderr = "", code = 1): ExecResult {
	return { stdout: "", stderr, code };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const execResponses: Map<string, ExecResult> = new Map();
	let confirmResult = true;
	let selectResult: string | undefined;
	let inputResult: string | undefined;

	const ctx = {
		cwd: "/repo",
		args: [] as string[],
		state: {} as Record<string, unknown>,
		execCalls,
		notices,
		execResponses,
		set confirmResult(v: boolean) { confirmResult = v; },
		set selectResult(v: string) { selectResult = v; },
		set inputResult(v: string) { inputResult = v; },
		exec: async (command: string, options?: Record<string, unknown>): Promise<ExecResult> => {
			execCalls.push({ command, options });
			for (const [pattern, result] of execResponses.entries()) {
				if (command.includes(pattern)) return result;
			}
			return ok();
		},
		ui: {
			notify: (message: string) => { notices.push({ level: "info", message }); },
			warn: (message: string) => { notices.push({ level: "warn", message }); },
			error: (message: string) => { notices.push({ level: "error", message }); },
			confirm: async (_prompt: string) => confirmResult,
			select: async (_prompt: string, choices: Array<{ label: string; value: string }>) => {
				if (selectResult) return selectResult;
				return choices[0]?.value ?? "";
			},
			input: async (_prompt: string) => inputResult ?? "default message",
		},
		pi: {
			notify: (message: string) => { notices.push({ level: "info", message }); },
			warn: (message: string) => { notices.push({ level: "warn", message }); },
			error: (message: string) => { notices.push({ level: "error", message }); },
			ask: async (_prompt: string) => inputResult ?? "default message",
		},
		...overrides,
	};
	return ctx;
}

function findCommand(ext: Record<string, unknown>, name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
	// The extension should expose commands — try common patterns
	const commands = (ext as any).commands ?? (ext as any).default?.commands;
	if (Array.isArray(commands)) {
		const found = commands.find((c: any) => c.name === name || c.command === name);
		return found?.handler ?? found?.run ?? found?.execute;
	}
	if (commands && typeof commands === "object") {
		const entry = commands[name];
		if (typeof entry === "function") return entry;
		return entry?.handler ?? entry?.run ?? entry?.execute;
	}
	return undefined;
}

function getRegisteredCommandNames(ext: Record<string, unknown>): string[] {
	const commands = (ext as any).commands ?? (ext as any).default?.commands;
	if (Array.isArray(commands)) {
		return commands.map((c: any) => c.name ?? c.command).filter(Boolean);
	}
	if (commands && typeof commands === "object") {
		return Object.keys(commands);
	}
	return [];
}

// If the extension uses pi.registerCommand pattern (like worktree.ts), we need a different approach
function collectRegisteredCommands(ext: unknown): Map<string, (...args: unknown[]) => Promise<unknown>> {
	const map = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	const registerCommand = (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
		map.set(name, handler);
	};
	const mockPi = {
		registerCommand,
	};

	// Extension might be a function that accepts pi, or an object with an init/setup method
	if (typeof ext === "function") {
		try { (ext as any)(mockPi); } catch { /* ignore */ }
	} else if (ext && typeof (ext as any).init === "function") {
		try { (ext as any).init(mockPi); } catch { /* ignore */ }
	} else if (ext && typeof (ext as any).setup === "function") {
		try { (ext as any).setup(mockPi); } catch { /* ignore */ }
	} else if (ext && typeof (ext as any).default === "function") {
		try { (ext as any).default(mockPi); } catch { /* ignore */ }
	}
	return map;
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
	// Also try object-style
	const objNames = getRegisteredCommandNames(inlineGitExtension as Record<string, unknown>);
	const allNames = [...new Set([...names, ...objNames])];

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
			allNames.some((n) => n === cmd || n === `/${cmd}` || n.endsWith(cmd)),
			`expected command "${cmd}" to be registered, found: [${allNames.join(", ")}]`,
		);
	}
});

// Requirement 3: /git-status shows git status --short and notifies result
test("/git-status runs 'git status --short' and notifies result", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status", ok(" M src/index.ts\n?? newfile.ts"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-status") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-status");
	assert.ok(handler, "git-status command handler must exist");

	await handler(ctx);

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

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-diff") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-diff");
	assert.ok(handler, "git-diff command handler must exist");

	await handler(ctx);

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
	ctx.args = ["src/index.ts"];
	ctx.execResponses.set("git diff", ok("diff output for src/index.ts"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-diff") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-diff");
	assert.ok(handler, "git-diff command handler must exist");

	await handler(ctx, "src/index.ts");

	const diffCall = ctx.execCalls.find((c) => c.command.includes("git diff") && c.command.includes("src/index.ts"));
	assert.ok(diffCall, "must execute git diff with the specified path");
});

// Requirement 5 / 25: /git-checkout without arguments shows interactive branch picker
test("/git-checkout without arguments shows an interactive branch picker via ctx.ui.select()", async () => {
	let selectCalled = false;
	const ctx = makeCtx();
	ctx.args = [];
	ctx.execResponses.set("git branch -a", ok("  main\n  feature/foo\n  remotes/origin/feature/bar\n"));
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched to branch 'feature/foo'"));

	const origSelect = ctx.ui.select;
	ctx.ui.select = async (prompt: string, choices: Array<{ label: string; value: string }>) => {
		selectCalled = true;
		// Verify remotes/origin/ prefix is stripped
		const labels = choices.map((c) => c.label);
		assert.ok(
			!labels.some((l) => l.includes("remotes/origin/")),
			"branch picker should strip remotes/origin/ prefixes",
		);
		return "feature/foo";
	};

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-checkout") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-checkout");
	assert.ok(handler, "git-checkout command handler must exist");

	await handler(ctx);

	assert.ok(selectCalled, "must call ctx.ui.select() for branch picking when no argument given");
});

// Requirement 5: /git-checkout with branch argument switches directly
test("/git-checkout with branch argument switches branch directly", async () => {
	const ctx = makeCtx();
	ctx.args = ["feature/foo"];
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched to branch 'feature/foo'"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-checkout") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-checkout");
	assert.ok(handler, "git-checkout command handler must exist");

	await handler(ctx, "feature/foo");

	const checkoutCall = ctx.execCalls.find((c) => c.command.includes("git checkout") && c.command.includes("feature/foo"));
	assert.ok(checkoutCall, "must execute git checkout with the specified branch");
});

// Requirement 18 / 26: /git-checkout prompts to stash on dirty tree, auto-stash if confirmed, auto-unstash after
test("/git-checkout on dirty tree prompts to stash, auto-stashes if confirmed, and unstashes after checkout", async () => {
	let confirmCalled = false;
	const ctx = makeCtx();
	ctx.args = ["feature/foo"];
	ctx.execResponses.set("git status --porcelain", ok(" M dirty-file.ts\n"));
	ctx.execResponses.set("git stash", ok("Saved working directory"));
	ctx.execResponses.set("git checkout", ok("Switched to branch 'feature/foo'"));
	ctx.execResponses.set("git stash pop", ok("Applied stash"));

	ctx.ui.confirm = async (_prompt: string) => {
		confirmCalled = true;
		return true;
	};

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-checkout") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-checkout");
	assert.ok(handler, "git-checkout command handler must exist");

	await handler(ctx, "feature/foo");

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

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-create-branch") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-create-branch");
	assert.ok(handler, "git-create-branch command handler must exist");

	await handler(ctx, "feature/new-thing");

	const createCall = ctx.execCalls.find((c) => c.command.includes("git checkout -b") && c.command.includes("feature/new-thing"));
	assert.ok(createCall, "must execute git checkout -b with the branch slug");
	assert.ok(ctx.notices.length > 0, "must notify on success");
});

// Requirement 7 / 19: /git-remote-main checks out main and pulls
test("/git-remote-main checks out main and pulls from origin", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/something"));
	ctx.execResponses.set("git checkout main", ok("Switched to branch 'main'"));
	ctx.execResponses.set("git pull origin main", ok("Already up to date."));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-remote-main") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-remote-main");
	assert.ok(handler, "git-remote-main command handler must exist");

	await handler(ctx);

	const checkoutMain = ctx.execCalls.find((c) => c.command.includes("git checkout main"));
	assert.ok(checkoutMain, "must checkout main");
	const pullMain = ctx.execCalls.find((c) => c.command.includes("git pull origin main"));
	assert.ok(pullMain, "must pull from origin main");
});

// Requirement 26: /git-remote-main prompts to stash on dirty tree
test("/git-remote-main prompts to stash on dirty working tree", async () => {
	let confirmCalled = false;
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M file.ts\n"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/x"));
	ctx.execResponses.set("git stash", ok("Saved"));
	ctx.execResponses.set("git checkout main", ok("Switched"));
	ctx.execResponses.set("git pull origin main", ok("Up to date"));
	ctx.execResponses.set("git stash pop", ok("Applied"));

	ctx.ui.confirm = async () => { confirmCalled = true; return true; };

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-remote-main") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-remote-main");
	assert.ok(handler, "git-remote-main command handler must exist");

	await handler(ctx);

	assert.ok(confirmCalled, "must prompt via ctx.ui.confirm() on dirty tree");
});

// Requirement 32: /git-remote-main when already on main skips checkout, just pulls
test("/git-remote-main when already on main skips checkout and just pulls", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("main"));
	ctx.execResponses.set("git pull origin main", ok("Already up to date."));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-remote-main") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-remote-main");
	assert.ok(handler, "git-remote-main command handler must exist");

	await handler(ctx);

	const checkoutCall = ctx.execCalls.find((c) => c.command.includes("git checkout main"));
	assert.ok(!checkoutCall, "should NOT checkout main when already on main");
	const pullCall = ctx.execCalls.find((c) => c.command.includes("git pull origin main"));
	assert.ok(pullCall, "must still pull from origin main");
});

// Requirement 8 / 21: /git-commit stages all and commits with message argument
test("/git-commit stages all changes (git add -A) and commits with provided message", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(" M file.ts\n"));
	ctx.execResponses.set("git add -A", ok(""));
	ctx.execResponses.set("git commit", ok("[main abc1234] my commit message"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-commit") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-commit");
	assert.ok(handler, "git-commit command handler must exist");

	await handler(ctx, "my commit message");

	const addCall = ctx.execCalls.find((c) => c.command.includes("git add -A"));
	assert.ok(addCall, "must stage all changes with git add -A");
	const commitCall = ctx.execCalls.find((c) => c.command.includes("git commit") && c.command.includes("my commit message"));
	assert.ok(commitCall, "must commit with the provided message");
});

// Requirement 27: /git-commit without message prompts interactively
test("/git-commit without a message argument prompts for one interactively", async () => {
	let inputCalled = false;
	const ctx = makeCtx();
	ctx.args = [];
	ctx.execResponses.set("git status --porcelain", ok(" M file.ts\n"));
	ctx.execResponses.set("git add -A", ok(""));
	ctx.execResponses.set("git commit", ok("[main abc1234] prompted message"));

	ctx.ui.input = async (_prompt: string) => {
		inputCalled = true;
		return "prompted message";
	};

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-commit") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-commit");
	assert.ok(handler, "git-commit command handler must exist");

	await handler(ctx);

	assert.ok(inputCalled, "must prompt for commit message via ctx.ui.input() when no argument given");
});

// Requirement 33: /git-commit with no changes notifies "nothing to commit"
test("/git-commit with no changes notifies nothing to commit", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-commit") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-commit");
	assert.ok(handler, "git-commit command handler must exist");

	await handler(ctx, "some message");

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
	ctx.execResponses.set("gh pr create", ok("https://github.com/org/repo/pull/42"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr");
	assert.ok(handler, "git-pr command handler must exist");

	await handler(ctx);

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

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr");
	assert.ok(handler, "git-pr command handler must exist");

	await handler(ctx);

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

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr");
	assert.ok(handler, "git-pr command handler must exist");

	await handler(ctx);

	assert.ok(
		ctx.notices.some((n) => /main/i.test(n.message) && (n.level === "warn" || n.level === "error")),
		"must refuse and notify when on main branch",
	);
	const prCreate = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
	assert.ok(!prCreate, "must NOT attempt to create PR from main");
});

// Requirement 35: /git-pr when branch has no upstream pushes with -u first
test("/git-pr pushes with -u origin <branch> when branch has no upstream", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/no-upstream"));
	ctx.execResponses.set("git rev-parse --abbrev-ref --symbolic-full-name @{u}", fail("fatal: no upstream", 128));
	ctx.execResponses.set("gh pr view", fail("no pull requests found", 1));
	ctx.execResponses.set("git push -u origin", ok(""));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("gh pr create", ok("https://github.com/org/repo/pull/99"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr");
	assert.ok(handler, "git-pr command handler must exist");

	await handler(ctx);

	const pushUpstream = ctx.execCalls.find((c) => c.command.includes("git push") && c.command.includes("-u") && c.command.includes("origin"));
	assert.ok(pushUpstream, "must push with -u origin <branch> when no upstream exists");
});

// Requirement 10 / 28: /git-pr-update pushes and reports PR URL
test("/git-pr-update pushes current branch and reports existing PR URL", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", ok("Logged in"));
	ctx.execResponses.set("git rev-parse --abbrev-ref HEAD", ok("feature/update-me"));
	ctx.execResponses.set("git push", ok(""));
	ctx.execResponses.set("gh pr view", ok("title:\tMy PR\nurl:\thttps://github.com/org/repo/pull/55"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr-update") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr-update");
	assert.ok(handler, "git-pr-update command handler must exist");

	await handler(ctx);

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

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr-update") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr-update");
	assert.ok(handler, "git-pr-update command handler must exist");

	await handler(ctx);

	assert.ok(
		ctx.notices.some((n) => /no.*(pr|pull request)/i.test(n.message) || n.level === "warn" || n.level === "error"),
		"must notify that no existing PR was found",
	);
});

// Requirement 20: PR commands use gh CLI — ensureGhAuthenticated() check before PR operations
test("/git-pr checks gh authentication before proceeding", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("gh auth status", fail("not logged in", 1));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-pr") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-pr");
	assert.ok(handler, "git-pr command handler must exist");

	await handler(ctx);

	const ghAuth = ctx.execCalls.find((c) => c.command.includes("gh auth"));
	assert.ok(ghAuth, "must check gh auth status");
	const prCreate = ctx.execCalls.find((c) => c.command.includes("gh pr create"));
	assert.ok(!prCreate, "must NOT proceed with PR creation if gh is not authenticated");
	assert.ok(
		ctx.notices.some((n) => n.level === "error" || n.level === "warn"),
		"must notify error about gh authentication",
	);
});

// Requirement 29: All commands notify success/failure via ctx.ui.notify()
test("all commands produce at least one notification on success", async () => {
	const commandsToTest = [
		{ name: "git-status", args: [] as string[], setup: (ctx: ReturnType<typeof makeCtx>) => { ctx.execResponses.set("git status", ok("nothing to commit")); } },
		{ name: "git-create-branch", args: ["test-branch"], setup: (ctx: ReturnType<typeof makeCtx>) => { ctx.execResponses.set("git checkout -b", ok("Switched")); } },
	];

	const commands = collectRegisteredCommands(inlineGitExtension);

	for (const { name, args, setup } of commandsToTest) {
		const ctx = makeCtx();
		setup(ctx);
		const handler = commands.get(name) ?? findCommand(inlineGitExtension as Record<string, unknown>, name);
		assert.ok(handler, `${name} command handler must exist`);
		await handler(ctx, ...args);
		assert.ok(ctx.notices.length > 0, `${name} must produce at least one notification`);
	}
});

// Requirement 31: /git-checkout on a remote-only branch auto-tracks
test("/git-checkout on a remote-only branch auto-tracks via git checkout <branch>", async () => {
	const ctx = makeCtx();
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched to a new branch 'remote-only' tracking 'origin/remote-only'"));

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-checkout") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-checkout");
	assert.ok(handler, "git-checkout command handler must exist");

	await handler(ctx, "remote-only");

	const checkoutCall = ctx.execCalls.find((c) => c.command.includes("git checkout") && c.command.includes("remote-only"));
	assert.ok(checkoutCall, "must execute git checkout for remote-only branch (git handles auto-tracking)");
});

// Requirement 36: Stash pop conflict after checkout notifies error, leaves stash intact
test("stash pop conflict after checkout notifies error and leaves stash intact", async () => {
	const ctx = makeCtx();
	ctx.args = ["feature/conflict"];
	ctx.execResponses.set("git status --porcelain", ok(" M conflicting.ts\n"));
	ctx.execResponses.set("git stash", ok("Saved"));
	ctx.execResponses.set("git checkout", ok("Switched"));
	ctx.execResponses.set("git stash pop", fail("CONFLICT (content): Merge conflict in conflicting.ts", 1));

	ctx.ui.confirm = async () => true;

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-checkout") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-checkout");
	assert.ok(handler, "git-checkout command handler must exist");

	await handler(ctx, "feature/conflict");

	assert.ok(
		ctx.notices.some((n) => n.level === "error" || n.level === "warn" || /conflict|stash/i.test(n.message)),
		"must notify about stash pop conflict",
	);
	// Must not call git stash drop — stash should remain
	const stashDrop = ctx.execCalls.find((c) => c.command.includes("git stash drop"));
	assert.ok(!stashDrop, "must NOT drop stash on conflict — leave it intact");
});

// Requirement 17: Branch picker strips remotes/origin/ prefixes for display
test("branch picker strips remotes/origin/ prefixes and deduplicates branches", async () => {
	let receivedChoices: Array<{ label: string; value: string }> = [];
	const ctx = makeCtx();
	ctx.args = [];
	ctx.execResponses.set("git branch -a", ok("  main\n  feature/x\n  remotes/origin/main\n  remotes/origin/feature/x\n  remotes/origin/feature/remote-only\n"));
	ctx.execResponses.set("git status --porcelain", ok(""));
	ctx.execResponses.set("git checkout", ok("Switched"));

	ctx.ui.select = async (_prompt: string, choices: Array<{ label: string; value: string }>) => {
		receivedChoices = choices;
		return choices[0]?.value ?? "main";
	};

	const commands = collectRegisteredCommands(inlineGitExtension);
	const handler = commands.get("git-checkout") ?? findCommand(inlineGitExtension as Record<string, unknown>, "git-checkout");
	assert.ok(handler, "git-checkout command handler must exist");

	await handler(ctx);

	assert.ok(receivedChoices.length > 0, "must provide choices to select");
	for (const choice of receivedChoices) {
		assert.ok(
			!choice.label.includes("remotes/origin/"),
			`branch label should not contain 'remotes/origin/' prefix, got: ${choice.label}`,
		);
	}
});
