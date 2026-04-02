type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };

type Ctx = {
	cwd: string;
	ui: {
		notify: (message: string, level?: string) => void;
		confirm: (title: string, message?: string) => Promise<boolean>;
		select: (prompt: string, choices: string[]) => Promise<string>;
		input: (prompt: string) => Promise<string>;
	};
};

type PiApi = {
	registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }) => void;
	exec: (command: string, args?: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
};

const MAX_DIFF_LENGTH = 3000;

let _pi: PiApi;

function exec(command: string): Promise<ExecResult> {
	// Split command into program and args for pi.exec
	// For simplicity with shell commands, use sh -c
	return _pi.exec("sh", ["-c", command]);
}

function notify(ctx: Ctx, message: string) {
	ctx.ui.notify(message, "info");
}

function warnMsg(ctx: Ctx, message: string) {
	ctx.ui.notify(message, "warning");
}

function errorMsg(ctx: Ctx, message: string) {
	ctx.ui.notify(message, "error");
}

function shQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function trimOutput(output: string, maxLen = MAX_DIFF_LENGTH): string {
	if (output.length <= maxLen) return output;
	return output.slice(0, maxLen) + "\n... (truncated)";
}

async function isDirty(ctx: Ctx): Promise<boolean> {
	const result = await exec("git status --porcelain");
	return result.stdout.trim().length > 0;
}

async function handleDirtyTree(ctx: Ctx): Promise<boolean> {
	const dirty = await isDirty(ctx);
	if (!dirty) return false;
	const confirmed = await ctx.ui.confirm("Working tree has uncommitted changes. Stash them?");
	if (!confirmed) return false;
	await exec("git stash push");
	return true;
}

async function unstash(ctx: Ctx): Promise<boolean> {
	const result = await exec("git stash pop");
	if (result.code !== 0) {
		errorMsg(ctx, `Stash pop failed (possible conflict): ${result.stderr}. Your stash is still intact.`);
		return false;
	}
	notify(ctx, "Restored stashed changes.");
	return true;
}

async function ensureGhAuthenticated(ctx: Ctx): Promise<boolean> {
	const result = await exec("gh auth status");
	if (result.code !== 0) {
		errorMsg(ctx, "GitHub CLI is not authenticated. Run 'gh auth login' first.");
		return false;
	}
	return true;
}

async function getCurrentBranch(ctx: Ctx): Promise<string> {
	const result = await exec("git rev-parse --abbrev-ref HEAD");
	return result.stdout.trim();
}

async function getConfiguredRemoteForBranch(branch: string): Promise<string | undefined> {
	const result = await exec(`git config --get ${shQuote(`branch.${branch}.remote`)}`);
	const remote = result.stdout.trim();
	if (result.code === 0 && remote) return remote;
	return undefined;
}

async function getRemotes(): Promise<string[]> {
	const result = await exec("git remote");
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
}

async function getConfiguredPushDefaultRemote(): Promise<string | undefined> {
	const result = await exec(`git config --get ${shQuote("remote.pushDefault")}`);
	const remote = result.stdout.trim();
	if (result.code === 0 && remote) return remote;
	return undefined;
}

async function resolveRemote(...branches: Array<string | undefined>): Promise<string | undefined> {
	for (const branch of branches) {
		if (!branch) continue;
		const remote = await getConfiguredRemoteForBranch(branch);
		if (remote) return remote;
	}

	const remotes = await getRemotes();
	if (remotes.length === 1) return remotes[0];
	return undefined;
}

async function resolvePushRemote(ctx: Ctx, branch: string): Promise<string | undefined> {
	const configuredRemote = await getConfiguredRemoteForBranch(branch);
	if (configuredRemote) return configuredRemote;

	const pushDefaultRemote = await getConfiguredPushDefaultRemote();
	if (pushDefaultRemote) return pushDefaultRemote;

	const remotes = await getRemotes();
	if (remotes.length === 1) return remotes[0];
	if (remotes.includes("origin")) return "origin";
	if (remotes.length > 1) {
		return await ctx.ui.select(`Select remote to push '${branch}' to:`, remotes);
	}
	return undefined;
}

type CheckoutChoice = {
	label: string;
	checkoutTarget: string;
	shortName: string;
	isRemote: boolean;
	canTrack: boolean;
};

