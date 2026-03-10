import path from "node:path";
import { promises as fs, accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
	command: "worktree-start" | "worktree-pr" | "worktree-main" | "worktree-cleanup";
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

function resolveArtifactPath(root: string, artifactPath: string): string {
	return path.isAbsolute(artifactPath) ? artifactPath : path.join(root, artifactPath);
}

function getWorktreeRoot(repoRoot: string): string {
	const configuredRoot = trimOutput(process.env.PI_WORKTREE_ROOT);
	if (configuredRoot) return configuredRoot;
	const homeDir = trimOutput(process.env.HOME);
	if (homeDir) return path.join(homeDir, "parallel", ".worktrees");
	return path.join(path.dirname(repoRoot), ".worktrees");
}

function getWorktreePath(repoRoot: string, slug: string): string {
	return path.join(getWorktreeRoot(repoRoot), getRepoSlug(repoRoot), slug);
}

function getProjectWorktreePath(repoRoot: string): string {
	return path.join(getWorktreeRoot(repoRoot), getRepoSlug(repoRoot));
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

async function detectSharedCheckoutRoot(ctx: Ctx, cwd: string): Promise<string> {
	try {
		const result = await run(ctx, "git rev-parse --git-common-dir", { cwd });
		const commonDir = trimOutput(result.stdout);
		if (commonDir) {
			const absoluteCommonDir = path.resolve(cwd, commonDir);
			if (path.basename(absoluteCommonDir) === ".git") return path.dirname(absoluteCommonDir);
		}
	} catch {
		// Fall back to the current repository root when git-common-dir is unavailable.
	}
	return await detectRepoRoot(ctx, cwd);
}

async function readMetadata(ctx: Ctx, slug: string, cwd = ctx.cwd): Promise<WorktreeMetadata | undefined> {
	const legacyPath = getMetadataPath(slug);
	const legacyMetadata = await readJsonArtifact<WorktreeMetadata>(ctx, legacyPath);
	if (legacyMetadata) return legacyMetadata;
	const sharedRoot = await detectSharedCheckoutRoot(ctx, cwd);
	const sharedPath = resolveArtifactPath(sharedRoot, legacyPath);
	if (sharedPath === legacyPath) return undefined;
	return await readJsonArtifact<WorktreeMetadata>(ctx, sharedPath);
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

async function persistManagedArtifact(
	ctx: Ctx,
	cwd: string,
	artifactPath: string,
	content: string,
	append = false,
	sharedRootOverride?: string,
): Promise<void> {
	await writeArtifact(ctx, artifactPath, content, append);
	const sharedRoot = sharedRootOverride ?? await detectSharedCheckoutRoot(ctx, cwd);
	const sharedPath = resolveArtifactPath(sharedRoot, artifactPath);
	if (sharedPath !== artifactPath) {
		await writeArtifact(ctx, sharedPath, content, append);
	}
}

async function persistMetadata(ctx: Ctx, metadata: WorktreeMetadata, cwd = ctx.cwd, sharedRootOverride?: string): Promise<void> {
	await persistManagedArtifact(ctx, cwd, getMetadataPath(metadata.slug), `${JSON.stringify(metadata, null, 2)}\n`, false, sharedRootOverride);
}

async function appendHistory(ctx: Ctx, event: Record<string, unknown>, cwd = ctx.cwd, sharedRootOverride?: string): Promise<void> {
	await persistManagedArtifact(ctx, cwd, getHistoryPath(), `${JSON.stringify(event)}\n`, true, sharedRootOverride);
}

async function recordFailure(
	ctx: Ctx,
	failure: Omit<WorktreeFailure, "at">,
	metadata?: WorktreeMetadata,
	extra?: Record<string, unknown>,
	cwd = ctx.cwd,
	sharedRootOverride?: string,
): Promise<void> {
	const at = new Date().toISOString();
	const persistedFailure: WorktreeFailure = { ...failure, at };
	if (metadata) {
		await persistMetadata(ctx, {
			...metadata,
			lastFailure: persistedFailure,
		}, cwd, sharedRootOverride);
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
	}, cwd, sharedRootOverride);
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

async function ensureProjectDirenv(ctx: Ctx, repoRoot: string): Promise<void> {
	const projectDir = getProjectWorktreePath(repoRoot);
	const envrcPath = path.join(projectDir, ".envrc");
	const envrcContent = [
		'_GH_DETECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"',
		"source_env ../.gh-detect.sh",
		"",
	].join("\n");
	try {
		await fs.access(envrcPath, fsConstants.F_OK);
		return;
	} catch {
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(envrcPath, envrcContent, "utf8");
		const allowResult = await run(ctx, `direnv allow ${shQuote(projectDir)}`, { cwd: projectDir });
		if (allowResult.code !== 0) {
			fail(ctx, trimOutput(allowResult.stderr) || trimOutput(allowResult.stdout) || `direnv allow failed with code ${allowResult.code}`);
		}
	}
}

function buildFallbackPiCommand(worktreePath: string): string {
	return `cd ${JSON.stringify(worktreePath)} && pi`;
}

function buildCleanupHint(repoRoot: string, slug: string): string {
	return `cd ${JSON.stringify(repoRoot)} && pi, then run /worktree-cleanup ${slug}`;
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function runAppleScript(ctx: Ctx, cwd: string, script: string): Promise<ExecResult> {
	const command = `osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`;
	return await run(ctx, command, { cwd });
}

async function launchPiInCmuxTab(ctx: Ctx, worktreePath: string): Promise<WorktreeMetadata["handoff"] | undefined> {
	if (!trimOutput(process.env.CMUX_WORKSPACE_ID) && !trimOutput(process.env.CMUX_SOCKET_PATH)) return undefined;
	const shellCommand = buildFallbackPiCommand(worktreePath);
	const create = await run(ctx, "cmux --json new-surface --type terminal", { cwd: worktreePath });
	if (create.code !== 0) {
		const reason = trimOutput(create.stderr) || trimOutput(create.stdout) || `cmux new-surface failed with code ${create.code}`;
		warn(ctx, `Automatic pi handoff skipped for ${worktreePath} to preserve the current session. Fallback: ${shellCommand}. Reason: ${reason}`);
		return { attempted: true, ok: false, reason, command: shellCommand };
	}
	let surfaceRef = "";
	try {
		surfaceRef = String((JSON.parse(create.stdout) as { surface_ref?: string }).surface_ref ?? "");
	} catch {
		// handled below with a safe fallback
	}
	if (!surfaceRef) {
		const reason = "cmux did not return a surface_ref for the new tab";
		warn(ctx, `Automatic pi handoff skipped for ${worktreePath} to preserve the current session. Fallback: ${shellCommand}. Reason: ${reason}`);
		return { attempted: true, ok: false, reason, command: shellCommand };
	}
	const surfaceFlag = ` --surface ${shQuote(surfaceRef)}`;
	const send = await run(ctx, `cmux send${surfaceFlag} ${shQuote(`${shellCommand}\n`)}`, { cwd: worktreePath });
	if (send.code !== 0) {
		const reason = trimOutput(send.stderr) || trimOutput(send.stdout) || `cmux send failed with code ${send.code}`;
		warn(ctx, `Automatic pi handoff skipped for ${worktreePath} to preserve the current session. Fallback: ${shellCommand}. Reason: ${reason}`);
		return { attempted: true, ok: false, reason, command: shellCommand };
	}
	return { attempted: true, ok: true, command: shellCommand };
}

async function launchPiInTmuxTab(ctx: Ctx, worktreePath: string): Promise<WorktreeMetadata["handoff"] | undefined> {
	if (!trimOutput(process.env.TMUX)) return undefined;
	const shellCommand = buildFallbackPiCommand(worktreePath);
	const result = await run(ctx, `tmux new-window ${shQuote(shellCommand)}`, { cwd: worktreePath });
	if (result.code === 0) return { attempted: true, ok: true, command: shellCommand };
	const reason = trimOutput(result.stderr) || trimOutput(result.stdout) || `tmux new-window failed with code ${result.code}`;
	warn(ctx, `Automatic pi handoff skipped for ${worktreePath} to preserve the current session. Fallback: ${shellCommand}. Reason: ${reason}`);
	return { attempted: true, ok: false, reason, command: shellCommand };
}

async function launchPiInNewTerminalTab(ctx: Ctx, worktreePath: string): Promise<WorktreeMetadata["handoff"] | undefined> {
	if (process.platform !== "darwin") return undefined;
	const termProgram = trimOutput(process.env.TERM_PROGRAM);
	const shellCommand = buildFallbackPiCommand(worktreePath);
	const escapedShellCommand = escapeAppleScriptString(shellCommand);
	const terminalScript = `tell application "Terminal"
activate
if (count of windows) is 0 then
	do script "${escapedShellCommand}"
else
	do script "${escapedShellCommand}" in front window
end if
end tell`;
	const iTermScript = `tell application "iTerm"
activate
if (count of windows) is 0 then
	create window with default profile command "${escapedShellCommand}"
else
	tell current window
		create tab with default profile command "${escapedShellCommand}"
	end tell
end if
end tell`;
	const preferredScript = termProgram === "iTerm.app" ? iTermScript : terminalScript;
	const fallbackScript = preferredScript === iTermScript ? terminalScript : iTermScript;
	const preferred = await runAppleScript(ctx, worktreePath, preferredScript);
	if (preferred.code === 0) return { attempted: true, ok: true, command: shellCommand };
	const fallback = await runAppleScript(ctx, worktreePath, fallbackScript);
	if (fallback.code === 0) return { attempted: true, ok: true, command: shellCommand };
	const reason = trimOutput(fallback.stderr) || trimOutput(preferred.stderr) || trimOutput(fallback.stdout) || trimOutput(preferred.stdout) || "Failed to open a new terminal tab";
	warn(ctx, `Automatic pi handoff skipped for ${worktreePath} to preserve the current session. Fallback: ${shellCommand}. Reason: ${reason}`);
	return { attempted: true, ok: false, reason, command: shellCommand };
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

function findPackageJsonPath(packageName: string): string | undefined {
	const require = createRequire(import.meta.url);
	for (const root of require.resolve.paths(packageName) ?? []) {
		const candidate = path.join(root, packageName, "package.json");
		try {
			accessSync(candidate, fsConstants.R_OK);
			return candidate;
		} catch {
			// keep searching resolver roots
		}
	}
	return undefined;
}

function resolvePiCliScript(): string | undefined {
	const packageJsonPath = findPackageJsonPath("@mariozechner/pi-coding-agent");
	if (!packageJsonPath) return undefined;
	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: string | Record<string, string> };
		const binEntry = typeof packageJson.bin === "string"
			? packageJson.bin
			: packageJson.bin && typeof packageJson.bin.pi === "string"
				? packageJson.bin.pi
				: undefined;
		return binEntry ? path.resolve(path.dirname(packageJsonPath), binEntry) : undefined;
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
		if (ctx.hasUI) {
			const cmuxHandoff = await launchPiInCmuxTab(ctx, worktreePath);
			if (cmuxHandoff) return cmuxHandoff;
			const tmuxHandoff = await launchPiInTmuxTab(ctx, worktreePath);
			if (tmuxHandoff) return tmuxHandoff;
			const externalTerminalHandoff = await launchPiInNewTerminalTab(ctx, worktreePath);
			if (externalTerminalHandoff) return externalTerminalHandoff;
			const reason = "Non-destructive tab handoff is only supported on CMUX, TMUX, or macOS terminal apps";
			warn(ctx, `Automatic pi handoff skipped for ${worktreePath} to preserve the current session. Fallback: ${buildFallbackPiCommand(worktreePath)}. Reason: ${reason}`);
			return { attempted: true, ok: false, reason, command };
		}
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
		const createResult = await run(ctx, `git worktree add ${JSON.stringify(worktreePath)} -b ${branch} main`, { cwd: repoRoot });
		if (createResult.code !== 0) {
			fail(ctx, trimOutput(createResult.stderr) || trimOutput(createResult.stdout) || `git worktree add failed with code ${createResult.code}`);
		}

		await ensureProjectDirenv(ctx, repoRoot);

		const createdAt = new Date().toISOString();
		const metadata: WorktreeMetadata = {
			slug,
			branch,
			repoRoot,
			mainCheckoutPath: repoRoot,
			worktreePath,
			createdAt,
		};
		await persistMetadata(ctx, metadata);
		await appendHistory(ctx, {
			type: "worktree-start",
			slug,
			branch,
			repoRoot,
			worktreePath,
			createdAt,
		});

		phase = "handoff";
		info(ctx, `Attempting pi handoff into ${worktreePath}...`);
		const handoff = await attemptWorktreeHandoff(ctx, worktreePath);
		const nextMetadata: WorktreeMetadata = {
			...metadata,
			handoff,
		};
		await persistMetadata(ctx, nextMetadata);
		info(ctx, `Managed worktree ready: ${worktreePath}`);
		return nextMetadata;
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

function parseDiffFiles(diff: string): string[] {
	const files: string[] = [];
	const regex = /^diff --git a\/.+? b\/(.+)$/gm;
	let m;
	while ((m = regex.exec(diff)) !== null) {
		files.push(m[1]);
	}
	return [...new Set(files)];
}

function parseDiffHunkSummaries(diff: string): Map<string, string[]> {
	const summaries = new Map<string, string[]>();
	const fileSections = diff.split(/^diff --git /m).filter(Boolean);
	for (const section of fileSections) {
		const fileMatch = section.match(/a\/.+? b\/(.+)/);
		if (!fileMatch) continue;
		const file = fileMatch[1];
		const additions: string[] = [];
		for (const line of section.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("+++ ")) {
				const content = line.slice(1).trim();
				if (content) additions.push(content);
			}
		}
		if (additions.length > 0) {
			summaries.set(file, additions.slice(0, 5)); // Keep top 5 additions per file
		}
	}
	return summaries;
}

function buildDiffBasedPrBody(diff: string, branch: string, slug: string): string {
	const files = parseDiffFiles(diff);
	if (files.length === 0) {
		return `No file changes detected in branch \`${branch}\`.\n\nThis PR was created from managed worktree \`${slug}\`.`;
	}

	const hunkSummaries = parseDiffHunkSummaries(diff);
	const sections: string[] = [];

	sections.push(`## Summary\n\nChanges in branch \`${branch}\` affecting ${files.length} file(s).`);

	const fileEntries = files.map((f) => {
		const additions = hunkSummaries.get(f);
		if (additions && additions.length > 0) {
			return `- \`${f}\`\n  - ${additions.slice(0, 3).map((a) => a.substring(0, 100)).join("\n  - ")}`;
		}
		return `- \`${f}\``;
	});
	sections.push(`## Changed Files\n\n${fileEntries.join("\n")}`);

	return sections.join("\n\n");
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

async function getGeneratedTexts(ctx: Ctx, metadata: WorktreeMetadata, branch: string, fullDiff: string) {
	// Build a programmatic diff-based PR body as a solid baseline
	const diffBasedBody = buildDiffBasedPrBody(fullDiff, branch, metadata.slug);

	// Try AI-enhanced description if available
	if (ctx.pi?.ask) {
		const prompt = [
			`You are preparing commit and PR text for managed worktree ${metadata.slug}.`,
			"Return exactly three sections separated by blank lines: commit message, PR title, PR body (in markdown).",
			"The PR body MUST reference every changed file by name.",
			`Branch: ${branch}`,
			`Worktree path: ${metadata.worktreePath}`,
			fullDiff ? `Full diff:\n${fullDiff}` : "Working tree is clean.",
		].filter(Boolean).join("\n\n");
		const aiResult = parseGeneratedTexts(await ctx.pi.ask(prompt), metadata.slug);
		// Validate AI result references files from the diff, otherwise use programmatic body
		const files = parseDiffFiles(fullDiff);
		const aiBodyReferencesFiles = files.length === 0 || files.some((f) => aiResult.prBody.includes(f));
		if (aiBodyReferencesFiles && aiResult.prBody.length >= 50) {
			return aiResult;
		}
		// AI result wasn't good enough, use programmatic body but keep AI commit message and title
		return {
			commitMessage: aiResult.commitMessage,
			prTitle: aiResult.prTitle,
			prBody: diffBasedBody,
		};
	}

	// No AI available, use fully programmatic result
	return {
		commitMessage: `worktree(${metadata.slug}): update`,
		prTitle: `worktree/${metadata.slug}: update`,
		prBody: diffBasedBody,
	};
}

async function handleWorktreePr(ctx: Ctx): Promise<WorktreeMetadata> {
	const cwd = ctx.cwd;
	let phase = "validate";
	let metadata: WorktreeMetadata | undefined;
	let branch = "";

	try {
		({ metadata, branch } = await detectManagedWorktreeFromCwd(ctx, cwd));
		await ensureGhAuthenticated(ctx, cwd);

		// Get full diff against main for comprehensive PR description
		const fullDiffResult = await runInCwd(ctx, cwd, "git diff main");
		const fullDiff = trimOutput(fullDiffResult.stdout);

		const status = await runInCwd(ctx, cwd, "git status --short");
		const hasChanges = trimOutput(status.stdout).length > 0;

		phase = "commit";
		const generatedTexts = await getGeneratedTexts(ctx, metadata, branch, fullDiff);

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

async function detectMainCheckout(ctx: Ctx, cwd = ctx.cwd): Promise<{ repoRoot: string; branch: string }> {
	const repoRoot = await detectRepoRoot(ctx, cwd);
	const branch = trimOutput((await run(ctx, "git branch --show-current", { cwd: repoRoot })).stdout);
	if (branch !== "main") fail(ctx, `This command must be run from the main checkout. Current branch: ${branch || "(unknown)"}`);
	return { repoRoot, branch };
}

async function handleWorktreeMain(ctx: Ctx): Promise<WorktreeMetadata> {
	const cwd = ctx.cwd;
	let phase = "validate";
	let metadata: WorktreeMetadata | undefined;

	try {
		({ metadata } = await detectManagedWorktreeFromCwd(ctx, cwd));
		const repoRoot = metadata.mainCheckoutPath ?? metadata.repoRoot;
		if (!repoRoot) fail(ctx, `Managed worktree ${metadata.slug} is missing its main checkout path.`);

		phase = "handoff";
		info(ctx, `Returning to main checkout at ${repoRoot} for ${metadata.slug}...`);
		const handoff = await attemptWorktreeHandoff(ctx, repoRoot);
		const nextMetadata: WorktreeMetadata = {
			...metadata,
			returnTarget: repoRoot,
			handoff,
		};
		await persistMetadata(ctx, nextMetadata, repoRoot, repoRoot);
		await appendHistory(ctx, {
			type: "worktree-main",
			slug: metadata.slug,
			branch: metadata.branch,
			worktreePath: metadata.worktreePath,
			returnTarget: repoRoot,
			updatedAt: new Date().toISOString(),
		}, repoRoot, repoRoot);
		info(ctx, `Main checkout ready: ${repoRoot}`);
		warn(ctx, `To remove this worktree, ${buildCleanupHint(repoRoot, metadata.slug)}.`);
		return nextMetadata;
	} catch (error) {
		const reason = (error as Error).message || "Unknown worktree-main failure";
		await recordFailure(ctx, { command: "worktree-main", phase, reason }, metadata, { cwd });
		throw error;
	}
}

async function handleWorktreeCleanup(ctx: Ctx, rawSlug?: string): Promise<WorktreeMetadata> {
	const cwd = ctx.cwd;
	let phase = "validate";
	let metadata: WorktreeMetadata | undefined;
	let repoRoot = cwd;

	try {
		const currentBranch = trimOutput((await runInCwd(ctx, cwd, "git branch --show-current")).stdout);
		if (currentBranch.startsWith("worktree/")) {
			const currentSlug = currentBranch.replace(/^worktree\//, "");
			fail(ctx, `Run /worktree-main first, then /worktree-cleanup ${currentSlug} from the main checkout.`);
		}
		({ repoRoot } = await detectMainCheckout(ctx, cwd));

		const slug = slugify(rawSlug ?? "");
		if (!rawSlug?.trim()) fail(ctx, "Usage: /worktree-cleanup <slug>");
		metadata = await readMetadata(ctx, slug, repoRoot);
		if (!metadata) fail(ctx, `No managed worktree metadata found for worktree/${slug}.`);
		if (metadata.branch !== getBranchName(slug)) fail(ctx, `Managed worktree metadata mismatch for worktree/${slug}.`);
		if ((metadata.mainCheckoutPath ?? metadata.repoRoot) && (metadata.mainCheckoutPath ?? metadata.repoRoot) !== repoRoot) {
			fail(ctx, `Managed worktree ${slug} belongs to a different main checkout: ${(metadata.mainCheckoutPath ?? metadata.repoRoot)}`);
		}

		phase = "verify";
		await ensureSafeToCleanup(ctx, metadata.worktreePath);

		phase = "cleanup";
		info(ctx, `Cleaning up managed worktree ${metadata.slug}...`);
		await runInCwd(ctx, repoRoot, `git worktree remove ${shQuote(metadata.worktreePath)}`);

		phase = "persist";
		const nextMetadata: WorktreeMetadata = {
			...metadata,
			cleanupResult: "removed",
			returnTarget: repoRoot,
			cleanupAt: new Date().toISOString(),
		};
		await persistMetadata(ctx, nextMetadata, repoRoot, repoRoot);
		await appendHistory(ctx, {
			type: "worktree-cleanup",
			slug: metadata.slug,
			branch: metadata.branch,
			worktreePath: metadata.worktreePath,
			cleanupResult: nextMetadata.cleanupResult,
			cleanupAt: nextMetadata.cleanupAt,
		}, repoRoot, repoRoot);
		info(ctx, `Cleanup completed for ${metadata.slug}.`);
		warn(ctx, `Cleanup finished. Main checkout remains at ${repoRoot}.`);
		return nextMetadata;
	} catch (error) {
		const reason = (error as Error).message || "Unknown worktree-cleanup failure";
		await recordFailure(ctx, { command: "worktree-cleanup", phase, reason }, metadata, { cwd, slug: rawSlug?.trim() || undefined }, repoRoot, repoRoot);
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
		name: "/worktree-main",
		registerName: "worktree-main",
		handler: async (ctx: Ctx) => await handleWorktreeMain(ctx),
	},
	{
		name: "/worktree-cleanup",
		registerName: "worktree-cleanup",
		handler: async (ctx: Ctx, slug?: string) => await handleWorktreeCleanup(ctx, slug),
	},
] as const;

function worktreeExtension(pi?: PiApi) {
	runtimePi = pi;
	for (const command of commands) {
		pi?.registerCommand?.(command.registerName, {
			description: `Managed git worktree command ${command.name}`,
			handler: async (args, ctx) => {
				const trimmedArgs = args?.trim();
				if (command.registerName === "worktree-start" || command.registerName === "worktree-cleanup") return await command.handler(ctx, trimmedArgs);
				return await command.handler(ctx);
			},
		});
	}
}

const extensionExport = Object.assign(worktreeExtension, {
	commands: {
		"worktree-start": async (ctx: Ctx, slug?: string) => handleWorktreeStart(ctx, slug),
		"worktree-pr": async (ctx: Ctx) => handleWorktreePr(ctx),
		"worktree-main": async (ctx: Ctx) => handleWorktreeMain(ctx),
		"worktree-cleanup": async (ctx: Ctx, slug?: string) => handleWorktreeCleanup(ctx, slug),
	},
});

export default extensionExport;
