import test from "node:test";
import assert from "node:assert/strict";

import prReviewCycleExtension, { __testables } from "../../extensions/pr-review-cycle.ts";

type ExecResult = { stdout: string; stderr: string; code: number };
type ExecCall = { command: string; args: string[]; cwd?: string };
type Notice = { level: string; message: string };
type StatusCall = { key: string; text: string | undefined };
type SentMessage = { message: Record<string, unknown>; options?: Record<string, unknown> };

type TestCtx = {
	cwd: string;
	hasUI: boolean;
	state: Record<string, unknown>;
	pi: any;
	sessionManager: {
		getEntries: () => any[];
		getBranch: () => any[];
	};
	ui: {
		notify: (message: string, level?: string) => void;
		setStatus: (key: string, text: string | undefined) => void;
	};
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	abort: () => void;
	shutdown: () => void;
	getContextUsage: () => undefined;
	compact: () => void;
	getSystemPrompt: () => string;
	modelRegistry: any;
	model: undefined;
};

function samplePullRequest() {
	return {
		number: 42,
		url: "https://github.com/acme/repo/pull/42",
		title: "Tighten validation",
		headRefName: "feature/pr-review-fix",
		reviews: [
			{
				author: { login: "coderabbitai[bot]" },
				body: "",
				comments: [
					{ author: { login: "coderabbitai[bot]" }, body: "Guard against undefined user input.", path: "src/user.ts", line: 12 },
					{ author: { login: "coderabbitai[bot]" }, body: "Guard against undefined user input.", path: "src/user.ts", line: 12 },
				],
			},
			{
				author: { login: "openai-codex[bot]" },
				body: "Simplify the error branch so retries do not duplicate logs.",
				comments: [],
			},
			{
				author: { login: "teammate" },
				body: "human feedback should be ignored",
				comments: [{ author: { login: "teammate" }, body: "Nit", path: "README.md", line: 2 }],
			},
		],
		comments: [
			{ author: { login: "openai-codex[bot]" }, body: "Avoid duplicate fetch calls in retry mode.", path: "src/api.ts", line: 8 },
			{ author: { login: "alice" }, body: "human comment", path: "src/other.ts", line: 3 },
		],
	};
}

