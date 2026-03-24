import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ExecResult = { stdout: string; stderr: string; code: number };

type ReviewerKind = "coderabbit" | "codex";
type ReviewFinding = {
	id: string;
	reviewer: string;
	reviewerKind: ReviewerKind;
	source: "review" | "comment";
	text: string;
	path?: string;
	line?: number;
	originalLine?: number;
};

type PullRequestIdentity = {
	number: number;
	url: string;
	title: string;
	headRefName: string;
};

type PrReviewRunPhase =
	| "preflight"
	| "gathering-feedback"
	| "awaiting-agent"
	| "committing"
	| "pushing"
	| "completed"
	| "failed";

type PrReviewRunState = {
	active: boolean;
	sourceCommand: "pr-review-fix";
	repoRoot: string;
	localBranch: string;
	branch: string;
	pushRemote: string;
	pr: PullRequestIdentity;
	phase: PrReviewRunPhase;
	findingsGathered: number;
	findingsSelected: number;
	pushPolicy: "auto-commit-and-push";
	commitMessage: string;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	lastOutcome?: string;
	lastError?: string;
};

type RawPullRequest = {
	number?: unknown;
	url?: unknown;
	title?: unknown;
	headRefName?: unknown;
	reviews?: unknown;
	latestReviews?: unknown;
	comments?: unknown;
};

type BotReviewerDefinition = {
	kind: ReviewerKind;
	label: string;
	aliases: string[];
};

const PR_REVIEW_STATE_TYPE = "pr-review-cycle-session";
const PR_REVIEW_STATUS_KEY = "pr-review-cycle";
const PR_REVIEW_JSON_FIELDS = ["number", "url", "title", "headRefName", "reviews", "latestReviews", "comments"];
const BOT_REVIEWERS: BotReviewerDefinition[] = [
	{ kind: "coderabbit", label: "CodeRabbit", aliases: ["coderabbit", "coderabbitai", "coderabbitai[bot]"] },
	{ kind: "codex", label: "Codex", aliases: ["codex", "openai-codex", "codex[bot]"] },
];
const GENERIC_NON_ACTIONABLE_PATTERNS = [
	/^lgtm[.!\s]*$/i,
	/^looks good(?: to me)?[.!\s]*$/i,
	/^approved[.!\s]*$/i,
	/^no issues found[.!\s]*$/i,
	/^nothing to fix[.!\s]*$/i,
	/^ship it[.!\s]*$/i,
];

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, level);
	else if (typeof ctx?.notify === "function") ctx.notify(message, level);
}

function appendCustomEntry(target: any, customType: string, data: unknown) {
	const appendEntry = target?.appendEntry;
	if (typeof appendEntry !== "function") return;
	if (appendEntry.length >= 2) return appendEntry(customType, data);
	return appendEntry({ type: "custom", customType, data });
}

function getCustomEntryData(entry: any): any | undefined {
	if (!entry) return undefined;
	if (entry.type === "custom" && Object.prototype.hasOwnProperty.call(entry, "data")) return entry.data;
	if (entry.type === PR_REVIEW_STATE_TYPE && Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
}

function getState(ctx: any): PrReviewRunState | undefined {
	return ctx?.state?.prReviewCycle;
}

function setState(ctx: any, state: PrReviewRunState | undefined): void {
	if (!ctx.state) ctx.state = {};
	ctx.state.prReviewCycle = state;
}

function loadPersistedState(ctx: any): PrReviewRunState | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() ?? ctx?.sessionManager?.getBranch?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!(entry?.type === "custom" && entry?.customType === PR_REVIEW_STATE_TYPE) && entry?.type !== PR_REVIEW_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data || data.active === false && !data.pr) {
			setState(ctx, undefined);
			return undefined;
		}
		setState(ctx, data as PrReviewRunState);
		return data as PrReviewRunState;
	}
	return undefined;
}

async function applyState(ctx: any, state: PrReviewRunState): Promise<PrReviewRunState> {
	setState(ctx, state);
	appendCustomEntry(ctx.pi ?? ctx, PR_REVIEW_STATE_TYPE, state);
	applyFooterStatus(ctx, state);
	return state;
}

async function clearState(ctx: any): Promise<void> {
	setState(ctx, undefined);
	appendCustomEntry(ctx.pi ?? ctx, PR_REVIEW_STATE_TYPE, { active: false });
	applyFooterStatus(ctx, undefined);
}

