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

type CommandHandler = (ctx: Ctx, ...args: string[]) => Promise<unknown> | unknown;

const TEST_WORKTREE_ROOT = "/tmp/pi-worktrees";
process.env.PI_WORKTREE_ROOT = TEST_WORKTREE_ROOT;

function worktreePath(slug: string): string {
	return `${TEST_WORKTREE_ROOT}/repo/${slug}`;
}

function createCtx(overrides: Partial<Ctx> = {}): Ctx {
	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const persistCalls: PersistCall[] = [];
	const promptCalls: PromptCall[] = [];
	const artifacts = new Map<string, string>();

	return {
		cwd: "/repo",
		state: {},
		execCalls,
		notices,
		persistCalls,
		promptCalls,
		artifacts,
		exec: async (command: string, options?: Record<string, unknown>) => {
			execCalls.push({ command, options });
			throw new Error(`Unexpected exec: ${command}`);
		},
		persistArtifact: async (path: string, content: string, options?: { append?: boolean }) => {
			persistCalls.push({ path, content, mode: options?.append ? "append" : "write" });
			const previous = artifacts.get(path) ?? "";
			artifacts.set(path, options?.append ? `${previous}${content}` : content);
		},
		readArtifact: async (path: string) => artifacts.get(path),
		pi: {
			notify(message: string) {
				notices.push({ level: "info", message });
			},
			warn(message: string) {
				notices.push({ level: "warn", message });
			},
			error(message: string) {
				notices.push({ level: "error", message });
			},
			ask: async (prompt: string) => {
				promptCalls.push({ prompt });
				return ["Generated commit message", "Generated PR title", "Generated PR body"].join("\n\n");
			},
		},
		...overrides,
	};
}