function makeHarness() {
	const commands = new Map<string, { handler: (args: string, ctx: TestCtx) => Promise<void> }>();
	const events = new Map<string, (event: any, ctx: TestCtx) => Promise<void>>();
	const entries: any[] = [];
	const execCalls: ExecCall[] = [];
	const notices: Notice[] = [];
	const statusCalls: StatusCall[] = [];
	const sentUserMessages: string[] = [];
	const sentMessages: SentMessage[] = [];
	const execResponses = new Map<string, ExecResult>();
	const execErrors = new Map<string, Error>();
	let idle = true;

	const pi = {
		registerCommand(name: string, config: { handler: (args: string, ctx: TestCtx) => Promise<void> }) {
			commands.set(name, config);
		},
		on(eventName: string, handler: (event: any, ctx: TestCtx) => Promise<void>) {
			events.set(eventName, handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendUserMessage(content: string) {
			sentUserMessages.push(content);
		},
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			sentMessages.push({ message, options });
		},
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			const key = [command, ...args].join(" ");
			execCalls.push({ command, args, cwd: options?.cwd });
			const error = execErrors.get(key);
			if (error) throw error;
			return execResponses.get(key) ?? { stdout: "", stderr: "", code: 0 };
		},
	};

	const ctx: TestCtx = {
		cwd: "/repo",
		hasUI: true,
		state: {},
		pi,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: {
			notify(message: string, level = "info") {
				notices.push({ level, message });
			},
			setStatus(key: string, text: string | undefined) {
				statusCalls.push({ key, text });
			},
		},
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort() {},
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
		modelRegistry: {},
		model: undefined,
	};

	prReviewCycleExtension(pi as any);

	return {
		ctx,
		commands,
		events,
		entries,
		execCalls,
		notices,
		statusCalls,
		sentUserMessages,
		sentMessages,
		execResponses,
		execErrors,
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

function ok(stdout = ""): ExecResult {
	return { stdout, stderr: "", code: 0 };
}

function fail(stderr: string, code = 1): ExecResult {
	return { stdout: "", stderr, code };
}

function seedHappyPath(harness: ReturnType<typeof makeHarness>, pr = samplePullRequest()) {
	harness.execResponses.set("git rev-parse --show-toplevel", ok("/repo\n"));
	harness.execResponses.set("gh --version", ok("gh version 2.x\n"));
	harness.execResponses.set("gh auth status", ok("Logged in to github.com\n"));
	harness.execResponses.set("git branch --show-current", ok(`${pr.headRefName}\n`));
	harness.execResponses.set("git status --porcelain", ok(""));
	harness.execResponses.set(`git config --get branch.${pr.headRefName}.remote`, ok("origin\n"));
	harness.execResponses.set(`gh pr view --json ${__testables.PR_REVIEW_JSON_FIELDS.join(",")}`, ok(`${JSON.stringify(pr)}\n`));
}

test("pr-review-cycle registers the expected command surface", () => {
	const harness = makeHarness();
	assert.deepEqual([...harness.commands.keys()].sort(), ["pr-review-clear", "pr-review-fix", "pr-review-status"]);
	assert.ok(harness.events.has("agent_end"));
});

test("collectBotFindingsFromPullRequest collects CodeRabbit and Codex feedback, ignores humans, dedupes duplicates, and tolerates empty review bodies", () => {
	const findings = __testables.collectBotFindingsFromPullRequest(samplePullRequest());
	assert.equal(findings.length, 3);
	assert.ok(findings.some((finding) => finding.reviewerKind === "coderabbit" && finding.path === "src/user.ts" && finding.line === 12));
	assert.ok(findings.some((finding) => finding.reviewerKind === "codex" && /retry mode/i.test(finding.text)));
	assert.ok(findings.some((finding) => finding.reviewerKind === "codex" && /simplify the error branch/i.test(finding.text)));
	assert.ok(findings.every((finding) => finding.reviewerKind === "coderabbit" || finding.reviewerKind === "codex"));
});

test("/pr-review-fix fails clearly outside a git repo", async () => {
	const harness = makeHarness();
	harness.execResponses.set("git rev-parse --show-toplevel", fail("not a git repository"));

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.ok(harness.notices.some((notice) => notice.level === "error" && /git repository/i.test(notice.message)));
	assert.equal(harness.sentUserMessages.length, 0);
});

test("/pr-review-fix fails clearly when gh is missing", async () => {
	const harness = makeHarness();
	harness.execResponses.set("git rev-parse --show-toplevel", ok("/repo\n"));
	harness.execErrors.set("gh --version", new Error("spawn gh ENOENT"));

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.ok(harness.notices.some((notice) => /GitHub CLI `gh` is required/i.test(notice.message)));
	assert.equal(harness.sentUserMessages.length, 0);
});

test("/pr-review-fix fails clearly when gh is unauthenticated", async () => {
	const harness = makeHarness();
	harness.execResponses.set("git rev-parse --show-toplevel", ok("/repo\n"));
	harness.execResponses.set("gh --version", ok("gh version 2.x\n"));
	harness.execResponses.set("gh auth status", fail("You are not logged into any GitHub hosts"));

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.ok(harness.notices.some((notice) => /authentication failed/i.test(notice.message)));
	assert.equal(harness.sentUserMessages.length, 0);
});

test("/pr-review-fix fails clearly when the current branch has no open PR", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	harness.execResponses.set(`gh pr view --json ${__testables.PR_REVIEW_JSON_FIELDS.join(",")}`, fail("no pull requests found for branch feature/pr-review-fix"));

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.ok(harness.notices.some((notice) => /no open PR|unable to load current PR review data/i.test(notice.message)));
	assert.equal(harness.sentUserMessages.length, 0);
});

test("/pr-review-fix refuses to start when the working tree is already dirty", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	harness.execResponses.set("git status --porcelain", ok(" M README.md\n?? scratch.txt\n"));

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.equal(harness.sentUserMessages.length, 0);
	assert.equal(__testables.getState(harness.ctx), undefined);
	assert.ok(harness.notices.some((notice) => /clean git working tree/i.test(notice.message)));
	assert.ok(!harness.execCalls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "view"));
});

test("/pr-review-fix does not start a run when no actionable findings remain", async () => {
	const harness = makeHarness();
	const pr = {
		...samplePullRequest(),
		reviews: [{ author: { login: "coderabbitai[bot]" }, body: "" }],
		comments: [{ author: { login: "openai-codex[bot]" }, body: "LGTM", path: "src/a.ts", line: 1 }],
	};
	seedHappyPath(harness, pr);

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.equal(harness.sentUserMessages.length, 0);
	assert.equal(__testables.getState(harness.ctx), undefined);
	assert.ok(harness.notices.some((notice) => /no actionable .* findings remain/i.test(notice.message)));
});

