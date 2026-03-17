import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractExecutionContract } from "./planning/contract-extractor.ts";
import { buildExecutionContractPath, buildRawPlanPath, renderRawPlanMarkdown } from "./planning/raw-artifact.ts";
import { renderMarkdownFromExecutionContract } from "./planning/contract-render.ts";
import type { ExecutionContract } from "./planning/contract-schema.ts";
import {
	extractOpenQuestionsFromRawPlan,
	formatAnsweredQuestions,
	formatQuestionsForFollowup,
	mergeQuestions,
	type PlanningQuestion,
} from "./planning/question-loop.ts";
import { PlanningQnAComponent } from "./planning/question-ui.ts";

type RelevantFile = { path: string; reason: string };

type PlanningSource = {
	kind: "scratch" | "file" | "link";
	value: string;
};

type PlanningState = {
	active: boolean;
	title: string;
	slug: string;
	originalInput: string;
	repoRoot: string;
	repoContextSummary?: string;
	relevantFiles: RelevantFile[];
	rawDraft?: string;
	questions: PlanningQuestion[];
	contract?: ExecutionContract;
	savedPath?: string;
	savedContractPath?: string;
	source?: PlanningSource;
};

const PLANNING_STATE_TYPE = "planning-session";

function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	if (typeof ctx?.notify === "function") ctx.notify(message, level);
	else if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, level);
	else if (typeof ctx?.pi?.sendMessage === "function") ctx.pi.sendMessage({ content: message, display: true }, { triggerTurn: false });
}

function getState(ctx: any): PlanningState | undefined {
	return ctx?.state?.planning;
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
	if (entry.type === PLANNING_STATE_TYPE && Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
}

function setState(ctx: any, state: PlanningState | undefined) {
	if (!ctx.state) ctx.state = {};
	ctx.state.planning = state;
}

function loadPersistedState(ctx: any): PlanningState | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!(entry?.type === "custom" && entry?.customType === PLANNING_STATE_TYPE) && entry?.type !== PLANNING_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data || data.active === false) return undefined;
		setState(ctx, data as PlanningState);
		return data as PlanningState;
	}
	return undefined;
}

async function applyState(ctx: any, state: PlanningState): Promise<PlanningState> {
	setState(ctx, state);
	appendCustomEntry(ctx.pi ?? ctx, PLANNING_STATE_TYPE, state);
	return state;
}