function seedArtifact(ctx: Ctx, path: string, value: unknown) {
	ctx.artifacts.set(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function historyEntries(ctx: Ctx): Array<Record<string, unknown>> {
	return (ctx.artifacts.get(".pi/worktrees/history.jsonl") ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => parseJson<Record<string, unknown>>(line));
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
	assert.equal(typeof match?.handler, "function", `expected ${name} to have a callable handler`);
	return match!.handler;
}

function messagesAtLevel(ctx: Ctx, level: string): string[] {
	return ctx.notices.filter((notice) => notice.level === level).map((notice) => notice.message);
}

function firstWrite(ctx: Ctx, path: string): PersistCall | undefined {
	return ctx.persistCalls.find((call) => call.path === path && call.mode === "write");
}

test("Add a new extension with /worktree-start, /worktree-pr, and /worktree-cleanup command registration following local extension conventions", () => {
	assert.equal(typeof worktreeExtension, "function");
	const commands = getRegisteredCommands(worktreeExtension);
	const names = commands.map((command) => command.name);

	assert.ok(names.includes("worktree-start"), "expected worktree-start command registration");
	assert.ok(names.includes("worktree-pr"), "expected worktree-pr command registration");
	assert.ok(names.includes("worktree-cleanup"), "expected worktree-cleanup command registration");
});

test("/worktree-start creates a managed worktree from main using git worktree, persists metadata/history, attempts PI handoff in target cwd, and avoids model usage", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");
	const ctx = createCtx();

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-a")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") return { stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "", code: 0 };
		if (command.startsWith("git worktree add ")) return { stdout: "", stderr: "", code: 0 };
		if (command === "pi") return { stdout: "", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await startWorktree(ctx, "feature-a");

	assert.equal(ctx.promptCalls.length, 0, "start flow should avoid model usage until /worktree-pr");
	const addCall = ctx.execCalls.find((call) => call.command.startsWith("git worktree add "));
	assert.ok(addCall, "expected git worktree to be used for worktree creation");
	assert.match(addCall?.command ?? "", /worktree\/feature-a/);
	assert.match(addCall?.command ?? "", /main/);

	const handoffCall = ctx.execCalls.find((call) => call.command === "pi");
	assert.ok(handoffCall, "expected automatic PI handoff attempt");
	assert.equal(handoffCall?.options?.cwd, worktreePath("feature-a"));
	assert.ok(ctx.execCalls.findIndex((call) => call.command.startsWith("git worktree add ")) < ctx.execCalls.findIndex((call) => call.command === "pi"), "expected handoff after creation");

	const metadata = parseJson<Record<string, unknown>>(ctx.artifacts.get(".pi/worktrees/feature-a.json")!);
	assert.equal(metadata.slug, "feature-a");
	assert.equal(metadata.branch, "worktree/feature-a");
	assert.equal(metadata.worktreePath, worktreePath("feature-a"));

	const history = historyEntries(ctx);
	assert.ok(history.some((entry) => entry.type === "worktree-start" && entry.slug === "feature-a"));

	const infoMessages = messagesAtLevel(ctx, "info");
	assert.ok(infoMessages.some((message) => /validat/i.test(message)));
	assert.ok(infoMessages.some((message) => /creat/i.test(message)));
	assert.ok(infoMessages.some((message) => /handoff/i.test(message)));
});

test("/worktree-start persists managed metadata before attempting pi handoff so follow-up commands can discover the new checkout immediately", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");
	const ctx = createCtx();
	let metadataVisibleDuringHandoff = false;
	let historyVisibleDuringHandoff = false;

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-before-handoff")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") return { stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "", code: 0 };
		if (command.startsWith("git worktree add ")) return { stdout: "", stderr: "", code: 0 };
		if (command === "pi") {
			const metadata = ctx.artifacts.get(".pi/worktrees/feature-before-handoff.json");
			const history = ctx.artifacts.get(".pi/worktrees/history.jsonl") ?? "";
			metadataVisibleDuringHandoff = Boolean(metadata && parseJson<Record<string, unknown>>(metadata).branch === "worktree/feature-before-handoff");
			historyVisibleDuringHandoff = /"type":"worktree-start"/.test(history) && /"slug":"feature-before-handoff"/.test(history);
			return { stdout: "", stderr: "", code: 0 };
		}
		throw new Error(`Unexpected exec: ${command}`);
	};

	await startWorktree(ctx, "feature-before-handoff");

	assert.equal(metadataVisibleDuringHandoff, true, "expected metadata to exist before pi handoff begins");
	assert.equal(historyVisibleDuringHandoff, true, "expected history entry to exist before pi handoff begins");
	const metadata = parseJson<Record<string, unknown>>(ctx.artifacts.get(".pi/worktrees/feature-before-handoff.json")!);
	assert.equal(metadata.branch, "worktree/feature-before-handoff");
	assert.equal((metadata.handoff as Record<string, unknown>)?.ok, true);
});

test("If automatic handoff fails, /worktree-start still creates the worktree, persists failure details, and shows a usable fallback command", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");
	const ctx = createCtx();

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-b")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") return { stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "", code: 0 };
		if (command.startsWith("git worktree add ")) return { stdout: "", stderr: "", code: 0 };
		if (command === "pi") return { stdout: "handoff failed\n", stderr: "process exited immediately", code: 1 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await startWorktree(ctx, "feature-b");

	const metadata = parseJson<Record<string, unknown>>(ctx.artifacts.get(".pi/worktrees/feature-b.json")!);
	assert.equal((metadata.handoff as Record<string, unknown>)?.attempted, true);
	assert.equal((metadata.handoff as Record<string, unknown>)?.ok, false);
	assert.match(String((metadata.handoff as Record<string, unknown>)?.reason ?? ""), /process exited immediately/i);
	assert.match(messagesAtLevel(ctx, "warn").join("\n"), /cd .*feature-b.*&& pi/i);
});