test("/pr-review-fix injects a normalized repair prompt, persists active state, and instructs the agent to fix all actionable findings", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.equal(harness.sentUserMessages.length, 1);
	const prompt = harness.sentUserMessages[0]!;
	assert.match(prompt, /Determine which findings below are still actionable/i);
	assert.match(prompt, /Fix all actionable findings in this repository/i);
	assert.match(prompt, /Ignore findings that are outdated, incorrect, already satisfied, or out of scope/i);
	assert.match(prompt, /Do not commit or push manually; the extension will do that/i);
	assert.ok(prompt.includes("CodeRabbit"));
	assert.ok(prompt.includes("Codex"));
	const state = __testables.getState(harness.ctx)!;
	assert.equal(state.active, true);
	assert.equal(state.phase, "awaiting-agent");
	assert.equal(state.pr.number, 42);
	assert.equal(state.localBranch, "feature/pr-review-fix");
	assert.equal(state.pushRemote, "origin");
	assert.equal(state.commitMessage, "pr-review: address AI review feedback for #42");
	assert.ok(harness.statusCalls.some((call) => call.key === "pr-review-cycle" && typeof call.text === "string" && /awaiting-agent/.test(call.text)));
});

test("/pr-review-fix persists active state before handing the repair brief to pi", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	let stateAtHandoff: ReturnType<typeof __testables.getState>;

	harness.ctx.pi.sendUserMessage = (content: string) => {
		stateAtHandoff = __testables.getState(harness.ctx);
		harness.sentUserMessages.push(content);
	};

	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	assert.equal(harness.sentUserMessages.length, 1);
	assert.equal(stateAtHandoff?.active, true);
	assert.equal(stateAtHandoff?.phase, "awaiting-agent");
	assert.equal(stateAtHandoff?.findingsGathered, 3);
	assert.equal(stateAtHandoff?.findingsSelected, 3);
});

test("agent_end with a dirty tree stages, commits, and pushes only for an active pr-review-fix run", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);
	assert.equal(__testables.getState(harness.ctx)?.active, true);

	harness.execResponses.set("git status --porcelain", ok(" M src/user.ts\n"));
	harness.execResponses.set("git add -A", ok());
	harness.execResponses.set("git commit -m pr-review: address AI review feedback for #42", ok("[feature/pr-review-fix abc123] done\n"));
	harness.execResponses.set("git push origin HEAD:feature/pr-review-fix", ok("pushed\n"));

	await harness.events.get("agent_end")!({ type: "agent_end", messages: [] }, harness.ctx);

	assert.ok(harness.execCalls.some((call) => call.command === "git" && call.args.join(" ") === "add -A"));
	assert.ok(harness.execCalls.some((call) => call.command === "git" && call.args.join(" ") === "commit -m pr-review: address AI review feedback for #42"));
	assert.ok(harness.execCalls.some((call) => call.command === "git" && call.args.join(" ") === "push origin HEAD:feature/pr-review-fix"));
	assert.ok(!harness.execCalls.some((call) => call.command === "gh" && call.args.includes("merge")));
	const state = __testables.getState(harness.ctx)!;
	assert.equal(state.active, false);
	assert.equal(state.phase, "completed");
	assert.match(state.lastOutcome ?? "", /Committed and pushed/i);
	assert.equal(harness.statusCalls[harness.statusCalls.length - 1]?.text, undefined);
});

test("agent_end aborts/errors skip automatic commit and push", async () => {
	for (const stopReason of ["aborted", "error"] as const) {
		const harness = makeHarness();
		seedHappyPath(harness);
		await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);
		assert.equal(__testables.getState(harness.ctx)?.active, true);

		await harness.events.get("agent_end")!(
			{
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason, errorMessage: `${stopReason} run` }],
			},
			harness.ctx,
		);

		assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args[0] === "add"));
		assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args[0] === "commit"));
		assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args[0] === "push"));
		const state = __testables.getState(harness.ctx)!;
		assert.equal(state.active, false);
		assert.equal(state.phase, "failed");
		assert.match(state.lastOutcome ?? "", /skipped automatic commit\/push/i);
		assert.equal(state.lastError, `${stopReason} run`);
	}
});

test("agent_end with a clean tree does not commit or push and clears active state", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);
	assert.equal(__testables.getState(harness.ctx)?.active, true);

	harness.execResponses.set("git status --porcelain", ok(""));

	await harness.events.get("agent_end")!({ type: "agent_end", messages: [] }, harness.ctx);

	assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args[0] === "add"));
	assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args[0] === "commit"));
	assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args[0] === "push"));
	const state = __testables.getState(harness.ctx)!;
	assert.equal(state.active, false);
	assert.equal(state.phase, "completed");
	assert.match(state.lastOutcome ?? "", /nothing was committed or pushed/i);
});