function applyFooterStatus(ctx: any, state: PrReviewRunState | undefined): void {
	if (typeof ctx?.ui?.setStatus !== "function") return;
	if (!state?.active) {
		ctx.ui.setStatus(PR_REVIEW_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(PR_REVIEW_STATUS_KEY, `PR review #${state.pr.number} ${state.phase} (${state.findingsSelected}/${state.findingsGathered} findings)`);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray<T = unknown>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function getAuthorIdentity(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return asString(record.login) ?? asString(record.name) ?? asString(record.displayName);
}

function detectReviewerKind(authorLike: unknown, text?: string): ReviewerKind | undefined {
	const authorIdentity = (getAuthorIdentity(authorLike) ?? "").toLowerCase();
	const fallbackIdentity = (text ?? "").toLowerCase();
	for (const reviewer of BOT_REVIEWERS) {
		if (authorIdentity && reviewer.aliases.some((alias) => authorIdentity.includes(alias.toLowerCase()))) return reviewer.kind;
		if (!authorIdentity && reviewer.aliases.some((alias) => fallbackIdentity.includes(alias.toLowerCase()))) return reviewer.kind;
	}
	return undefined;
}

function labelForReviewer(kind: ReviewerKind): string {
	return BOT_REVIEWERS.find((reviewer) => reviewer.kind === kind)?.label ?? kind;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeDedupText(text: string): string {
	return normalizeWhitespace(text)
		.toLowerCase()
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]+`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9/._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isActionableFeedbackText(text: string): boolean {
	const normalized = normalizeWhitespace(text);
	if (!normalized) return false;
	if (GENERIC_NON_ACTIONABLE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	if (normalized.length < 8) return false;
	return true;
}

function buildFindingId(finding: Omit<ReviewFinding, "id">): string {
	const textKey = normalizeDedupText(finding.text).slice(0, 160);
	return [finding.reviewerKind, finding.source, finding.path ?? "", finding.line ?? "", textKey].join("|");
}

function pushFinding(target: Map<string, ReviewFinding>, finding: Omit<ReviewFinding, "id">): void {
	if (!isActionableFeedbackText(finding.text)) return;
	const id = buildFindingId(finding);
	if (target.has(id)) return;
	target.set(id, { ...finding, id });
}

function collectReviewCommentFindings(source: "comment" | "review", reviewerKind: ReviewerKind, reviewer: string, value: unknown, target: Map<string, ReviewFinding>): void {
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const text = asString(record.body) ?? asString(record.text) ?? asString(record.bodyText);
	if (!text) return;
	pushFinding(target, {
		reviewer,
		reviewerKind,
		source,
		text,
		path: asString(record.path) ?? asString(record.file) ?? asString(record.filePath),
		line: asNumber(record.line) ?? asNumber(record.startLine) ?? asNumber(record.position),
		originalLine: asNumber(record.originalLine),
	});
}

export function collectBotFindingsFromPullRequest(pr: RawPullRequest): ReviewFinding[] {
	const findings = new Map<string, ReviewFinding>();
	const seenReviewBodies = new Set<string>();
	const reviewEntries = [...asArray(pr.reviews), ...asArray(pr.latestReviews)];
	for (const review of reviewEntries) {
		if (!review || typeof review !== "object") continue;
		const record = review as Record<string, unknown>;
		const author = record.author;
		const reviewerKind = detectReviewerKind(author, asString(record.body));
		if (!reviewerKind) continue;
		const reviewer = getAuthorIdentity(author) ?? labelForReviewer(reviewerKind);
		const body = asString(record.body) ?? asString(record.bodyText);
		if (body && !seenReviewBodies.has(`${reviewerKind}|${normalizeDedupText(body)}`)) {
			seenReviewBodies.add(`${reviewerKind}|${normalizeDedupText(body)}`);
			pushFinding(findings, {
				reviewer,
				reviewerKind,
				source: "review",
				text: body,
				path: undefined,
				line: undefined,
				originalLine: undefined,
			});
		}
		for (const comment of asArray(record.comments)) collectReviewCommentFindings("comment", reviewerKind, reviewer, comment, findings);
	}

	for (const comment of asArray(pr.comments)) {
		if (!comment || typeof comment !== "object") continue;
		const record = comment as Record<string, unknown>;
		const author = record.author;
		const text = asString(record.body) ?? asString(record.bodyText) ?? asString(record.text);
		const reviewerKind = detectReviewerKind(author, text);
		if (!reviewerKind) continue;
		collectReviewCommentFindings("comment", reviewerKind, getAuthorIdentity(author) ?? labelForReviewer(reviewerKind), comment, findings);
	}

	return [...findings.values()];
}

function normalizePullRequestIdentity(pr: RawPullRequest): PullRequestIdentity {
	const number = asNumber(pr.number);
	const url = asString(pr.url);
	const title = asString(pr.title);
	const headRefName = asString(pr.headRefName);
	if (!number || !url || !title || !headRefName) throw new Error("GitHub PR response is missing required fields.");
	return { number, url, title, headRefName };
}

function buildRepairPrompt(pr: PullRequestIdentity, findings: ReviewFinding[]): string {
	const lines = [
		`PR review follow-up for GitHub PR #${pr.number}: ${pr.title}`,
		`PR URL: ${pr.url}`,
		"",
		"Determine which findings below are still actionable.",
		"Fix all actionable findings in this repository.",
		"Ignore findings that are outdated, incorrect, already satisfied, or out of scope.",
		"Keep changes narrow to the review feedback.",
		"Do not merge, resolve threads, reply on GitHub, or start autonomous loops.",
		"Do not commit or push manually; the extension will do that if repository changes remain at the end.",
		"",
		"Findings:",
	];
	for (const [index, finding] of findings.entries()) {
		const location = [finding.path, finding.line != null ? `line ${finding.line}` : undefined].filter(Boolean).join(": ");
		lines.push(`${index + 1}. [${labelForReviewer(finding.reviewerKind)}] ${location || "general"}`);
		lines.push(`   Reviewer identity: ${finding.reviewer}`);
		lines.push(`   Feedback: ${normalizeWhitespace(finding.text)}`);
	}
	return lines.join("\n");
}

function buildStatusBody(state: PrReviewRunState): string {
	return [
		"# PR review fix status",
		"",
		`- active: ${state.active ? "yes" : "no"}`,
		`- PR: #${state.pr.number}`,
		`- URL: ${state.pr.url}`,
		`- local branch: ${state.localBranch}`,
		`- PR head branch: ${state.branch}`,
		`- push remote: ${state.pushRemote}`,
		`- phase: ${state.phase}`,
		`- findings gathered: ${state.findingsGathered}`,
		`- findings selected: ${state.findingsSelected}`,
		`- push policy: ${state.pushPolicy}`,
		`- last outcome: ${state.lastOutcome ?? "(none)"}`,
		`- last error: ${state.lastError ?? "(none)"}`,
		`- updated: ${state.updatedAt}`,
	].join("\n");
}

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<ExecResult> {
	return await pi.exec(command, args, cwd ? { cwd } : undefined) as ExecResult;
}

async function ensureGitRepo(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
	if (result.code !== 0) throw new Error("/pr-review-fix must be run inside a git repository.");
	const repoRoot = result.stdout.trim();
	if (!repoRoot) throw new Error("Unable to determine git repository root.");
	return repoRoot;
}

async function ensureGhAvailable(pi: ExtensionAPI, cwd: string): Promise<void> {
	try {
		const result = await exec(pi, "gh", ["--version"], cwd);
		if (result.code !== 0) throw new Error();
	} catch {
		throw new Error("GitHub CLI `gh` is required for /pr-review-fix.");
	}
}

async function ensureGhAuthenticated(pi: ExtensionAPI, cwd: string): Promise<void> {
	const result = await exec(pi, "gh", ["auth", "status"], cwd);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || "GitHub CLI is not authenticated.";
		throw new Error(`GitHub authentication failed: ${reason}`);
	}
}

async function fetchCurrentPrReviewData(pi: ExtensionAPI, cwd: string): Promise<RawPullRequest> {
	const result = await exec(pi, "gh", ["pr", "view", "--json", PR_REVIEW_JSON_FIELDS.join(",")], cwd);
	if (result.code !== 0) {
		const reason = result.stderr.trim() || result.stdout.trim() || "No open PR found for the current branch.";
		throw new Error(`Unable to load current PR review data: ${reason}`);
	}
	try {
		return JSON.parse(result.stdout) as RawPullRequest;
	} catch {
		throw new Error("GitHub CLI returned invalid PR JSON.");
	}
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await exec(pi, "git", ["branch", "--show-current"], cwd);
	if (result.code !== 0) throw new Error("Unable to determine current git branch.");
	const branch = result.stdout.trim();
	if (!branch) throw new Error("Unable to determine current git branch.");
	return branch;
}

async function getWorkingTreeChanges(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await exec(pi, "git", ["status", "--porcelain"], cwd);
	if (result.code !== 0) throw new Error("Unable to inspect git working tree.");
	return result.stdout.trim();
}

async function ensureCleanWorkingTree(pi: ExtensionAPI, cwd: string): Promise<void> {
	const statusOutput = await getWorkingTreeChanges(pi, cwd);
	if (!statusOutput) return;
	throw new Error("/pr-review-fix requires a clean git working tree before it starts. Commit, stash, or discard existing changes first.");
}

async function resolvePushRemote(pi: ExtensionAPI, cwd: string, localBranch: string): Promise<string> {
	const configResult = await exec(pi, "git", ["config", "--get", `branch.${localBranch}.remote`], cwd);
	const configuredRemote = configResult.stdout.trim();
	if (configResult.code === 0 && configuredRemote) return configuredRemote;

	const remotesResult = await exec(pi, "git", ["remote"], cwd);
	if (remotesResult.code !== 0) throw new Error("Unable to determine git remotes for /pr-review-fix push target.");
	const remotes = remotesResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
	if (remotes.length === 1) return remotes[0]!;
	throw new Error(`Unable to determine which remote should receive PR review fixes for branch ${localBranch}. Configure branch.${localBranch}.remote or set an upstream before retrying.`);
}

function getAgentRunFailure(messages: unknown): { stopReason: "aborted" | "error"; errorMessage?: string } | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		if (record.stopReason !== "aborted" && record.stopReason !== "error") return undefined;
		const stopReason = record.stopReason;
		return {
			stopReason,
			errorMessage: asString(record.errorMessage),
		};
	}
	return undefined;
}