test("/worktree-start fails immediately when git worktree add fails and does not persist fake success metadata", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");
	const ctx = createCtx();

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-create-fail")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") return { stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "", code: 0 };
		if (command.startsWith("git worktree add ")) return { stdout: "", stderr: "fatal: could not create leading directories", code: 128 };
		if (command === "pi") throw new Error("handoff must not run after failed worktree creation");
		throw new Error(`Unexpected exec: ${command}`);
	};

	await assert.rejects(() => Promise.resolve(startWorktree(ctx, "feature-create-fail")), /leading directories|git worktree add failed/i);
	assert.equal(ctx.artifacts.get(".pi/worktrees/feature-create-fail.json"), undefined);
	assert.ok(!messagesAtLevel(ctx, "info").some((message) => /Managed worktree ready/i.test(message)));
	assert.ok(!ctx.execCalls.some((call) => call.command === "pi"));
	assert.ok(historyEntries(ctx).some((entry) => entry.type === "worktree-start-failed" && entry.phase === "create" && /leading directories/i.test(String(entry.reason))));
});

test("Interactive /worktree-start handoff uses a real terminal launch instead of non-interactive exec", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");
	let stopCalled = 0;
	let startCalled = 0;
	let renderCalled = 0;
	const ctx = createCtx({
		hasUI: true,
		ui: {
			custom: async <T>(renderer: (tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown) => {
				let result!: T;
				renderer(
					{
						stop: () => {
							stopCalled += 1;
						},
						start: () => {
							startCalled += 1;
						},
						requestRender: () => {
							renderCalled += 1;
						},
					},
					null,
					null,
					(value: T) => {
						result = value;
					},
				);
				return result;
			},
		},
		spawnInteractive: (command, args, options) => {
			ctx.execCalls.push({ command: `${command} ${args.join(" ")}`.trim(), options });
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), signal: null };
		},
	});

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-ui")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") return { stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "", code: 0 };
		if (command.startsWith("git worktree add ")) return { stdout: "", stderr: "", code: 0 };
		if (command === "pi") throw new Error("interactive handoff should not use ctx.exec");
		throw new Error(`Unexpected exec: ${command}`);
	};

	await startWorktree(ctx, "feature-ui");

	assert.equal(stopCalled, 1);
	assert.equal(startCalled, 1);
	assert.equal(renderCalled, 1);
	const handoffCall = ctx.execCalls.find((call) => call.command === "pi" || String(call.command).endsWith("/pi") || String(call.command).endsWith("/node"));
	assert.ok(handoffCall, "expected interactive handoff to launch pi");
	assert.equal(handoffCall?.options?.cwd, worktreePath("feature-ui"));
});

test("Interactive /worktree-start handoff falls back to the installed CLI script when pi is not on PATH", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");
	const originalPath = process.env.PATH;
	process.env.PATH = "";
	const ctx = createCtx({
		hasUI: true,
		ui: {
			custom: async <T>(renderer: (tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown) => {
				let result!: T;
				renderer({}, null, null, (value: T) => {
					result = value;
				});
				return result;
			},
		},
		spawnInteractive: (command, args, options) => {
			ctx.execCalls.push({ command: `${command} ${args.join(" ")}`.trim(), options });
			return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), signal: null };
		},
	});

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-ui-pathless")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") return { stdout: "worktree /repo\nbranch refs/heads/main\n", stderr: "", code: 0 };
		if (command.startsWith("git worktree add ")) return { stdout: "", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	try {
		await startWorktree(ctx, "feature-ui-pathless");
	} finally {
		process.env.PATH = originalPath;
	}

	const handoffCall = ctx.execCalls.find((call) => String(call.command).includes("dist/cli.js"));
	assert.ok(handoffCall, "expected interactive handoff to fall back to the resolved pi CLI script");
	assert.equal(handoffCall?.options?.cwd, worktreePath("feature-ui-pathless"));
});

