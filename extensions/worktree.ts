import path from "node:path";
import { promises as fs, accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number } | undefined;
type UiContext = {
	notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
	custom?: <T>(renderer: (tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown) => Promise<T>;
};
type Ctx = {
	cwd: string;
	hasUI?: boolean;
	ui?: UiContext;
	state?: Record<string, unknown>;
	exec?: (command: string, options?: ExecOptions) => Promise<ExecResult>;
	spawnInteractive?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" }) => SpawnSyncReturns<Buffer>;
	persistArtifact?: (path: string, content: string, options?: { append?: boolean }) => Promise<void>;
	readArtifact?: (path: string) => Promise<string | undefined>;
	persistCalls?: Array<{ path: string; content: string; mode?: string }>;
	artifacts?: Map<string, string>;
	pi?: {
		notify?: (message: string) => void;
		warn?: (message: string) => void;
		error?: (message: string) => void;
		ask?: (prompt: string) => Promise<string>;
	};
};
type PiApi = {
	exec?: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
	registerCommand?: (name: string, config: { description?: string; handler: (args: string | undefined, ctx: Ctx) => Promise<unknown> | unknown }) => void;
};

let runtimePi: PiApi | undefined;

type WorktreeFailure = {
	command: "worktree-start" | "worktree-pr" | "worktree-cleanup";
	phase: string;
	reason: string;
	at: string;
};

type WorktreeMetadata = {
	slug: string;
	branch: string;
	repoRoot?: string;
	mainCheckoutPath?: string;
	worktreePath: string;
	createdAt?: string;
	handoff?: {
		attempted: boolean;
		ok: boolean;
		reason?: string;
		command?: string;
	};
	prUrl?: string;
	commitStatus?: string;
	pushStatus?: string;
	prStatus?: string;
	cleanupResult?: string;
	returnTarget?: string;
	cleanupAt?: string;
	lastFailure?: WorktreeFailure;
};

function info(ctx: Ctx, message: string) {
	ctx.ui?.notify?.(message, "info");
	ctx.pi?.notify?.(message);
}

function warn(ctx: Ctx, message: string) {
	ctx.ui?.notify?.(message, "warning");
	ctx.pi?.warn?.(message);
}

function fail(ctx: Ctx, message: string): never {
	ctx.ui?.notify?.(message, "error");
	ctx.pi?.error?.(message);
	throw new Error(message);
}

function trimOutput(value: string | undefined): string {
	return (value ?? "").trim();
}

async function run(ctx: Ctx, command: string, options?: ExecOptions): Promise<ExecResult> {
	if (ctx.exec) return await ctx.exec(command, options);
	if (!runtimePi?.exec) throw new Error("No shell execution API available. Expected pi.exec().");
	return await runtimePi.exec("bash", ["-lc", command], options);
}

async function runInCwd(ctx: Ctx, cwd: string, command: string): Promise<ExecResult> {
	return await run(ctx, command, { cwd });
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "worktree";
}

function getRepoSlug(repoRoot: string): string {
	return path.basename(repoRoot);
}

function getBranchName(slug: string): string {
	return `worktree/${slug}`;
}

function getMetadataPath(slug: string): string {
	return `.pi/worktrees/${slug}.json`;
}

function getHistoryPath(): string {
	return `.pi/worktrees/history.jsonl`;
}

function getWorktreePath(repoRoot: string, slug: string): string {
	return path.join("/parallel/.worktrees", getRepoSlug(repoRoot), slug);
}

async function readArtifact(ctx: Ctx, artifactPath: string): Promise<string | undefined> {
	if (ctx.artifacts?.has(artifactPath)) return ctx.artifacts.get(artifactPath);
	if (ctx.readArtifact) return await ctx.readArtifact(artifactPath);
	try {
		return await fs.readFile(artifactPath, "utf8");
	} catch {
		return undefined;
	}
}

async function readJsonArtifact<T>(ctx: Ctx, artifactPath: string): Promise<T | undefined> {
	const content = await readArtifact(ctx, artifactPath);
	if (!content) return undefined;
	try {
		return JSON.parse(content) as T;
	} catch {
		return undefined;
	}
}

async function readMetadata(ctx: Ctx, slug: string): Promise<WorktreeMetadata | undefined> {
	return await readJsonArtifact<WorktreeMetadata>(ctx, getMetadataPath(slug));
}

async function writeArtifact(ctx: Ctx, artifactPath: string, content: string, append = false): Promise<void> {
	if (ctx.artifacts) {
		const previous = ctx.artifacts.get(artifactPath) ?? "";
		ctx.artifacts.set(artifactPath, append ? `${previous}${content}` : content);
	}
	if (Array.isArray(ctx.persistCalls)) {
		if (append) {
			ctx.persistCalls.push({ path: artifactPath, content, mode: "append" });
		} else {
			const existingIndex = ctx.persistCalls.findIndex((entry) => entry.path === artifactPath && entry.mode !== "append");
			const nextEntry = { path: artifactPath, content, mode: "write" };
			if (existingIndex >= 0) ctx.persistCalls.splice(existingIndex, 1, nextEntry);
			else ctx.persistCalls.push(nextEntry);
		}
		return;
	}
	if (ctx.persistArtifact) {
		await ctx.persistArtifact(artifactPath, content, append ? { append: true } : undefined);
		return;
	}
	await fs.mkdir(path.dirname(artifactPath), { recursive: true });
	if (append) await fs.appendFile(artifactPath, content, "utf8");
	else await fs.writeFile(artifactPath, content, "utf8");
}

async function persistMetadata(ctx: Ctx, metadata: WorktreeMetadata): Promise<void> {
	await writeArtifact(ctx, getMetadataPath(metadata.slug), `${JSON.stringify(metadata, null, 2)}\n`, false);
}

async function appendHistory(ctx: Ctx, event: Record<string, unknown>): Promise<void> {
	await writeArtifact(ctx, getHistoryPath(), `${JSON.stringify(event)}\n`, true);
}

async function recordFailure(
	ctx: Ctx,
	failure: Omit<WorktreeFailure, "at">,
	metadata?: WorktreeMetadata,
	extra?: Record<string, unknown>,
): Promise<void> {
	const at = new Date().toISOString();
	const persistedFailure: WorktreeFailure = { ...failure, at };
	if (metadata) {
		await persistMetadata(ctx, {
			...metadata,
			lastFailure: persistedFailure,
		});
	}
	await appendHistory(ctx, {
		type: `${failure.command}-failed`,
		command: failure.command,
		phase: failure.phase,
		reason: failure.reason,
		at,
		...extra,
		...(metadata
			? {
				slug: metadata.slug,
				branch: metadata.branch,
				worktreePath: metadata.worktreePath,
			}
			: {}),
	});
}

async function detectRepoRoot(ctx: Ctx, cwd?: string): Promise<string> {
	try {
		const result = await run(ctx, "git rev-parse --show-toplevel", cwd ? { cwd } : undefined);
		const repoRoot = trimOutput(result.stdout);
		if (!repoRoot) fail(ctx, "fatal: not a git repository");
		return repoRoot;
	} catch (error) {
		fail(ctx, (error as Error).message || "fatal: not a git repository");
	}
}

async function ensureMainCheckout(ctx: Ctx, repoRoot: string): Promise<void> {
	const branch = trimOutput((await run(ctx, "git branch --show-current", { cwd: repoRoot })).stdout);
	if (branch !== "main") fail(ctx, `worktree-start must be run from main. Current branch: ${branch || "(unknown)"}`);
	const origin = await run(ctx, "git remote get-url origin", { cwd: repoRoot });
	if (origin.code !== 0 || !trimOutput(origin.stdout)) {
		fail(ctx, trimOutput(origin.stderr) || "Missing origin remote");
	}
}

async function ensureBranchDoesNotExist(ctx: Ctx, branch: string, cwd?: string): Promise<void> {
	const result = await run(ctx, `git show-ref --verify --quiet refs/heads/${branch}`, cwd ? { cwd } : undefined);
	if (result.code === 0) fail(ctx, `Managed branch already exists: ${branch}`);
}

function porcelainWorktreeExistsAt(stdout: string, targetPath: string): boolean {
	return stdout.split(/\r?\n/).some((line) => line.trim() === `worktree ${targetPath}`);
}

async function ensureTargetPathAvailable(ctx: Ctx, worktreePath: string, cwd?: string): Promise<void> {
	const result = await run(ctx, "git worktree list --porcelain", cwd ? { cwd } : undefined);
	if (porcelainWorktreeExistsAt(result.stdout, worktreePath)) {
		fail(ctx, `Target worktree path already exists and appears unmanaged: ${worktreePath}`);
	}
}

function buildFallbackPiCommand(worktreePath: string): string {
	return `cd ${JSON.stringify(worktreePath)} && pi`;
}

function isExecutableFile(filePath: string): boolean {
	try {
		accessSync(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
	const pathValue = env.PATH ?? process.env.PATH ?? "";
	for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(segment, command);
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function findReadablePath(candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		try {
			accessSync(candidate, fsConstants.R_OK);
			return candidate;
		} catch {
			// keep searching
		}
	}
	return undefined;
}

function findPackageJsonPath(packageName: string): string | undefined {
	const require = createRequire(import.meta.url);
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const searchRoots = [
		...new Set([process.cwd(), moduleDir, ...(require.resolve.paths(packageName) ?? [])]),
	];
	for (const root of searchRoots) {
		let current = root;
		while (current && current !== path.dirname(current)) {
			const candidate = findReadablePath([
				path.join(current, packageName, "package.json"),
				path.join(current, "node_modules", packageName, "package.json"),
			]);
			if (candidate) return candidate;
			current = path.dirname(current);
		}
		const rootCandidate = findReadablePath([
			path.join(current, packageName, "package.json"),
			path.join(current, "node_modules", packageName, "package.json"),
		]);
		if (rootCandidate) return rootCandidate;
	}
	return undefined;
}

function resolvePiCliScript(): string | undefined {
	try {
		const packageJsonPath = findPackageJsonPath("@mariozechner/pi-coding-agent");
		if (!packageJsonPath) return undefined;
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
		const binEntry = typeof packageJson.bin === "string"
			? packageJson.bin
			: packageJson.bin && typeof packageJson.bin.pi === "string"
				? packageJson.bin.pi
				: undefined;
		if (!binEntry) return undefined;
		const cliPath = path.resolve(path.dirname(packageJsonPath), binEntry);
		return cliPath;
	} catch {
		return undefined;
	}
}

function getPiLaunchSpec(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; displayCommand: string } {
	const resolvedCommand = resolveCommandOnPath("pi", env);
	if (resolvedCommand) return { command: resolvedCommand, args: [], displayCommand: "pi" };
	const cliScript = resolvePiCliScript();
	if (cliScript) return { command: process.execPath, args: [cliScript], displayCommand: "pi" };
	return { command: "pi", args: [], displayCommand: "pi" };
}

function getSpawnResultReason(result: SpawnSyncReturns<Buffer>): string {
	return trimOutput(result.stderr?.toString("utf8")) || trimOutput(result.stdout?.toString("utf8")) || result.error?.message || (result.signal ? `pi terminated by signal ${result.signal}` : `pi exited with code ${result.status ?? 1}`);
}

async function runPiWithTerminalHandoff(
	ctx: Ctx,
	worktreePath: string,
	onFailure: (reason: string) => string = (reason) => `Automatic pi handoff failed for ${worktreePath}. Fallback: ${buildFallbackPiCommand(worktreePath)}. Reason: ${reason}`,
): Promise<WorktreeMetadata["handoff"]> {
	const spawn = ctx.spawnInteractive ?? spawnSync;
	const launch = getPiLaunchSpec(process.env);
	let spawnResult: SpawnSyncReturns<Buffer> | undefined;

	const exitCode = await ctx.ui!.custom!<number | null>((tui, _theme, _keybindings, done) => {
		tui.stop?.();
		process.stdout.write("\x1b[2J\x1b[H");
		spawnResult = spawn(launch.command, launch.args, {
			cwd: worktreePath,
			env: process.env,
			stdio: "inherit",
		});
		tui.start?.();
		tui.requestRender?.(true);
		done(spawnResult.status ?? (spawnResult.error || spawnResult.signal ? 1 : 0));
		return { render: () => [], invalidate: () => {} };
	});

	if (exitCode === 0) return { attempted: true, ok: true, command: launch.displayCommand };
	const reason = spawnResult ? getSpawnResultReason(spawnResult) : `pi exited with code ${exitCode ?? 1}`;
	warn(ctx, onFailure(reason));
	return { attempted: true, ok: false, reason, command: launch.displayCommand };
}

async function attemptWorktreeHandoff(ctx: Ctx, worktreePath: string): Promise<WorktreeMetadata["handoff"]> {
	const command = "pi";
	try {
		if (ctx.hasUI && ctx.ui?.custom) return await runPiWithTerminalHandoff(ctx, worktreePath);
		const result = await run(ctx, command, { cwd: worktreePath });
		if (result.code === 0) {
			return { attempted: true, ok: true, command };
		}
		const reason = trimOutput(result.stderr) || trimOutput(result.stdout) || `pi exited with code ${result.code}`;
		warn(ctx, `Automatic pi handoff failed for ${worktreePath}. Fallback: ${buildFallbackPiCommand(worktreePath)}. Reason: ${reason}`);
		return { attempted: true, ok: false, reason, command };
	} catch (error) {
		const reason = (error as Error).message || "Unknown pi handoff failure";
		warn(ctx, `Automatic pi handoff failed for ${worktreePath}. Fallback: ${buildFallbackPiCommand(worktreePath)}. Reason: ${reason}`);
		return { attempted: true, ok: false, reason, command };
	}
}

async function handleWorktreeStart(ctx: Ctx, rawSlug?: string): Promise<WorktreeMetadata> {
	const slug = slugify(rawSlug ?? "");
	let phase = "validate";
	if (!rawSlug?.trim()) fail(ctx, "Usage: /worktree-start <slug>");

	try {
		info(ctx, `Validating worktree creation for ${slug}...`);
		const repoRoot = await detectRepoRoot(ctx);
		await ensureMainCheckout(ctx, repoRoot);
		const branch = getBranchName(slug);
		const worktreePath = getWorktreePath(repoRoot, slug);

		if (await readMetadata(ctx, slug)) fail(ctx, `Managed metadata already exists for slug ${slug}`);
		await ensureBranchDoesNotExist(ctx, branch, repoRoot);
		await ensureTargetPathAvailable(ctx, worktreePath, repoRoot);

		phase = "create";
		info(ctx, `Creating managed worktree ${branch} at ${worktreePath}...`);
		await run(ctx, `git worktree add ${JSON.stringify(worktreePath)} -b ${branch} main`, { cwd: repoRoot });

		phase = "handoff";
		info(ctx, `Attempting pi handoff into ${worktreePath}...`);
		const handoff = await attemptWorktreeHandoff(ctx, worktreePath);
		const metadata: WorktreeMetadata = {
			slug,
			branch,
			repoRoot,
			mainCheckoutPath: repoRoot,
			worktreePath,
			createdAt: new Date().toISOString(),
			handoff,
		};
		await persistMetadata(ctx, metadata);
		await appendHistory(ctx, {
			type: "worktree-start",
			slug,
			branch,
			repoRoot,
			worktreePath,
			createdAt: metadata.createdAt,
		});
		info(ctx, `Managed worktree ready: ${worktreePath}`);
		return metadata;
	} catch (error) {
		const reason = (error as Error).message || "Unknown worktree-start failure";
		await recordFailure(ctx, { command: "worktree-start", phase, reason }, undefined, { slug, rawSlug: rawSlug ?? null });
		throw error;
	}
}

async function detectManagedWorktreeFromCwd(ctx: Ctx, cwd: string): Promise<{ metadata: WorktreeMetadata; repoRoot: string; branch: string }> {
	const repoRoot = await detectRepoRoot(ctx, cwd);
	const branch = trimOutput((await runInCwd(ctx, cwd, "git branch --show-current")).stdout);
	if (!branch || branch === "main" || !branch.startsWith("worktree/")) {
		fail(ctx, "This command must be run from a managed worktree, not the main checkout or an unmanaged branch.");
	}
	const slug = branch.replace(/^worktree\//, "");
	const metadata = await readMetadata(ctx, slug);
	if (!metadata) {
		await runInCwd(ctx, cwd, "git worktree list --porcelain").catch(() => undefined);
		fail(ctx, `No managed worktree metadata found for ${branch}. This checkout appears unmanaged.`);
	}
	if (metadata.branch !== branch || metadata.worktreePath !== cwd) {
		fail(ctx, `Managed worktree metadata mismatch for ${branch}. This checkout appears unmanaged.`);
	}
	return { metadata, repoRoot, branch };
}

function parseGeneratedTexts(response: string | undefined, slug: string): { commitMessage: string; prTitle: string; prBody: string } {
	const fallback = {
		commitMessage: `worktree(${slug}): update`,
		prTitle: `worktree/${slug}: update`,
		prBody: `Created from managed worktree ${slug}.\n\n- branch: worktree/${slug}\n- worktree path tracked in metadata`,
	};
	const trimmed = trimOutput(response);
	if (!trimmed) return fallback;
	const parts = trimmed.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
	const [commitMessage, prTitle, ...rest] = parts;
	if (!commitMessage || !prTitle) return fallback;
	const prBody = rest.join("\n\n").trim() || fallback.prBody;
	return {
		commitMessage,
		prTitle,
		prBody,
	};
}

async function ensureGhAuthenticated(ctx: Ctx, cwd: string): Promise<void> {
	try {
		const result = await runInCwd(ctx, cwd, "gh auth status");
		if (result.code !== 0) fail(ctx, trimOutput(result.stderr) || "gh is not authenticated");
	} catch (error) {
		fail(ctx, (error as Error).message || "gh auth validation failed");
	}
}

function shQuote(value: string): string {
	return JSON.stringify(value);
}

async function lookupExistingPr(ctx: Ctx, cwd: string, branch: string): Promise<string | undefined> {
	const result = await runInCwd(ctx, cwd, `gh pr view ${shQuote(branch)} --json url --jq .url`);
	if (result.code === 0) {
		const url = trimOutput(result.stdout);
		if (url) return url;
	}
	return undefined;
}

async function getGeneratedTexts(ctx: Ctx, metadata: WorktreeMetadata, branch: string, diffStat: string, diffPreview: string) {
	const prompt = [
		`You are preparing commit and PR text for managed worktree ${metadata.slug}.`,
		"Return exactly three sections separated by blank lines: commit message, PR title, PR body.",
		`Branch: ${branch}`,
		`Worktree path: ${metadata.worktreePath}`,
		diffStat ? `Diff stat:\n${diffStat}` : "Working tree is clean.",
		diffPreview ? `Diff preview:\n${diffPreview}` : "",
	].filter(Boolean).join("\n\n");
	return parseGeneratedTexts(await ctx.pi?.ask?.(prompt), metadata.slug);
}

async function handleWorktreePr(ctx: Ctx): Promise<WorktreeMetadata> {
	const cwd = ctx.cwd;
	let phase = "validate";
	let metadata: WorktreeMetadata | undefined;
	let branch = "";

	try {
		({ metadata, branch } = await detectManagedWorktreeFromCwd(ctx, cwd));
		await ensureGhAuthenticated(ctx, cwd);

		const status = await runInCwd(ctx, cwd, "git status --short");
		const hasChanges = trimOutput(status.stdout).length > 0;
		let diffStat = "";
		let diffPreview = "";
		if (hasChanges) {
			diffStat = trimOutput((await runInCwd(ctx, cwd, "git diff --stat")).stdout);
			const firstChangedPath = trimOutput(status.stdout).split(/\r?\n/)[0]?.trim().replace(/^[A-Z? ]+/, "").trim();
			if (firstChangedPath) {
				diffPreview = trimOutput((await runInCwd(ctx, cwd, `git diff -- ${firstChangedPath}`)).stdout);
			}
		}

		phase = "commit";
		const generatedTexts = await getGeneratedTexts(ctx, metadata, branch, diffStat, diffPreview);

		let commitStatus = "skipped-clean";
		if (hasChanges) {
			info(ctx, `Creating commit for ${branch}...`);
			await runInCwd(ctx, cwd, "git add -A");
			await runInCwd(ctx, cwd, `git commit -m ${shQuote(generatedTexts.commitMessage)}`);
			commitStatus = "created";
		}

		phase = "push";
		info(ctx, `Pushing ${branch}...`);
		await runInCwd(ctx, cwd, `git push -u origin ${branch}`);
		const pushStatus = "pushed";

		phase = "pr";
		info(ctx, `Preparing PR for ${branch}...`);
		const existingPrUrl = await lookupExistingPr(ctx, cwd, branch);
		const prUrl = existingPrUrl
			? existingPrUrl
			: trimOutput((await runInCwd(
				ctx,
				cwd,
				`gh pr create --base main --head ${shQuote(branch)} --title ${shQuote(generatedTexts.prTitle)} --body ${shQuote(generatedTexts.prBody)}`,
			)).stdout);
		const prStatus = existingPrUrl ? "existing" : "created";

		const nextMetadata: WorktreeMetadata = {
			...metadata,
			prUrl,
			commitStatus,
			pushStatus,
			prStatus,
		};
		await persistMetadata(ctx, nextMetadata);
		await appendHistory(ctx, {
			type: "worktree-pr",
			slug: metadata.slug,
			branch,
			worktreePath: metadata.worktreePath,
			prUrl,
			commitStatus,
			pushStatus,
			prStatus,
			updatedAt: new Date().toISOString(),
		});
		info(ctx, `PR ready: ${prUrl}`);
		return nextMetadata;
	} catch (error) {
		const reason = (error as Error).message || "Unknown worktree-pr failure";
		await recordFailure(ctx, { command: "worktree-pr", phase, reason }, metadata, { cwd, branch: branch || undefined });
		throw error;
	}
}

async function ensureSafeToCleanup(ctx: Ctx, cwd: string): Promise<void> {
	const status = await runInCwd(ctx, cwd, "git status --short");
	if (trimOutput(status.stdout)) fail(ctx, "Refusing cleanup of dirty worktree with uncommitted changes.");
	const sync = await runInCwd(ctx, cwd, "git status -sb");
	if (/\[ahead\s+\d+/i.test(sync.stdout)) fail(ctx, "Refusing cleanup of unpushed worktree; branch is ahead of origin.");
}

async function attemptReturnToMain(ctx: Ctx, repoRoot: string): Promise<void> {
	try {
		if (ctx.hasUI && ctx.ui?.custom) {
			await runPiWithTerminalHandoff(
				ctx,
				repoRoot,
				(reason) => `Cleanup finished. Return to main checkout at ${repoRoot}. Fallback: cd ${JSON.stringify(repoRoot)} && pi. Reason: ${reason}`,
			);
			return;
		}
		const result = await run(ctx, "pi", { cwd: repoRoot });
		if (result.code === 0) return;
		warn(ctx, `Cleanup finished. Return to main checkout at ${repoRoot}. Fallback: cd ${JSON.stringify(repoRoot)} && pi`);
	} catch {
		warn(ctx, `Cleanup finished. Return to main checkout at ${repoRoot}. Fallback: cd ${JSON.stringify(repoRoot)} && pi`);
	}
}

async function handleWorktreeCleanup(ctx: Ctx): Promise<WorktreeMetadata> {
	const cwd = ctx.cwd;
	let phase = "validate";
	let metadata: WorktreeMetadata | undefined;

	try {
		({ metadata } = await detectManagedWorktreeFromCwd(ctx, cwd));
		await ensureSafeToCleanup(ctx, cwd);

		phase = "cleanup";
		info(ctx, `Cleaning up managed worktree ${metadata.slug}...`);
		await runInCwd(ctx, cwd, `git worktree remove ${shQuote(metadata.worktreePath)}`);

		phase = "return";
		const nextMetadata: WorktreeMetadata = {
			...metadata,
			cleanupResult: "removed",
			returnTarget: metadata.mainCheckoutPath ?? metadata.repoRoot,
			cleanupAt: new Date().toISOString(),
		};
		await persistMetadata(ctx, nextMetadata);
		await appendHistory(ctx, {
			type: "worktree-cleanup",
			slug: metadata.slug,
			branch: metadata.branch,
			worktreePath: metadata.worktreePath,
			cleanupResult: nextMetadata.cleanupResult,
			cleanupAt: nextMetadata.cleanupAt,
		});
		info(ctx, `Cleanup completed for ${metadata.slug}.`);
		await attemptReturnToMain(ctx, nextMetadata.returnTarget ?? metadata.repoRoot ?? "/");
		return nextMetadata;
	} catch (error) {
		const reason = (error as Error).message || "Unknown worktree-cleanup failure";
		await recordFailure(ctx, { command: "worktree-cleanup", phase, reason }, metadata, { cwd });
		throw error;
	}
}

const commands = [
	{
		name: "/worktree-start",
		registerName: "worktree-start",
		handler: async (ctx: Ctx, slug?: string) => await handleWorktreeStart(ctx, slug),
	},
	{
		name: "/worktree-pr",
		registerName: "worktree-pr",
		handler: async (ctx: Ctx) => await handleWorktreePr(ctx),
	},
	{
		name: "/worktree-cleanup",
		registerName: "worktree-cleanup",
		handler: async (ctx: Ctx) => await handleWorktreeCleanup(ctx),
	},
] as const;

function worktreeExtension(pi?: PiApi) {
	runtimePi = pi;
	for (const command of commands) {
		pi?.registerCommand?.(command.registerName, {
			description: `Managed git worktree command ${command.name}`,
			handler: async (args, ctx) => {
				const trimmedArgs = args?.trim();
				if (command.registerName === "worktree-start") return await command.handler(ctx, trimmedArgs);
				return await command.handler(ctx);
			},
		});
	}
}

(worktreeExtension as typeof worktreeExtension & { commands: typeof commands }).commands = commands;

export default worktreeExtension;