test("agent_end ignores unrelated or inactive runs and never auto-commits outside /pr-review-fix", async () => {
	const harness = makeHarness();
	const initialExecCalls = harness.execCalls.length;

	await harness.events.get("agent_end")!({ type: "agent_end", messages: [] }, harness.ctx);
	assert.equal(harness.execCalls.length, initialExecCalls);

	await __testables.applyState(harness.ctx, {
		active: true,
		sourceCommand: "something-else",
		repoRoot: "/repo",
		localBranch: "feature/pr-review-fix",
		branch: "feature/pr-review-fix",
		pushRemote: "origin",
		pr: { number: 42, url: "https://github.com/acme/repo/pull/42", title: "Tighten validation", headRefName: "feature/pr-review-fix" },
		phase: "awaiting-agent",
		findingsGathered: 1,
		findingsSelected: 1,
		pushPolicy: "auto-commit-and-push",
		commitMessage: "pr-review: address AI review feedback for #42",
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	} as any);

	await harness.events.get("agent_end")!({ type: "agent_end", messages: [] }, harness.ctx);

	assert.equal(harness.execCalls.length, initialExecCalls);
	assert.ok(!harness.execCalls.some((call) => call.command === "git" && ["add", "commit", "push"].includes(call.args[0] ?? "")));
	assert.equal(__testables.getState(harness.ctx)?.sourceCommand, "something-else");
	assert.equal(__testables.getState(harness.ctx)?.active, true);
});

test("agent_end pushes to the tracked non-origin remote for the PR branch", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	harness.execResponses.set("git config --get branch.feature/pr-review-fix.remote", ok("fork\n"));
	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	harness.execResponses.set("git status --porcelain", ok(" M src/user.ts\n"));
	harness.execResponses.set("git add -A", ok());
	harness.execResponses.set("git commit -m pr-review: address AI review feedback for #42", ok("commit ok\n"));
	harness.execResponses.set("git push fork HEAD:feature/pr-review-fix", ok("pushed\n"));

	await harness.events.get("agent_end")!({ type: "agent_end", messages: [] }, harness.ctx);

	assert.ok(harness.execCalls.some((call) => call.command === "git" && call.args.join(" ") === "push fork HEAD:feature/pr-review-fix"));
	assert.ok(!harness.execCalls.some((call) => call.command === "git" && call.args.join(" ") === "push origin HEAD:feature/pr-review-fix"));
	const state = __testables.getState(harness.ctx)!;
	assert.equal(state.pushRemote, "fork");
	assert.equal(state.phase, "completed");
});

test("push failure preserves recovery details in persisted state", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	harness.execResponses.set("git status --porcelain", ok(" M src/user.ts\n"));
	harness.execResponses.set("git add -A", ok());
	harness.execResponses.set("git commit -m pr-review: address AI review feedback for #42", ok("commit ok\n"));
	harness.execResponses.set("git push origin HEAD:feature/pr-review-fix", fail("non-fast-forward push rejected"));

	await harness.events.get("agent_end")!({ type: "agent_end", messages: [] }, harness.ctx);

	const state = __testables.getState(harness.ctx)!;
	assert.equal(state.active, false);
	assert.equal(state.phase, "failed");
	assert.match(state.lastOutcome ?? "", /Automatic commit\/push failed/i);
	assert.match(state.lastError ?? "", /non-fast-forward/i);
});

test("/pr-review-status reports persisted state accurately and /pr-review-clear removes stale state without touching git", async () => {
	const harness = makeHarness();
	seedHappyPath(harness);
	await harness.commands.get("pr-review-fix")!.handler("", harness.ctx);

	await harness.commands.get("pr-review-status")!.handler("", harness.ctx);

	const statusMessage = harness.sentMessages[harness.sentMessages.length - 1]?.message?.content as string;
	assert.match(statusMessage, /PR review fix status/);
	assert.match(statusMessage, /active: yes/);
	assert.match(statusMessage, /PR: #42/);
	assert.match(statusMessage, /push remote: origin/);
	assert.match(statusMessage, /push policy: auto-commit-and-push/);

	const execCallsBeforeClear = harness.execCalls.length;
	await harness.commands.get("pr-review-clear")!.handler("", harness.ctx);
	assert.equal(__testables.getState(harness.ctx), undefined);
	assert.equal(harness.execCalls.length, execCallsBeforeClear, "clear must not modify git state");
	assert.equal(harness.statusCalls[harness.statusCalls.length - 1]?.text, undefined);
	assert.ok(harness.notices.some((notice) => /Cleared PR review fix state/i.test(notice.message)));
});