test("Representative /worktree-start validation failures reject before creation and append auditable failure reasons to history", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");

	const outsideRepo = createCtx();
	outsideRepo.exec = async (command: string, options?: Record<string, unknown>) => {
		outsideRepo.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") throw new Error("fatal: not a git repository");
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(startWorktree(outsideRepo, "feature-outside")), /not a git repository/i);
	assert.ok(!outsideRepo.execCalls.some((call) => call.command.startsWith("git worktree add ")));
	assert.ok(historyEntries(outsideRepo).some((entry) => entry.type === "worktree-start-failed" && entry.phase === "validate" && /not a git repository/i.test(String(entry.reason))));

	const missingOrigin = createCtx();
	missingOrigin.exec = async (command: string, options?: Record<string, unknown>) => {
		missingOrigin.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "", stderr: "error: No such remote 'origin'", code: 2 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(startWorktree(missingOrigin, "feature-originless")), /origin|remote/i);
	assert.ok(historyEntries(missingOrigin).some((entry) => entry.type === "worktree-start-failed" && /origin/i.test(String(entry.reason))));
});

test("Duplicate slug metadata, duplicate branch, and existing unmanaged target path cause /worktree-start to refuse before git worktree add", async () => {
	const startWorktree = getCommand(worktreeExtension, "worktree-start");

	const duplicateMetadata = createCtx();
	seedArtifact(duplicateMetadata, ".pi/worktrees/feature-meta.json", { slug: "feature-meta", branch: "worktree/feature-meta", worktreePath: worktreePath("feature-meta") });
	duplicateMetadata.exec = async (command: string, options?: Record<string, unknown>) => {
		duplicateMetadata.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(startWorktree(duplicateMetadata, "feature-meta")), /metadata|managed|exists/i);

	const duplicateBranch = createCtx();
	duplicateBranch.exec = async (command: string, options?: Record<string, unknown>) => {
		duplicateBranch.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-dup")) return { stdout: "refs/heads/worktree/feature-dup\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(startWorktree(duplicateBranch, "feature-dup")), /exists|worktree\/feature-dup/i);

	const unmanagedPath = createCtx();
	unmanagedPath.exec = async (command: string, options?: Record<string, unknown>) => {
		unmanagedPath.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "main\n", stderr: "", code: 0 };
		if (command === "git remote get-url origin") return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0 };
		if (command.includes("show-ref") && command.includes("worktree/feature-path")) return { stdout: "", stderr: "", code: 1 };
		if (command === "git worktree list --porcelain") {
			return { stdout: ["worktree /repo", "branch refs/heads/main", "", `worktree ${worktreePath("feature-path")}`, "branch refs/heads/other"].join("\n"), stderr: "", code: 0 };
		}
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(startWorktree(unmanagedPath, "feature-path")), /unmanaged|worktree path|exists/i);
});