function buildCheckoutChoices(rawBranches: string[]): CheckoutChoice[] {
	const localBranches = new Set(rawBranches.filter((branch) => branch && !branch.startsWith("remotes/")));
	const seen = new Set<string>();
	const choices: CheckoutChoice[] = [];

	for (const rawBranch of rawBranches) {
		if (rawBranch.startsWith("remotes/")) {
			const match = rawBranch.match(/^remotes\/([^/]+)\/(.+)$/);
			if (!match) continue;

			const [, remote, shortName] = match;
			const label = `${remote}/${shortName}`;
			if (seen.has(label)) continue;
			seen.add(label);
			choices.push({
				label,
				checkoutTarget: `${remote}/${shortName}`,
				shortName,
				isRemote: true,
				canTrack: !localBranches.has(shortName),
			});
			continue;
		}

		if (seen.has(rawBranch)) continue;
		seen.add(rawBranch);
		choices.push({
			label: rawBranch,
			checkoutTarget: rawBranch,
			shortName: rawBranch,
			isRemote: false,
			canTrack: false,
		});
	}

	return choices;
}

// --- Command handlers ---

async function gitStatus(ctx: Ctx) {
	const result = await exec("git status --short");
	const output = result.stdout.trim() || "Nothing to report";
	notify(ctx, output);
}

async function gitDiff(ctx: Ctx, filePath?: string) {
	const pathArg = filePath ? ` -- ${shQuote(String(filePath))}` : "";
	const result = await exec(`git diff${pathArg}`);
	const stagedResult = await exec(`git diff --staged${pathArg}`);
	const combined = [result.stdout, stagedResult.stdout].filter(Boolean).join("\n");
	const output = combined.trim() || "No diff output";
	notify(ctx, trimOutput(output));
}

async function gitCheckout(ctx: Ctx, branchArg?: string) {
	const branch = branchArg ? String(branchArg) : undefined;

	let targetBranch: string;
	let trackRemoteBranch = false;

	if (!branch) {
		// Interactive branch picker
		const branchResult = await exec("git branch -a");
		const rawBranches = branchResult.stdout
			.split("\n")
			.map((b) => b.replace(/^\*?\s+/, "").trim())
			.filter((b) => Boolean(b) && !b.includes(" -> "));

		const choices = buildCheckoutChoices(rawBranches);
		const selectedLabel = await ctx.ui.select("Select branch to checkout:", choices.map((choice) => choice.label));
		const selectedChoice = choices.find((choice) => choice.label === selectedLabel) ?? choices[0];
		if (!selectedChoice) {
			warnMsg(ctx, "No branches available to checkout.");
			return;
		}

		targetBranch = selectedChoice.checkoutTarget;
		trackRemoteBranch = selectedChoice.isRemote && selectedChoice.canTrack;
	} else {
		targetBranch = branch;
	}

	const stashed = await handleDirtyTree(ctx);
	const checkoutCommand = trackRemoteBranch
		? `git checkout --track ${shQuote(targetBranch)}`
		: `git checkout ${shQuote(targetBranch)}`;
	const result = await exec(checkoutCommand);
	if (result.code !== 0) {
		errorMsg(ctx, `Checkout failed: ${result.stderr}`);
		if (stashed) await unstash(ctx);
		return;
	}

	notify(ctx, result.stdout.trim() || `Switched to branch '${targetBranch}'`);

	if (stashed) {
		await unstash(ctx);
	}
}

async function gitCreateBranch(ctx: Ctx, slug?: string) {
	const branchName = slug ? String(slug) : undefined;
	if (!branchName) {
		warnMsg(ctx, "Usage: /git-create-branch <branch-name>");
		return;
	}

	const result = await exec(`git checkout -b ${shQuote(branchName)}`);
	if (result.code !== 0) {
		errorMsg(ctx, `Failed to create branch: ${result.stderr}`);
		return;
	}
	notify(ctx, result.stdout.trim() || `Created and switched to branch '${branchName}'`);
}

async function gitRemoteMain(ctx: Ctx) {
	const stashed = await handleDirtyTree(ctx);

	const currentBranch = await getCurrentBranch(ctx);

	if (currentBranch !== "main") {
		const result = await exec("git checkout main");
		if (result.code !== 0) {
			errorMsg(ctx, `Failed to checkout main: ${result.stderr}`);
			if (stashed) await unstash(ctx);
			return;
		}
	}

	const remote = await resolveRemote("main", currentBranch);
	if (!remote) {
		errorMsg(ctx, "Failed to determine which remote should be used for main. Configure branch.main.remote or ensure the repo has exactly one remote.");
		if (stashed) await unstash(ctx);
		return;
	}

	const pullResult = await exec(`git pull ${shQuote(remote)} main`);
	if (pullResult.code !== 0) {
		errorMsg(ctx, `Failed to pull: ${pullResult.stderr}`);
	} else {
		notify(ctx, pullResult.stdout.trim() || `Pulled latest from ${remote}/main`);
	}

	if (stashed) {
		await unstash(ctx);
	}
}