async function clearState(ctx: any): Promise<void> {
	setState(ctx, undefined);
	appendCustomEntry(ctx.pi ?? ctx, PLANNING_STATE_TYPE, { active: false });
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function detectRepoRoot(cwd: string): Promise<string> {
	let current = path.resolve(cwd);
	while (true) {
		if (await exists(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

async function collectRepoSummary(repoRoot: string): Promise<{ repoContextSummary: string; relevantFiles: RelevantFile[] }> {
	const files = (await fs.readdir(repoRoot)).slice(0, 12);
	return {
		repoContextSummary: `- Repo root: ${repoRoot}\n- Top-level entries: ${files.join(", ") || "(none detected)"}`,
		relevantFiles: [],
	};
}

function titleCaseFirst(input: string): string {
	return input ? input.charAt(0).toUpperCase() + input.slice(1) : input;
}

function isProbablyUrl(input: string): boolean {
	return /^https?:\/\//i.test(input.trim());
}

function truncateForPrompt(text: string, maxChars = 12000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function slugifyPart(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function composeSlug(parts: Array<string | undefined>, maxLength = 96): string {
	const normalized: string[] = [];
	for (const part of parts) {
		const slug = slugifyPart(part ?? "");
		if (!slug) continue;
		if (normalized[normalized.length - 1] === slug) continue;
		normalized.push(slug);
	}
	const composed = normalized.join("-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return composed.slice(0, maxLength).replace(/-+$/g, "") || "plan";
}

function stripFileExtension(filePath: string): string {
	return filePath.replace(/\.[^.]+$/g, "");
}

function extractPrimaryHeading(text: string): string | undefined {
	const frontmatterTitle = text.match(/^(?:---\n[\s\S]*?\n)?title:\s*(.+)$/im)?.[1]?.trim();
	if (frontmatterTitle) return frontmatterTitle;
	const markdownHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? text.match(/^##\s+(.+)$/m)?.[1]?.trim();
	return markdownHeading || undefined;
}

function cleanDerivedTitle(title: string): string {
	return title.replace(/\s+/g, " ").replace(/^\s*#\s*/, "").replace(/^plan:\s*/i, "").trim();
}

function stripGithubTitleSuffix(title: string): string {
	return title
		.replace(/\s*[·|]\s*GitHub\s*$/i, "")
		.replace(/\s*[·|]\s*[^·|]+\/[^·|]+\s*$/i, "")
		.replace(/\s*[·|]\s*[^·|]+\s*[·|]\s*GitHub\s*$/i, "")
		.trim();
}

function parseGithubWorkItemLink(link: string): { owner: string; repo: string; kind: "issue" | "pr"; number: string } | undefined {
	try {
		const url = new URL(link);
		if (!/^(www\.)?github\.com$/i.test(url.hostname)) return undefined;
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length < 4) return undefined;
		const [owner, repo, type, number] = parts;
		if (!owner || !repo || !number) return undefined;
		if (type === "issues") return { owner, repo, kind: "issue", number };
		if (type === "pull") return { owner, repo, kind: "pr", number };
		return undefined;
	} catch {
		return undefined;
	}
}

async function fetchLinkTitle(link: string): Promise<string | undefined> {
	if (typeof fetch !== "function") return undefined;
	try {
		const response = await fetch(link, {
			headers: {
				"user-agent": "pi-extensions-plan/0.1",
				accept: "text/html,application/xhtml+xml",
			},
		});
		if (!response.ok) return undefined;
		const html = await response.text();
		const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim();
		if (ogTitle) return cleanDerivedTitle(stripGithubTitleSuffix(ogTitle));
		const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
		if (!title) return undefined;
		return cleanDerivedTitle(stripGithubTitleSuffix(title));
	} catch {
		return undefined;
	}
}

function deriveTitleFromLink(link: string): string {
	const github = parseGithubWorkItemLink(link);
	if (github) return `${github.kind === "pr" ? "PR" : "Issue"} ${github.number}`;
	try {
		const url = new URL(link);
		const tail = url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
		return titleCaseFirst(tail.replace(/[-_]+/g, " ")) || "Plan from link";
	} catch {
		return "Plan from link";
	}
}

function deriveSmartLinkIdentity(link: string, fetchedTitle?: string): { title: string; slug: string } {
	const github = parseGithubWorkItemLink(link);
	const cleanFetchedTitle = fetchedTitle ? cleanDerivedTitle(stripGithubTitleSuffix(fetchedTitle)) : undefined;
	if (github) {
		const title = cleanFetchedTitle ? `${github.kind === "pr" ? "PR" : "Issue"} ${github.number}: ${cleanFetchedTitle}` : deriveTitleFromLink(link);
		return {
			title,
			slug: composeSlug([github.repo, github.kind, github.number, cleanFetchedTitle]),
		};
	}
	try {
		const url = new URL(link);
		const tail = url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
		const baseTitle = cleanFetchedTitle || deriveTitleFromLink(link);
		return {
			title: baseTitle,
			slug: composeSlug([url.hostname.replace(/^www\./i, ""), tail, baseTitle]),
		};
	} catch {
		const baseTitle = cleanFetchedTitle || deriveTitleFromLink(link);
		return { title: baseTitle, slug: composeSlug([baseTitle]) };
	}
}

function deriveSmartFileIdentity(relativePath: string, fileText: string): { title: string; slug: string } {
	const heading = extractPrimaryHeading(fileText);
	const fallbackTitle = derivePlanTitleFromPath(relativePath);
	const title = cleanDerivedTitle(heading || fallbackTitle) || fallbackTitle;
	const relativeStem = stripFileExtension(relativePath).replace(/[\\/]+/g, "-");
	return {
		title: titleCaseFirst(title),
		slug: composeSlug([relativeStem, title]),
	};
}

function derivePlanTitleFromPath(filePath: string): string {
	return path.basename(filePath).replace(/\.plan\.md$/i, "").replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "plan";
}

function extractRequestedFeature(rawDraft: string, fallback: string): string {
	return rawDraft.match(/^##\s+Requested feature\s*\n([\s\S]*?)(?:\n##\s+|$)/im)?.[1]?.replace(/\s+/g, " ").trim() || fallback;
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : text + "\n";
}

function resolvePathWithinRepo(repoRoot: string, candidatePath: string): { absolutePath: string; relativePath: string } | undefined {
	const absolutePath = path.resolve(repoRoot, candidatePath);
	const relativePath = path.relative(repoRoot, absolutePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
	return { absolutePath, relativePath };
}

async function persistRawPlanDraft(repoRoot: string, rawRelativePath: string, rawDraft: string): Promise<string> {
	const resolvedPath = resolvePathWithinRepo(repoRoot, rawRelativePath);
	if (!resolvedPath) throw new Error(`Refusing to write raw plan outside the repository root: ${rawRelativePath}`);
	const rawAbsolutePath = resolvedPath.absolutePath;
	await fs.mkdir(path.dirname(rawAbsolutePath), { recursive: true });
	await fs.writeFile(rawAbsolutePath, ensureTrailingNewline(rawDraft), "utf8");
	return rawAbsolutePath;
}

type ResolvedPlanSaveInput = {
	rawRelativePath: string;
	rawAbsolutePath: string;
	rawDraft: string;
	title: string;
	originalInput: string;
	repoContextSummary?: string;
	relevantFiles: RelevantFile[];
	source: "requested-file" | "requested-state" | "active-file" | "active-state";
};

async function resolvePlanSaveInput(input: {
	repoRoot: string;
	state?: PlanningState;
	requestedPath?: string;
}): Promise<ResolvedPlanSaveInput | undefined> {
	const { repoRoot, state } = input;
	const requestedPath = input.requestedPath?.trim();
	let repoContextSummary = state?.repoContextSummary;
	let relevantFiles = state?.relevantFiles ?? [];
	const ensureRepoContext = async () => {
		if (!repoContextSummary) {
			const collected = await collectRepoSummary(repoRoot);
			repoContextSummary = collected.repoContextSummary;
			relevantFiles = collected.relevantFiles;
		}
	};

	if (requestedPath) {
		const resolvedPath = resolvePathWithinRepo(repoRoot, requestedPath);
		if (!resolvedPath) throw new Error(`Requested path must stay within the repository root: ${requestedPath}`);
		const { absolutePath: rawAbsolutePath, relativePath: rawRelativePath } = resolvedPath;
		if (await exists(rawAbsolutePath)) {
			const rawDraft = await fs.readFile(rawAbsolutePath, "utf8");
			await ensureRepoContext();
			const title = cleanDerivedTitle(extractPrimaryHeading(rawDraft) ?? derivePlanTitleFromPath(rawRelativePath)) || derivePlanTitleFromPath(rawRelativePath);
			return {
				rawRelativePath,
				rawAbsolutePath,
				rawDraft,
				title,
				originalInput: extractRequestedFeature(rawDraft, state?.originalInput ?? title),
				repoContextSummary,
				relevantFiles,
				source: "requested-file",
			};
		}
		if (state?.active && state.rawDraft) {
			await ensureRepoContext();
			const title = state.title || derivePlanTitleFromPath(rawAbsolutePath);
			return {
				rawRelativePath,
				rawAbsolutePath,
				rawDraft: state.rawDraft,
				title,
				originalInput: state.originalInput || title,
				repoContextSummary,
				relevantFiles,
				source: "requested-state",
			};
		}
		return undefined;
	}

	if (!state?.active || !state.rawDraft) return undefined;
	const rawRelativePath = state.savedPath ?? buildRawPlanPath(state.slug);
	const rawAbsolutePath = path.join(repoRoot, rawRelativePath);
	const fileExists = await exists(rawAbsolutePath);
	return {
		rawRelativePath,
		rawAbsolutePath,
		rawDraft: fileExists ? await fs.readFile(rawAbsolutePath, "utf8") : state.rawDraft,
		title: state.title,
		originalInput: state.originalInput,
		repoContextSummary,
		relevantFiles,
		source: fileExists ? "active-file" : "active-state",
	};
}

type StartPlanningOptions = {
	mode: PlanningSource["kind"];
	input: string;
	repoRoot: string;
	repoContextSummary: string;
	relevantFiles: RelevantFile[];
	title: string;
	slug?: string;
	initialDraft: string;
	promptBlocks: string[];
};

async function startPlanningSession(pi: ExtensionAPI, ctx: any, options: StartPlanningOptions): Promise<void> {
	const slug = options.slug || slugify(options.title || options.input);
	const rawPlanPath = buildRawPlanPath(slug);
	const state: PlanningState = {
		active: true,
		title: options.title,
		slug,
		originalInput: options.input,
		repoRoot: options.repoRoot,
		repoContextSummary: options.repoContextSummary,
		relevantFiles: options.relevantFiles,
		rawDraft: options.initialDraft,
		questions: extractOpenQuestionsFromRawPlan(options.initialDraft),
		savedPath: rawPlanPath,
		source: { kind: options.mode, value: options.input },
	};
	await applyState({ ...ctx, pi }, state);
	try {
		await persistRawPlanDraft(options.repoRoot, rawPlanPath, options.initialDraft);
	} catch (error) {
		notify(ctx, `Could not initialize the raw plan draft at ${rawPlanPath}: ${(error as Error).message}`, "warning");
	}
	notify(ctx, `Planning started. Canonical draft path: ${rawPlanPath}. Refine that draft, then run /plan-save.`, "info");
	if (typeof pi.sendUserMessage === "function") pi.sendUserMessage(options.promptBlocks.join("\n\n"));
}

async function maybeAskClarifyingQuestions(pi: ExtensionAPI, state: PlanningState): Promise<void> {
	const openQuestions = state.questions.filter((question) => question.status === "open");
	if (openQuestions.length === 0) return;
	if (typeof pi.sendUserMessage !== "function") return;
	const answered = formatAnsweredQuestions(state.questions);
	pi.sendUserMessage([
		"Before finalizing the raw plan, ask the user only the following open questions and wait for answers.",
		formatQuestionsForFollowup(openQuestions),
		answered ? `Already answered questions:\n\n${answered}` : "",
	].filter(Boolean).join("\n\n"));
}

async function maybeContinuePlanningTowardReady(pi: ExtensionAPI, contract: ExecutionContract): Promise<void> {
	if (contract.status === "ready") return;
	if (typeof pi.sendUserMessage !== "function") return;
	const blockingAmbiguities = contract.ambiguities.filter((item) => item.blocksExecution).map((item) => `- ${item.text}`);
	const blockingIssues = contract.contractIssues.map((item) => `- ${item}`);
	const advisoryNotes = (contract.advisoryNotes ?? []).map((item) => `- ${item}`);
	pi.sendUserMessage([
		`The extracted execution contract is still ${contract.status}. Continue the planning loop and revise the raw plan so the next extraction can become ready.`,
		blockingIssues.length > 0 ? `Resolve these blocking contract issues:\n${blockingIssues.join("\n")}` : "",
		blockingAmbiguities.length > 0 ? `Resolve these blocking ambiguities or ask the user concise clarifying questions:\n${blockingAmbiguities.join("\n")}` : "",
		advisoryNotes.length > 0 ? `Non-blocking advisory notes (do not keep the contract draft just because of these):\n${advisoryNotes.join("\n")}` : "",
		"Keep strong existing requirements/checks. Only ask the user for information that is actually required to make the contract execution-ready.",
		"When information is still missing, end with a concise `## Open questions` section.",
	].filter(Boolean).join("\n\n"));
}

function extractAssistantText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n");
	return "";
}

export const __testables = {
	slugify,
	slugifyPart,
	composeSlug,
	titleCaseFirst,
	isProbablyUrl,
	truncateForPrompt,
	extractPrimaryHeading,
	deriveTitleFromLink,
	deriveSmartLinkIdentity,
	deriveSmartFileIdentity,
	parseGithubWorkItemLink,
	renderRawPlanMarkdown,
	buildRawPlanPath,
	buildExecutionContractPath,
	derivePlanTitleFromPath,
	extractRequestedFeature,
	resolvePathWithinRepo,
	persistRawPlanDraft,
	resolvePlanSaveInput,
	extractAssistantText,
	getState,
	loadPersistedState,
	applyState,
	clearState,
};

export default function planExtension(pi: ExtensionAPI) {
	pi.on?.("session_start", async (_event, ctx) => {
		loadPersistedState(ctx);
	});
	pi.on?.("session_switch", async (_event, ctx) => {
		loadPersistedState(ctx);
	});
	pi.on?.("session_tree", async (_event, ctx) => {
		loadPersistedState(ctx);
	});

	const startFromScratch = async (input: string, ctx: any, commandName = "plan") => {
		if (!input) {
			notify(ctx, `Usage: /${commandName} <feature brief>`, "warning");
			return;
		}
		notify(ctx, "Collecting planning context...", "info");
		const repoRoot = await detectRepoRoot(ctx.cwd ?? process.cwd());
		const { repoContextSummary, relevantFiles } = await collectRepoSummary(repoRoot);
		const title = titleCaseFirst(input);
		const slug = slugify(title);
		const initialDraft = renderRawPlanMarkdown({
			title,
			requestedFeature: input,
			repoContextSummary,
		});
		await startPlanningSession(pi, ctx, {
			mode: "scratch",
			input,
			repoRoot,
			repoContextSummary,
			relevantFiles,
			title,
			slug,
			initialDraft,
			promptBlocks: [
				"You are in planning mode.",
				"Produce a rich raw plan artifact in markdown.",
				"Do not force one rigid schema.",
				"Be explicit about evidence, intended behavior, ambiguities, and checks.",
				"If key information is missing, include a concise `## Open questions` section with only high-value clarifications.",
				`Canonical raw plan path: ${buildRawPlanPath(slug)}`,
				"If you write the plan to disk, keep it at that canonical path unless the user explicitly asks for a different location.",
				"Avoid creating a separate docs/ planning file by default; /plan-save without arguments will use the canonical draft path above.",
				`Requested feature: ${input}`,
				repoContextSummary,
			],
		});
	};

	const startFromFile = async (input: string, ctx: any) => {
		if (!input) {
			notify(ctx, "Usage: /plan-from-file <path>", "warning");
			return;
		}
		notify(ctx, "Collecting planning context...", "info");
		const repoRoot = await detectRepoRoot(ctx.cwd ?? process.cwd());
		const resolvedPath = resolvePathWithinRepo(repoRoot, input);
		if (!resolvedPath) {
			notify(ctx, `Source file must stay within the repository root: ${input}`, "warning");
			return;
		}
		const { absolutePath, relativePath } = resolvedPath;
		if (!(await exists(absolutePath))) {
			notify(ctx, `Source file not found: ${absolutePath}`, "warning");
			return;
		}
		const { repoContextSummary, relevantFiles } = await collectRepoSummary(repoRoot);
		const fileText = await fs.readFile(absolutePath, "utf8");
		const identity = deriveSmartFileIdentity(relativePath, fileText);
		const requestedFeature = `Plan the work described in ${relativePath}`;
		const initialDraft = renderRawPlanMarkdown({
			title: identity.title,
			requestedFeature,
			repoContextSummary,
			sections: [{ heading: "Primary source", items: [`File: ${relativePath}`] }],
		});
		await startPlanningSession(pi, ctx, {
			mode: "file",
			input: relativePath,
			repoRoot,
			repoContextSummary,
			relevantFiles,
			title: identity.title,
			slug: identity.slug,
			initialDraft,
			promptBlocks: [
				"You are in planning mode.",
				"Use the supplied repository file as the primary planning source.",
				"Read it carefully and extract requirements, intended behavior, constraints, evidence, and checks.",
				"Do not force one rigid schema.",
				"If key information is missing, include a concise `## Open questions` section with only high-value clarifications.",
				`Canonical raw plan path: ${buildRawPlanPath(identity.slug)}`,
				`Primary source file: ${relativePath}`,
				repoContextSummary,
				["Source file contents:", "```", truncateForPrompt(fileText), "```"].join("\n"),
			],
		});
	};

	const startFromLink = async (input: string, ctx: any) => {
		if (!input) {
			notify(ctx, "Usage: /plan-from-link <url>", "warning");
			return;
		}
		if (!isProbablyUrl(input)) {
			notify(ctx, `Expected a URL, got: ${input}`, "warning");
			return;
		}
		notify(ctx, "Collecting planning context...", "info");
		const repoRoot = await detectRepoRoot(ctx.cwd ?? process.cwd());
		const { repoContextSummary, relevantFiles } = await collectRepoSummary(repoRoot);
		const fetchedTitle = await fetchLinkTitle(input);
		const identity = deriveSmartLinkIdentity(input, fetchedTitle);
		const requestedFeature = `Plan the work described at ${input}`;
		const initialDraft = renderRawPlanMarkdown({
			title: identity.title,
			requestedFeature,
			repoContextSummary,
			sections: [{ heading: "Primary source", items: [`Link: ${input}`] }],
		});
		await startPlanningSession(pi, ctx, {
			mode: "link",
			input,
			repoRoot,
			repoContextSummary,
			relevantFiles,
			title: identity.title,
			slug: identity.slug,
			initialDraft,
			promptBlocks: [
				"You are in planning mode.",
				"Use the supplied link as the primary planning source.",
				"Fetch/read the link before drafting the plan.",
				"If it is a GitHub issue or PR, extract the title, problem statement, acceptance criteria, constraints, referenced files, and unresolved questions.",
				"Be explicit about evidence, intended behavior, ambiguities, and checks.",
				"Do not force one rigid schema.",
				"If key information is missing, include a concise `## Open questions` section with only high-value clarifications.",
				`Canonical raw plan path: ${buildRawPlanPath(identity.slug)}`,
				`Primary source link: ${input}`,
				repoContextSummary,
			],
		});
	};

	pi.registerCommand("plan", {
		description: "Start a planning session from a brief or URL",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (isProbablyUrl(input)) {
				notify(ctx, "Detected a link. Starting link-based planning.", "info");
				await startFromLink(input, ctx);
				return;
			}
			await startFromScratch(input, ctx, "plan");
		},
	});

	pi.registerCommand("plan-from-scratch", {
		description: "Start a planning session from a feature brief",
		handler: async (args, ctx) => {
			await startFromScratch((args ?? "").trim(), ctx, "plan-from-scratch");
		},
	});

	pi.registerCommand("plan-from-file", {
		description: "Start a planning session from a local file",
		handler: async (args, ctx) => {
			await startFromFile((args ?? "").trim(), ctx);
		},
	});

	pi.registerCommand("plan-from-link", {
		description: "Start a planning session from a URL such as a GitHub issue",
		handler: async (args, ctx) => {
			await startFromLink((args ?? "").trim(), ctx);
		},
	});

	pi.on?.("turn_end", async (event, ctx) => {
		const state = getState(ctx) ?? loadPersistedState(ctx);
		if (!state?.active) return;
		const text = extractAssistantText((event as any)?.message).trim();
		if (!text) return;
		if (/^# /m.test(text) || /^## /m.test(text)) {
			const extractedQuestions = extractOpenQuestionsFromRawPlan(text);
			const rawPlanPath = state.savedPath ?? buildRawPlanPath(state.slug);
			const nextState = await applyState({ ...ctx, pi }, {
				...state,
				rawDraft: text,
				questions: mergeQuestions(state.questions, extractedQuestions),
				savedPath: rawPlanPath,
			});
			try {
				await persistRawPlanDraft(nextState.repoRoot, rawPlanPath, text);
			} catch {
				// Best-effort sync only; plan-save still falls back to in-memory draft.
			}
			await maybeAskClarifyingQuestions(pi, nextState);
		}
	});

	pi.registerCommand("plan-answer", {
		description: "Provide answers to open planning questions",
		handler: async (args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			if (!state?.active) {
				notify(ctx, "No active planning session.", "warning");
				return;
			}
			const applyAnswers = async (input: string) => {
				const blocks = input.split(/\n\s*\n+/);
				const answers = new Map<string, string>();
				for (const block of blocks) {
					const q = block.match(/(?:^|\n)Q:\s*(.+)/i)?.[1]?.trim();
					const a = block.match(/(?:^|\n)A:\s*([\s\S]+)/i)?.[1]?.trim();
					if (q && a) answers.set(q.toLowerCase(), a);
				}
				const nextQuestions = state.questions.map((question) => {
					const answer = answers.get(question.question.trim().toLowerCase()) ?? question.answer;
					return {
						...question,
						answer,
						status: answer?.trim() ? "answered" : question.status,
					};
				});
				await applyState({ ...ctx, pi }, { ...state, questions: nextQuestions });
				if (typeof pi.sendMessage === "function") {
					pi.sendMessage({
						customType: "planning-answers",
						content: "I answered the planning questions:\n\n" + formatAnsweredQuestions(nextQuestions),
						display: true,
					}, { triggerTurn: true });
				}
				notify(ctx, "Saved planning answers and asked the planner to continue.", "info");
			};
			const input = (args ?? "").trim();
			if (!input && ctx.hasUI && typeof ctx.ui.custom === "function") {
				const openQuestions = state.questions.filter((q) => q.status === "open");
				if (openQuestions.length === 0) {
					notify(ctx, "No open planning questions.", "info");
					return;
				}
				const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => new PlanningQnAComponent(openQuestions, tui, done));
				if (answersResult === null) {
					notify(ctx, "Cancelled", "info");
					return;
				}
				await applyAnswers(answersResult);
				return;
			}
			if (!input) {
				notify(ctx, "Usage: /plan-answer Q: <question>\nA: <answer> ...", "warning");
				return;
			}
			await applyAnswers(input);
		},
	});

	pi.registerCommand("plan-save", {
		description: "Save the raw plan and extract an execution contract",
		handler: async (args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			try {
				const requestedPath = (args ?? "").trim();
				const repoRoot = state?.repoRoot ?? await detectRepoRoot(ctx.cwd ?? process.cwd());
				const resolved = await resolvePlanSaveInput({
					repoRoot,
					state,
					requestedPath,
				});
				if (!resolved) {
					notify(ctx, "No active planning draft to save. Pass an existing .plan.md path to /plan-save or start /plan first.", "warning");
					return;
				}

				const {
					rawRelativePath,
					rawAbsolutePath,
					rawDraft,
					title,
					originalInput,
					repoContextSummary,
					relevantFiles,
					source,
				} = resolved;
				const contractRelativePath = buildExecutionContractPath(rawRelativePath);
				const contractAbsolutePath = path.join(repoRoot, contractRelativePath);
				await fs.mkdir(path.dirname(rawAbsolutePath), { recursive: true });
				if (requestedPath && source === "requested-state") notify(ctx, `Saving the current planning draft to ${rawRelativePath}.`, "info");
				notify(ctx, "Extracting execution contract...", "info");
				const contract = await extractExecutionContract(ctx as any, {
					rawArtifactPath: rawRelativePath,
					rawArtifactKind: "markdown",
					rawArtifactText: rawDraft,
					repoContextSummary,
					relevantFiles,
				});
				const finalContract = contract ?? {
					artifactType: "execution-contract" as const,
					version: 1 as const,
					generatedAt: new Date().toISOString(),
					source: { rawArtifactPath: rawRelativePath, rawArtifactKind: "markdown" as const },
					goal: originalInput,
					requirements: [],
					checks: [],
					ambiguities: [],
					evidence: relevantFiles,
					outOfScope: [],
					status: "draft" as const,
					contractIssues: ["Execution contract extraction failed."],
					advisoryNotes: [],
				};
				const renderedRaw = finalContract.status === "ready" ? renderMarkdownFromExecutionContract(finalContract, title) : rawDraft;
				await persistRawPlanDraft(repoRoot, rawRelativePath, renderedRaw);
				await fs.writeFile(contractAbsolutePath, JSON.stringify(finalContract, null, 2) + "\n", "utf8");
				await applyState({ ...ctx, pi }, {
					active: true,
					title,
					slug: state?.slug ?? slugify(title),
					originalInput,
					repoRoot,
					repoContextSummary,
					relevantFiles,
					rawDraft: renderedRaw,
					questions: state?.questions ?? extractOpenQuestionsFromRawPlan(renderedRaw),
					contract: finalContract,
					savedPath: rawRelativePath,
					savedContractPath: contractRelativePath,
					source: state?.source,
				});
				notify(ctx, `Raw plan saved: ${rawRelativePath}`, "info");
				notify(ctx, `Execution contract saved: ${contractRelativePath}`, "info");
				if (finalContract.status !== "ready") {
					const detail = [
						finalContract.contractIssues.length > 0 ? `Blocking issues: ${finalContract.contractIssues.join(" ")}` : "",
						(finalContract.advisoryNotes?.length ?? 0) > 0 ? `Advisory notes: ${finalContract.advisoryNotes.join(" ")}` : "",
					].filter(Boolean).join(" ");
					notify(ctx, `Execution contract is ${finalContract.status}.${detail ? ` ${detail}` : ""}`, "warning");
					await maybeContinuePlanningTowardReady(pi, finalContract);
				} else if ((finalContract.advisoryNotes?.length ?? 0) > 0) {
					notify(ctx, `Execution contract is ready. Advisory notes: ${finalContract.advisoryNotes.join(" ")}`, "info");
				}
			} catch (error) {
				notify(ctx, `plan-save failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show the current planning state",
		handler: async (_args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			if (!state?.active) {
				notify(ctx, "No active planning session.", "warning");
				return;
			}
			const openQuestions = state.questions.filter((q) => q.status === "open").length;
			const answeredQuestions = state.questions.filter((q) => q.status === "answered").length;
			const contractStatus = state.contract ? ` | contract: ${state.contract.status}` : "";
			const rawPlanPath = state.savedPath ? ` | draft: ${state.savedPath}` : "";
			const source = state.source ? ` | source: ${state.source.kind}=${state.source.value}` : "";
			notify(ctx, `Planning active: ${state.title} | open questions: ${openQuestions} | answered: ${answeredQuestions}${contractStatus}${rawPlanPath}${source}`, "info");
		},
	});

	pi.registerCommand("plan-next", {
		description: "Show the saved execution contract path for the next implementation step",
		handler: async (_args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			if (!state?.savedContractPath) {
				notify(ctx, "No saved execution contract. Run /plan-save first.", "warning");
				return;
			}
			notify(ctx, `Saved execution contract: ${state.savedContractPath}`, "info");
		},
	});

	pi.registerCommand("end-planning", {
		description: "End the active planning session",
		handler: async (_args, ctx) => {
			await clearState({ ...ctx, pi });
			notify(ctx, "Planning ended.", "info");
		},
	});
}