function getStateOrLoad(ctx: any): PrReviewRunState | undefined {
	return getState(ctx) ?? loadPersistedState(ctx);
}

async function finalizeActiveRun(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const state = getStateOrLoad(ctx);
	if (!state?.active || state.sourceCommand !== "pr-review-fix") return;

	try {
		const statusOutput = await getWorkingTreeChanges(pi, state.repoRoot);
		if (!statusOutput) {
			await applyState(ctx, {
				...state,
				active: false,
				phase: "completed",
				updatedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				lastOutcome: "Agent finished without repository changes; nothing was committed or pushed.",
				lastError: undefined,
			});
			notify(ctx, `PR review fix for #${state.pr.number} finished with no repository changes.`, "info");
			return;
		}

		await applyState(ctx, { ...state, phase: "committing", updatedAt: new Date().toISOString() });
		let result = await exec(pi, "git", ["add", "-A"], state.repoRoot);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "git add failed");
		result = await exec(pi, "git", ["commit", "-m", state.commitMessage], state.repoRoot);
		if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git commit failed");

		await applyState(ctx, { ...getStateOrLoad(ctx)!, phase: "pushing", updatedAt: new Date().toISOString() });
		result = await exec(pi, "git", ["push", state.pushRemote, `HEAD:${state.branch}`], state.repoRoot);
		if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "git push failed");

		await applyState(ctx, {
			...getStateOrLoad(ctx)!,
			active: false,
			phase: "completed",
			updatedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			lastOutcome: `Committed and pushed PR review fixes to ${state.pushRemote}/${state.branch}.`,
			lastError: undefined,
		});
		notify(ctx, `Committed and pushed PR review fixes for #${state.pr.number} to ${state.pushRemote}/${state.branch}.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await applyState(ctx, {
			...(getStateOrLoad(ctx) ?? state),
			active: false,
			phase: "failed",
			updatedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			lastOutcome: "Automatic commit/push failed.",
			lastError: message,
		});
		notify(ctx, `PR review fix failed during automatic completion: ${message}`, "error");
	}
}

export const __testables = {
	PR_REVIEW_JSON_FIELDS,
	getState,
	loadPersistedState,
	applyState,
	clearState,
	collectBotFindingsFromPullRequest,
	buildRepairPrompt,
	buildStatusBody,
	finalizeActiveRun,
	normalizePullRequestIdentity,
	isActionableFeedbackText,
	detectReviewerKind,
	getAgentRunFailure,
	resolvePushRemote,
};

export default function prReviewCycleExtension(pi: ExtensionAPI) {
	for (const eventName of ["session_start", "session_switch", "session_tree"] as const) {
		pi.on?.(eventName, async (_event, ctx) => {
			const state = getStateOrLoad(ctx);
			applyFooterStatus(ctx, state);
		});
	}

	pi.on?.("agent_end", async (event, ctx) => {
		const state = getStateOrLoad(ctx);
		if (!state?.active || state.sourceCommand !== "pr-review-fix") return;

		const failure = getAgentRunFailure(event?.messages);
		if (failure) {
			const wasAborted = failure.stopReason === "aborted";
			const outcome = wasAborted
				? "Agent run was aborted; skipped automatic commit/push."
				: "Agent run failed; skipped automatic commit/push.";
			await applyState(ctx, {
				...state,
				active: false,
				phase: "failed",
				updatedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				lastOutcome: outcome,
				lastError: failure.errorMessage,
			});
			notify(
				ctx,
				wasAborted
					? `PR review fix for #${state.pr.number} was aborted; skipped automatic commit/push.`
					: `PR review fix for #${state.pr.number} ended with an agent error; skipped automatic commit/push.`,
				wasAborted ? "warning" : "error",
			);
			return;
		}

		await finalizeActiveRun(pi, ctx);
	});

	pi.registerCommand("pr-review-fix", {
		description: "Gather GitHub bot review feedback for the current PR and run a focused repair pass",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				notify(ctx, "Wait for the current agent run to finish before starting /pr-review-fix.", "warning");
				return;
			}

			const existing = getStateOrLoad(ctx);
			if (existing?.active) {
				notify(ctx, `A PR review fix run for #${existing.pr.number} is already active. Use /pr-review-status or /pr-review-clear first.`, "warning");
				applyFooterStatus(ctx, existing);
				return;
			}

			try {
				applyFooterStatus(ctx, {
					active: true,
					sourceCommand: "pr-review-fix",
					repoRoot: ctx.cwd,
					localBranch: "(detecting)",
					branch: "(detecting)",
					pushRemote: "(detecting)",
					pr: { number: 0, url: "(detecting)", title: "(detecting)", headRefName: "(detecting)" },
					phase: "preflight",
					findingsGathered: 0,
					findingsSelected: 0,
					pushPolicy: "auto-commit-and-push",
					commitMessage: "",
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				});

				const repoRoot = await ensureGitRepo(pi, ctx.cwd);
				await ensureGhAvailable(pi, repoRoot);
				await ensureGhAuthenticated(pi, repoRoot);
				const branch = await getCurrentBranch(pi, repoRoot);
				await ensureCleanWorkingTree(pi, repoRoot);
				const rawPr = await fetchCurrentPrReviewData(pi, repoRoot);
				const pr = normalizePullRequestIdentity(rawPr);
				const findings = collectBotFindingsFromPullRequest(rawPr);
				const commitMessage = `pr-review: address AI review feedback for #${pr.number}`;

				if (findings.length === 0) {
					applyFooterStatus(ctx, undefined);
					notify(ctx, `No actionable CodeRabbit or Codex findings remain on PR #${pr.number}; no repair run started.`, "info");
					return;
				}

				const pushRemote = await resolvePushRemote(pi, repoRoot, branch);
				const state: PrReviewRunState = {
					active: true,
					sourceCommand: "pr-review-fix",
					repoRoot,
					localBranch: branch,
					branch: pr.headRefName || branch,
					pushRemote,
					pr,
					phase: "awaiting-agent",
					findingsGathered: findings.length,
					findingsSelected: findings.length,
					pushPolicy: "auto-commit-and-push",
					commitMessage,
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					lastOutcome: `Queued repair prompt with ${findings.length} findings.`,
				};
				await applyState(ctx, state);
				pi.sendUserMessage(buildRepairPrompt(pr, findings));
				notify(ctx, `Queued PR review repair pass for #${pr.number} with ${findings.length} finding(s).`, "info");
			} catch (error) {
				applyFooterStatus(ctx, undefined);
				const message = error instanceof Error ? error.message : String(error);
				const activeState = getState(ctx);
				if (activeState?.active) {
					await applyState(ctx, {
						...activeState,
						active: false,
						phase: "failed",
						updatedAt: new Date().toISOString(),
						finishedAt: new Date().toISOString(),
						lastOutcome: "Failed to queue PR review repair run.",
						lastError: message,
					});
				}
				notify(ctx, message, "error");
			}
		},
	});

	pi.registerCommand("pr-review-status", {
		description: "Show the current PR review fix workflow status",
		handler: async (_args, ctx) => {
			const state = getStateOrLoad(ctx);
			if (!state) {
				notify(ctx, "No PR review fix state is available.", "info");
				applyFooterStatus(ctx, undefined);
				return;
			}
			applyFooterStatus(ctx, state);
			if (typeof pi.sendMessage === "function") pi.sendMessage({ customType: "pr-review-status", content: buildStatusBody(state), display: true }, { triggerTurn: false });
			else notify(ctx, `PR review #${state.pr.number}: ${state.phase}`, "info");
		},
	});

	pi.registerCommand("pr-review-clear", {
		description: "Clear persisted PR review fix state and footer status",
		handler: async (_args, ctx) => {
			await clearState(ctx);
			notify(ctx, "Cleared PR review fix state.", "info");
		},
	});
}