async function gitCommit(ctx: Ctx, messageArg?: string) {
	// Check if there are changes
	const dirty = await isDirty(ctx);
	if (!dirty) {
		notify(ctx, "Nothing to commit — working tree is clean.");
		return;
	}

	let message = messageArg ? String(messageArg) : undefined;
	if (!message) {
		message = await ctx.ui.input("Enter commit message:");
	}

	await exec("git add -A");
	const result = await exec(`git commit -m ${shQuote(message)}`);
	if (result.code !== 0) {
		errorMsg(ctx, `Commit failed: ${result.stderr}`);
		return;
	}
	notify(ctx, result.stdout.trim() || `Committed: ${message}`);
}

async function gitPr(ctx: Ctx) {
	if (!(await ensureGhAuthenticated(ctx))) return;

	const branch = await getCurrentBranch(ctx);
	if (branch === "main") {
		warnMsg(ctx, "Cannot create a PR from main branch. Switch to a feature branch first.");
		return;
	}

	// Check for upstream, push with -u if needed
	const upstreamCheck = await exec("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
	let pushResult: ExecResult;
	if (upstreamCheck.code !== 0) {
		const remote = await resolvePushRemote(ctx, branch);
		if (!remote) {
			errorMsg(ctx, `Failed to determine which remote should receive branch '${branch}'. Configure branch.${branch}.remote, remote.pushDefault, or add a usable remote.`);
			return;
		}
		pushResult = await exec(`git push -u ${shQuote(remote)} ${shQuote(branch)}`);
	} else {
		pushResult = await exec("git push");
	}

	if (pushResult.code !== 0) {
		errorMsg(ctx, `Failed to push branch: ${pushResult.stderr}`);
		return;
	}

	// Check if PR already exists
	const prView = await exec("gh pr view");
	if (prView.code === 0) {
		// PR already exists
		const urlMatch = prView.stdout.match(/url:\s*(\S+)/);
		const url = urlMatch ? urlMatch[1] : "unknown";
		notify(ctx, `PR already exists: ${url}`);
		return;
	}

	// Create new PR
	const createResult = await exec(`gh pr create --base main --head ${shQuote(branch)} --fill`);
	if (createResult.code !== 0) {
		errorMsg(ctx, `Failed to create PR: ${createResult.stderr}`);
		return;
	}
	notify(ctx, createResult.stdout.trim() || "PR created successfully");
}

async function gitPrUpdate(ctx: Ctx) {
	if (!(await ensureGhAuthenticated(ctx))) return;

	const branch = await getCurrentBranch(ctx);
	await exec("git push");

	const prView = await exec("gh pr view");
	if (prView.code !== 0) {
		warnMsg(ctx, "No existing PR found for this branch. Use /git-pr to create one.");
		return;
	}

	const urlMatch = prView.stdout.match(/url:\s*(\S+)/);
	const url = urlMatch ? urlMatch[1] : "unknown";
	notify(ctx, `Pushed and updated PR: ${url}`);
}

// --- Extension registration ---

export default function inlineGitExtension(pi: PiApi) {
	_pi = pi;

	const commands: Array<{ name: string; handler: (ctx: Ctx, args?: string) => Promise<void> }> = [
		{ name: "git-status", handler: gitStatus },
		{ name: "git-diff", handler: gitDiff },
		{ name: "git-checkout", handler: gitCheckout },
		{ name: "git-create-branch", handler: gitCreateBranch },
		{ name: "git-remote-main", handler: gitRemoteMain },
		{ name: "git-commit", handler: gitCommit },
		{ name: "git-pr", handler: gitPr },
		{ name: "git-pr-update", handler: gitPrUpdate },
	];

	for (const cmd of commands) {
		pi.registerCommand(cmd.name, {
			description: `Git command /${cmd.name}`,
			handler: async (args: string, ctx: Ctx) => {
				await cmd.handler(ctx, args?.trim());
			},
		});
	}
}