test("/worktree-pr verifies managed-worktree discovery via repository-backed metadata, uses gh for PR creation, and persists PR metadata/history", async () => {
	const createPr = getCommand(worktreeExtension, "worktree-pr");
	const ctx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-f" });
	seedArtifact(ctx, ".pi/worktrees/feature-f.json", {
		slug: "feature-f",
		branch: "worktree/feature-f",
		repoRoot: "/repo",
		mainCheckoutPath: "/repo",
		worktreePath: "/parallel/.worktrees/repo/feature-f",
		createdAt: "2025-01-01T00:00:00.000Z",
	});

	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		assert.equal(options?.cwd, "/parallel/.worktrees/repo/feature-f");
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-f\n", stderr: "", code: 0 };
		if (command === "gh auth status") return { stdout: "Logged in to github.com\n", stderr: "", code: 0 };
		if (command === "git status --short") return { stdout: "M src/file.ts\n", stderr: "", code: 0 };
		if (command === "git diff --stat") return { stdout: " src/file.ts | 1 +\n", stderr: "", code: 0 };
		if (command.startsWith("git diff -- ")) return { stdout: "diff --git a/src/file.ts b/src/file.ts\n", stderr: "", code: 0 };
		if (command.startsWith("gh pr view ")) return { stdout: "", stderr: "not found", code: 1 };
		if (command.startsWith("git add ")) return { stdout: "", stderr: "", code: 0 };
		if (command.startsWith("git commit -m ")) return { stdout: "[worktree/feature-f abc123] Generated commit message\n", stderr: "", code: 0 };
		if (command === "git push -u origin worktree/feature-f") return { stdout: "", stderr: "", code: 0 };
		if (command.startsWith("gh pr create ") && command.includes("--base main")) return { stdout: "https://github.com/org/repo/pull/123\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await createPr(ctx);

	assert.equal(ctx.promptCalls.length, 1);
	assert.ok(ctx.execCalls.some((call) => call.command === "gh auth status"));
	assert.ok(ctx.execCalls.some((call) => call.command === "git status --short"));
	assert.ok(ctx.execCalls.some((call) => call.command.startsWith("gh pr create ") && call.command.includes("--base main")), "expected gh to create the PR");

	const metadata = parseJson<Record<string, unknown>>(ctx.artifacts.get(".pi/worktrees/feature-f.json")!);
	assert.equal(metadata.prUrl, "https://github.com/org/repo/pull/123");
	assert.match(String(metadata.commitStatus ?? ""), /created/i);
	assert.match(String(metadata.pushStatus ?? ""), /pushed/i);
	assert.match(String(metadata.prStatus ?? ""), /created/i);
	assert.ok(historyEntries(ctx).some((entry) => entry.type === "worktree-pr" && entry.prUrl === "https://github.com/org/repo/pull/123"));
});

test("/worktree-pr reads shared metadata from the main checkout when the worktree has no local .pi metadata copy", async () => {
	const createPr = getCommand(worktreeExtension, "worktree-pr");
	const ctx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-shared" });
	seedArtifact(ctx, "/repo/.pi/worktrees/feature-shared.json", {
		slug: "feature-shared",
		branch: "worktree/feature-shared",
		repoRoot: "/repo",
		mainCheckoutPath: "/repo",
		worktreePath: "/parallel/.worktrees/repo/feature-shared",
		createdAt: "2025-01-01T00:00:00.000Z",
	});
	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		assert.equal(options?.cwd, "/parallel/.worktrees/repo/feature-shared");
		if (command === "git rev-parse --show-toplevel") return { stdout: "/parallel/.worktrees/repo/feature-shared\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-shared\n", stderr: "", code: 0 };
		if (command === "git rev-parse --git-common-dir") return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		if (command === "gh auth status") return { stdout: "Logged in to github.com\n", stderr: "", code: 0 };
		if (command === "git status --short") return { stdout: "", stderr: "", code: 0 };
		if (command === "git push -u origin worktree/feature-shared") return { stdout: "", stderr: "", code: 0 };
		if (command.startsWith("gh pr view ")) return { stdout: "https://github.com/org/repo/pull/200\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await createPr(ctx);

	const sharedMetadata = parseJson<Record<string, unknown>>(ctx.artifacts.get("/repo/.pi/worktrees/feature-shared.json")!);
	assert.equal(sharedMetadata.prUrl, "https://github.com/org/repo/pull/200");
	assert.match(String(sharedMetadata.prStatus ?? ""), /existing/i);
	assert.ok((ctx.artifacts.get("/repo/.pi/worktrees/history.jsonl") ?? "").includes("worktree-pr"));
});

test("/worktree-pr rejects metadata path mismatches and only succeeds when cwd and branch match recorded managed metadata", async () => {
	const createPr = getCommand(worktreeExtension, "worktree-pr");
	const mismatchCtx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-z" });
	seedArtifact(mismatchCtx, ".pi/worktrees/feature-z.json", {
		slug: "feature-z",
		branch: "worktree/feature-z",
		worktreePath: "/parallel/.worktrees/repo/other-path",
	});
	mismatchCtx.exec = async (command: string, options?: Record<string, unknown>) => {
		mismatchCtx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-z\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(createPr(mismatchCtx)), /metadata mismatch|unmanaged/i);
	assert.ok(historyEntries(mismatchCtx).some((entry) => entry.type === "worktree-pr-failed" && /mismatch|unmanaged/i.test(String(entry.reason))));
});

test("If generated text is empty, /worktree-pr falls back to deterministic commit and PR text and still completes", async () => {
	const createPr = getCommand(worktreeExtension, "worktree-pr");
	const ctx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-j" });
	seedArtifact(ctx, ".pi/worktrees/feature-j.json", {
		slug: "feature-j",
		branch: "worktree/feature-j",
		repoRoot: "/repo",
		mainCheckoutPath: "/repo",
		worktreePath: "/parallel/.worktrees/repo/feature-j",
	});
	ctx.pi.ask = async (prompt: string) => {
		ctx.promptCalls.push({ prompt });
		return "\n\n   \n\n";
	};
	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		assert.equal(options?.cwd, "/parallel/.worktrees/repo/feature-j");
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-j\n", stderr: "", code: 0 };
		if (command === "gh auth status") return { stdout: "Logged in to github.com\n", stderr: "", code: 0 };
		if (command === "git status --short") return { stdout: "M src/file.ts\n", stderr: "", code: 0 };
		if (command === "git diff --stat") return { stdout: " src/file.ts | 1 +\n", stderr: "", code: 0 };
		if (command.startsWith("git diff -- ")) return { stdout: "diff\n", stderr: "", code: 0 };
		if (command.startsWith("gh pr view ")) return { stdout: "", stderr: "not found", code: 1 };
		if (command.startsWith("git add ")) return { stdout: "", stderr: "", code: 0 };
		if (command.startsWith("git commit -m ")) return { stdout: "[worktree/feature-j abc123] fallback\n", stderr: "", code: 0 };
		if (command === "git push -u origin worktree/feature-j") return { stdout: "", stderr: "", code: 0 };
		if (command.startsWith("gh pr create ")) return { stdout: "https://github.com/org/repo/pull/124\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await createPr(ctx);

	const commitCall = ctx.execCalls.find((call) => call.command.startsWith("git commit -m "));
	assert.match(commitCall?.command ?? "", /worktree\(feature-j\): update/i);
	const prCreateCall = ctx.execCalls.find((call) => call.command.startsWith("gh pr create "));
	assert.match(prCreateCall?.command ?? "", /worktree\/feature-j: update/i);
});

test("Missing gh or unauthenticated gh causes /worktree-pr to fail before push/PR creation and records failure details in metadata/history", async () => {
	const createPr = getCommand(worktreeExtension, "worktree-pr");

	const missingGh = createCtx({ cwd: "/parallel/.worktrees/repo/feature-h" });
	seedArtifact(missingGh, ".pi/worktrees/feature-h.json", { slug: "feature-h", branch: "worktree/feature-h", worktreePath: "/parallel/.worktrees/repo/feature-h" });
	missingGh.exec = async (command: string, options?: Record<string, unknown>) => {
		missingGh.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-h\n", stderr: "", code: 0 };
		if (command === "gh auth status") throw new Error("gh: command not found");
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(createPr(missingGh)), /gh|command not found/i);
	assert.ok(!missingGh.execCalls.some((call) => call.command.startsWith("git push ")));
	const missingGhMetadata = parseJson<Record<string, unknown>>(missingGh.artifacts.get(".pi/worktrees/feature-h.json")!);
	assert.match(String((missingGhMetadata.lastFailure as Record<string, unknown>)?.reason ?? ""), /gh|command not found/i);
	assert.ok(historyEntries(missingGh).some((entry) => entry.type === "worktree-pr-failed" && /gh|command not found/i.test(String(entry.reason))));

	const unauthenticatedGh = createCtx({ cwd: "/parallel/.worktrees/repo/feature-i" });
	seedArtifact(unauthenticatedGh, ".pi/worktrees/feature-i.json", { slug: "feature-i", branch: "worktree/feature-i", worktreePath: "/parallel/.worktrees/repo/feature-i" });
	unauthenticatedGh.exec = async (command: string, options?: Record<string, unknown>) => {
		unauthenticatedGh.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-i\n", stderr: "", code: 0 };
		if (command === "gh auth status") return { stdout: "", stderr: "You are not logged into any GitHub hosts", code: 1 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(createPr(unauthenticatedGh)), /auth|authenticated|logged/i);
	assert.ok(historyEntries(unauthenticatedGh).some((entry) => entry.type === "worktree-pr-failed" && /logged/i.test(String(entry.reason))));
});

test("Existing PR already open for branch causes /worktree-pr to surface the existing PR URL instead of creating a duplicate", async () => {
	const createPr = getCommand(worktreeExtension, "worktree-pr");
	const ctx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-k" });
	seedArtifact(ctx, ".pi/worktrees/feature-k.json", { slug: "feature-k", branch: "worktree/feature-k", worktreePath: "/parallel/.worktrees/repo/feature-k" });
	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-k\n", stderr: "", code: 0 };
		if (command === "gh auth status") return { stdout: "Logged in to github.com\n", stderr: "", code: 0 };
		if (command === "git status --short") return { stdout: "", stderr: "", code: 0 };
		if (command === "git push -u origin worktree/feature-k") return { stdout: "", stderr: "", code: 0 };
		if (command.startsWith("gh pr view ")) return { stdout: "https://github.com/org/repo/pull/126\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await createPr(ctx);
	assert.ok(!ctx.execCalls.some((call) => call.command.startsWith("gh pr create ")));
	const metadata = parseJson<Record<string, unknown>>(ctx.artifacts.get(".pi/worktrees/feature-k.json")!);
	assert.equal(metadata.prUrl, "https://github.com/org/repo/pull/126");
	assert.match(String(metadata.prStatus ?? ""), /existing/i);
});

test("/worktree-cleanup reads shared metadata from the main checkout when the worktree has no local .pi metadata copy", async () => {
	const cleanupWorktree = getCommand(worktreeExtension, "worktree-cleanup");
	const ctx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-clean-shared" });
	seedArtifact(ctx, "/repo/.pi/worktrees/feature-clean-shared.json", {
		slug: "feature-clean-shared",
		branch: "worktree/feature-clean-shared",
		repoRoot: "/repo",
		mainCheckoutPath: "/repo",
		worktreePath: "/parallel/.worktrees/repo/feature-clean-shared",
		createdAt: "2025-01-01T00:00:00.000Z",
	});
	let removed = false;
	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (options?.cwd === "/parallel/.worktrees/repo/feature-clean-shared") {
			if (removed) throw new Error(`cwd missing after removal: ${command}`);
			if (command === "git rev-parse --show-toplevel") return { stdout: "/parallel/.worktrees/repo/feature-clean-shared\n", stderr: "", code: 0 };
			if (command === "git branch --show-current") return { stdout: "worktree/feature-clean-shared\n", stderr: "", code: 0 };
			if (command === "git rev-parse --git-common-dir") return { stdout: "/repo/.git\n", stderr: "", code: 0 };
			if (command === "git status --short") return { stdout: "", stderr: "", code: 0 };
			if (command === "git status -sb") return { stdout: "## worktree/feature-clean-shared...origin/worktree/feature-clean-shared\n", stderr: "", code: 0 };
			if (command.startsWith("git worktree remove ")) {
				removed = true;
				return { stdout: "", stderr: "", code: 0 };
			}
		}
		if (command === "pi" && options?.cwd === "/repo") return { stdout: "", stderr: "return handoff unavailable", code: 1 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await cleanupWorktree(ctx);

	const sharedMetadata = parseJson<Record<string, unknown>>(ctx.artifacts.get("/repo/.pi/worktrees/feature-clean-shared.json")!);
	assert.match(String(sharedMetadata.cleanupResult ?? ""), /removed/i);
	assert.ok((ctx.artifacts.get("/repo/.pi/worktrees/history.jsonl") ?? "").includes("worktree-cleanup"));
});

test("/worktree-cleanup rejects dirty/unpushed or unmanaged checkouts and records auditable failure reasons", async () => {
	const cleanupWorktree = getCommand(worktreeExtension, "worktree-cleanup");

	const dirtyCtx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-m" });
	seedArtifact(dirtyCtx, ".pi/worktrees/feature-m.json", { slug: "feature-m", branch: "worktree/feature-m", repoRoot: "/repo", mainCheckoutPath: "/repo", worktreePath: "/parallel/.worktrees/repo/feature-m" });
	dirtyCtx.exec = async (command: string, options?: Record<string, unknown>) => {
		dirtyCtx.execCalls.push({ command, options });
		assert.equal(options?.cwd, "/parallel/.worktrees/repo/feature-m");
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-m\n", stderr: "", code: 0 };
		if (command === "git status --short") return { stdout: " M src/file.ts\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(cleanupWorktree(dirtyCtx)), /dirty|uncommitted/i);
	assert.ok(historyEntries(dirtyCtx).some((entry) => entry.type === "worktree-cleanup-failed" && /dirty|uncommitted/i.test(String(entry.reason))));

	const mismatchCtx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-n" });
	seedArtifact(mismatchCtx, ".pi/worktrees/feature-n.json", { slug: "feature-n", branch: "worktree/feature-n", worktreePath: "/parallel/.worktrees/repo/other" });
	mismatchCtx.exec = async (command: string, options?: Record<string, unknown>) => {
		mismatchCtx.execCalls.push({ command, options });
		if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
		if (command === "git branch --show-current") return { stdout: "worktree/feature-n\n", stderr: "", code: 0 };
		throw new Error(`Unexpected exec: ${command}`);
	};
	await assert.rejects(() => Promise.resolve(cleanupWorktree(mismatchCtx)), /mismatch|unmanaged/i);
	assert.ok(historyEntries(mismatchCtx).some((entry) => entry.type === "worktree-cleanup-failed" && /mismatch|unmanaged/i.test(String(entry.reason))));
});

test("/worktree-cleanup removes only safe managed worktrees, persists cleanup metadata/history, and provides fallback return instructions when automatic return fails", async () => {
	const cleanupWorktree = getCommand(worktreeExtension, "worktree-cleanup");
	const ctx = createCtx({ cwd: "/parallel/.worktrees/repo/feature-o" });
	seedArtifact(ctx, ".pi/worktrees/feature-o.json", {
		slug: "feature-o",
		branch: "worktree/feature-o",
		repoRoot: "/repo",
		mainCheckoutPath: "/repo",
		worktreePath: "/parallel/.worktrees/repo/feature-o",
		createdAt: "2025-01-01T00:00:00.000Z",
	});
	ctx.exec = async (command: string, options?: Record<string, unknown>) => {
		ctx.execCalls.push({ command, options });
		if (options?.cwd === "/parallel/.worktrees/repo/feature-o") {
			if (command === "git rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "", code: 0 };
			if (command === "git branch --show-current") return { stdout: "worktree/feature-o\n", stderr: "", code: 0 };
			if (command === "git status --short") return { stdout: "", stderr: "", code: 0 };
			if (command === "git status -sb") return { stdout: "## worktree/feature-o...origin/worktree/feature-o\n", stderr: "", code: 0 };
			if (command.startsWith("git worktree remove ")) return { stdout: "", stderr: "", code: 0 };
		}
		if (command === "pi" && options?.cwd === "/repo") return { stdout: "", stderr: "return handoff unavailable", code: 1 };
		throw new Error(`Unexpected exec: ${command}`);
	};

	await cleanupWorktree(ctx);

	const metadata = parseJson<Record<string, unknown>>(ctx.artifacts.get(".pi/worktrees/feature-o.json")!);
	assert.equal(metadata.cleanupResult, "removed");
	assert.equal(metadata.returnTarget, "/repo");
	assert.ok(historyEntries(ctx).some((entry) => entry.type === "worktree-cleanup" && entry.cleanupResult === "removed"));
	assert.match(ctx.notices.map((notice) => notice.message).join("\n"), /cd "\/repo" && pi|main checkout/i);
});
