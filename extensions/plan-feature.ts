import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type PlanningStatus = "collecting-context" | "clarifying" | "drafting" | "finalized";

type RelevantFile = {
	path: string;
	reason: string;
	preview?: string;
	score?: number;
};

type PlanningQuestion = {
	id: string;
	question: string;
	answer?: string;
	status: "open" | "answered" | "skipped";
};

type PlanningSessionState = {
	active: boolean;
	originId?: string;
	planningEntryId?: string;
	id: string;
	title: string;
	slug: string;
	originalInput: string;
	sourcePlanPath?: string;
	status: PlanningStatus;
	repoRoot: string;
	createdAt: string;
	updatedAt: string;
	repoContextSummary?: string;
	relevantFiles: RelevantFile[];
	questions: PlanningQuestion[];
	assumptions: string[];
	decisions: string[];
	currentDraft?: string;
	savedPath?: string;
};

type PlanMarkdownInput = {
	title: string;
	originalInput: string;
	repoContextSummary?: string;
	recommendedSplit?: string[];
	problemStatement?: string;
	scope?: string[];
	outOfScope?: string[];
	decisions?: string[];
	assumptions?: string[];
	openQuestions?: string[];
	acceptanceCriteria?: string[];
	edgeCases?: string[];
};

const PLANNING_STATE_TYPE = "planning-session";
const PLANNING_ANCHOR_TYPE = "planning-anchor";
const PLANNING_DRAFT_TYPE = "planning-draft";
const PLANNING_METADATA_TYPE = "planning-metadata";
const PLANNING_WIDGET_ID = "planning";

let activePlanningState: PlanningSessionState | undefined;
let lastPersistedStateJson: string | undefined;
let lastPersistedDraftJson: string | undefined;

let writeFileImpl = fs.writeFile.bind(fs);
let mkdirImpl = fs.mkdir.bind(fs);

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/\.md$/i, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "plan";
}

function titleFromInput(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "Feature plan";
	const base = path.basename(trimmed).replace(/\.md$/i, "");
	const source = /\s/.test(base) || trimmed === base ? trimmed : base;
	return source.charAt(0).toUpperCase() + source.slice(1);
}

function getStateContainer(ctx: any): Record<string, any> {
	if (!ctx.state) ctx.state = {};
	return ctx.state;
}

function getSessionEntries(ctx: any): any[] {
	return ctx?.sessionManager?.getEntries?.() ?? [];
}

function getCustomEntryData(entry: any): any | undefined {
	if (!entry || entry.type !== "custom") return undefined;
	return entry.data;
}

function appendCustomEntry(target: any, customType: string, data: unknown): any {
	const appendEntry = target?.appendEntry;
	if (typeof appendEntry !== "function") return undefined;
	if (appendEntry.length >= 2) {
		return appendEntry(customType, data);
	}
	return appendEntry({ type: customType, value: data });
}

function getPlanningState(ctx: any): PlanningSessionState | undefined {
	const container = getStateContainer(ctx);
	if (Object.prototype.hasOwnProperty.call(container, "planning")) {
		return container.planning;
	}
	return undefined;
}

function loadPersistedPlanningState(ctx: any): PlanningSessionState | undefined {
	const entries = getSessionEntries(ctx);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry?.customType !== PLANNING_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data || data.active === false) return undefined;
		activePlanningState = data as PlanningSessionState;
		lastPersistedStateJson = JSON.stringify(activePlanningState);
		lastPersistedDraftJson = activePlanningState.currentDraft
			? JSON.stringify({
				id: activePlanningState.id,
				slug: activePlanningState.slug,
				draft: activePlanningState.currentDraft,
				updatedAt: activePlanningState.updatedAt,
			})
			: undefined;
		getStateContainer(ctx).planning = activePlanningState;
		return activePlanningState;
	}
	return undefined;
}

async function applyPlanningState(ctx: any, state: PlanningSessionState): Promise<PlanningSessionState> {
	activePlanningState = state;
	getStateContainer(ctx).planning = state;
	const stateJson = JSON.stringify(state);
	if (stateJson !== lastPersistedStateJson) {
		appendCustomEntry(ctx.pi ?? ctx, PLANNING_STATE_TYPE, state);
		lastPersistedStateJson = stateJson;
	}
	if (state.currentDraft) {
		const draftPayload = {
			id: state.id,
			slug: state.slug,
			draft: state.currentDraft,
			updatedAt: state.updatedAt,
		};
		const draftJson = JSON.stringify(draftPayload);
		if (draftJson !== lastPersistedDraftJson) {
			appendCustomEntry(ctx.pi ?? ctx, PLANNING_DRAFT_TYPE, draftPayload);
			lastPersistedDraftJson = draftJson;
		}
	}
	return state;
}

async function clearPlanningState(ctx: any): Promise<void> {
	activePlanningState = undefined;
	lastPersistedDraftJson = undefined;
	delete getStateContainer(ctx).planning;
	const clearedJson = JSON.stringify({ active: false });
	if (clearedJson !== lastPersistedStateJson) {
		appendCustomEntry(ctx.pi ?? ctx, PLANNING_STATE_TYPE, { active: false });
		lastPersistedStateJson = clearedJson;
	}
}

async function setPlanningWidget(ctx: any, active: boolean, draftReady: boolean): Promise<void> {
	if (!ctx?.ui) return;
	const text = draftReady
		? "Planning session active (draft ready), return with /end-planning"
		: "Planning session active, return with /end-planning";

	if (!active) {
		if (typeof ctx.ui.clearWidget === "function") {
			ctx.ui.clearWidget(PLANNING_WIDGET_ID);
			return;
		}
		if (typeof ctx.ui.setWidget === "function") {
			if (ctx.ui.setWidget.length >= 2) ctx.ui.setWidget(PLANNING_WIDGET_ID, undefined);
			else ctx.ui.setWidget(undefined);
		}
		return;
	}

	if (typeof ctx.ui.setWidget === "function") {
		if (ctx.ui.setWidget.length >= 2) ctx.ui.setWidget(PLANNING_WIDGET_ID, [text]);
		else ctx.ui.setWidget(text);
	}
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, level);
	else if (typeof ctx?.notify === "function") ctx.notify(message);
}

function sendDisplayMessage(pi: any, content: string): void {
	if (typeof pi?.sendMessage !== "function") return;
	pi.sendMessage({ customType: "planning-status", content, display: true }, { triggerTurn: false });
}

function getCurrentLeafId(ctx: any): string | undefined {
	return ctx?.currentLeafId ?? ctx?.sessionManager?.getLeafId?.() ?? ctx?.sessionManager?.getLeafEntry?.()?.id;
}

async function startPlanningSession(ctx: any, input: string): Promise<PlanningSessionState> {
	const existing = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
	if (existing?.active) {
		notify(ctx, "A planning session is already active. Use /end-planning to finish it first.", "warning");
		throw new Error("A planning session is already active. Use /end-planning to finish it first.");
	}

	let originId = getCurrentLeafId(ctx);
	if (!originId) {
		const anchorResult = appendCustomEntry(ctx.pi ?? ctx, PLANNING_ANCHOR_TYPE, {
			createdAt: new Date().toISOString(),
		});
		originId = anchorResult?.id;
	}

	if (!originId) throw new Error("Failed to determine planning origin");

	const navigationOptions = { summarize: false, label: "feature-planning" };
	if (typeof ctx.navigateFromEntry === "function") ctx.navigateFromEntry(originId, navigationOptions);
	else if (typeof ctx.navigateTree === "function") await ctx.navigateTree(originId, navigationOptions);

	if (typeof ctx?.ui?.setEditorText === "function") ctx.ui.setEditorText("");

	const now = new Date().toISOString();
	const state: PlanningSessionState = {
		active: true,
		originId,
		id: `plan-${Date.now()}`,
		title: titleFromInput(input),
		slug: slugify(titleFromInput(input)),
		originalInput: input,
		status: "collecting-context",
		repoRoot: ctx.cwd ?? process.cwd(),
		createdAt: now,
		updatedAt: now,
		relevantFiles: [],
		questions: [],
		assumptions: [],
		decisions: [],
	};

	await applyPlanningState(ctx, state);
	await setPlanningWidget(ctx, true, false);
	notify(ctx, "Planning started in isolated feature-planning mode.");
	return state;
}

async function restorePlanningStateOnEvent(ctx: any, _event: any): Promise<PlanningSessionState | undefined> {
	const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
	if (state?.active) {
		await setPlanningWidget(ctx, true, Boolean(state.currentDraft));
		return state;
	}
	await setPlanningWidget(ctx, false, false);
	return undefined;
}

function hasUnsavedDraft(state: PlanningSessionState | undefined): boolean {
	if (!state?.active) return false;
	if (!state.currentDraft) return false;
	return !state.savedPath;
}

async function endPlanningSession(ctx: any): Promise<void> {
	const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
	const originId = state?.originId;
	if (!state?.active || !originId) {
		notify(ctx, "No active planning session.", "warning");
		throw new Error("No active planning session");
	}

	if (hasUnsavedDraft(state) && ctx?.hasUI && typeof ctx?.ui?.select === "function") {
		const choice = await ctx.ui.select("You have an unsaved plan:", ["Save plan", "Discard plan"]);
		if (choice === undefined) {
			notify(ctx, "end-planning cancelled", "info");
			return;
		}
		if (choice === "Save plan") {
			const relativePath = path.join(".pi", "plans", `${state.slug}.plan.md`);
			const absolutePath = path.resolve(state.repoRoot, relativePath);
			await mkdirImpl(path.dirname(absolutePath), { recursive: true });
			await writeFileImpl(absolutePath, state.currentDraft.endsWith("\n") ? state.currentDraft : `${state.currentDraft}\n`, "utf8");
			const savedPath = path.relative(state.repoRoot, absolutePath);
			const nextState: PlanningSessionState = {
				...state,
				savedPath,
				status: "finalized",
				updatedAt: new Date().toISOString(),
			};
			appendCustomEntry(ctx.pi ?? ctx, PLANNING_METADATA_TYPE, {
				id: state.id,
				slug: state.slug,
				savedPath,
				updatedAt: nextState.updatedAt,
			});
			await applyPlanningState(ctx, nextState);
			notify(ctx, `Plan saved: ${savedPath}`);
		}
	}

	if (typeof ctx.navigateTree === "function") await ctx.navigateTree(originId, { summarize: false });
	await clearPlanningState(ctx);
	await setPlanningWidget(ctx, false, false);
	notify(ctx, "Planning returned to original position successfully.");
}

async function handlePlanTests(ctx: any): Promise<string> {
	const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
	if (!state?.savedPath) {
		notify(ctx, "Please save first so a saved plan file exists before running /plan-tests.", "warning");
		throw new Error("Please save first so a saved plan file exists.");
	}
	const command = `/tdd-plan ${state.savedPath}`;
	notify(ctx, `Next step: run ${command}`);
	return command;
}

function buildPlanningSystemPrompt(): string {
	return [
		"You are in feature planning mode.",
		"Cite repo evidence explicitly and distinguish facts from assumptions.",
		"Ask concise, high-value questions that materially affect implementation.",
		"Avoid implementation code, avoid generic product-discovery fluff, and do not jump straight into coding.",
		"Do not invent architecture unsupported by the repository or ask giant questionnaires.",
		"If critical blockers remain unclear, call them out before finalizing.",
		"Consider performance, rollout strategy, audit logging, analytics, and observability when relevant.",
		"Only include a Recommended Split section when splitting the feature into multiple smaller vertical slices would clearly improve delivery.",
		"If you include Recommended Split, every split must be a full vertical slice delivering end-to-end value; never split by frontend/backend layers.",
		"Produce structured markdown when enough is known.",
	].join(" ");
}

function buildFinalizationPrompt(): string {
	return "Stop questioning and finalize the plan in structured markdown. Then suggest /plan-save as the next step.";
}

function section(title: string, items?: string[], ordered = false): string {
	const values = items?.filter(Boolean) ?? [];
	if (values.length === 0) return `## ${title}\n- (none)`;
	if (ordered) return `## ${title}\n${values.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;
	return `## ${title}\n${values.map((item) => `- ${item}`).join("\n")}`;
}

function renderPlanMarkdown(input: PlanMarkdownInput): string {
	const parts = [
		`# Plan: ${input.title}`,
		"",
	];

	if ((input.recommendedSplit?.filter(Boolean) ?? []).length > 0) {
		parts.push(section("Recommended Split", input.recommendedSplit), "");
	}

	parts.push(
		"## Requested feature",
		input.originalInput,
		"",
		"## Existing codebase context",
		input.repoContextSummary || "- (none)",
		"",
		"## Problem statement",
		input.problemStatement || "TBD",
		"",
		section("Scope", input.scope),
		"",
		section("Out of scope", input.outOfScope),
		"",
		section("Clarified decisions", input.decisions),
		"",
		section("Assumptions", input.assumptions),
		"",
		section("Open questions", input.openQuestions),
		"",
		section("Acceptance criteria", input.acceptanceCriteria),
		"",
		section("Edge cases", input.edgeCases),
	);
	return parts.join("\n").trim() + "\n";
}

async function detectRepoRoot(ctx: { cwd: string }): Promise<string> {
	let current = path.resolve(ctx.cwd);
	while (true) {
		try {
			await fs.stat(path.join(current, "package.json"));
			return current;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(ctx.cwd);
		current = parent;
	}
}

async function loadPlanningPackageJson(_ctx: { cwd: string }, repoRoot: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function extractPlanningKeywords(input: string): string[] {
	const stopwords = new Set(["add", "the", "and", "with", "for", "make", "better", "a", "an", "to"]);
	const tokens = input
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.filter((token) => token.length > 2 && !stopwords.has(token));
	const expanded = new Set<string>();
	for (const token of tokens) {
		expanded.add(token);
		if (token.endsWith("s")) expanded.add(token.slice(0, -1));
		else expanded.add(`${token}s`);
	}
	return [...expanded];
}

async function listFiles(rootDir: string, maxDepth: number): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string, depth: number) {
		if (depth > maxDepth) return;
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				if (![".pi", ".github"].includes(entry.name)) continue;
			}
			if (["node_modules", "dist", "build", "coverage", ".git", ".next", "out"].includes(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full, depth + 1);
			else out.push(path.relative(rootDir, full));
		}
	}
	await walk(rootDir, 0);
	return out;
}

async function loadFilePreview(repoRoot: string, relativePath: string): Promise<string | undefined> {
	try {
		const content = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
		return content.split(/\r?\n/).slice(0, 8).join("\n");
	} catch {
		return undefined;
	}
}

function rankRelevantFiles(keywords: string[], files: string[], previews: Record<string, string> = {}): RelevantFile[] {
	const docsBoost = /(docs|plans)\//;
	const testsBoost = /(^|\/)(test|tests|__tests__)\//;
	return files
		.map((file) => {
			const normalized = file.toLowerCase();
			let score = 0;
			const matches = keywords.filter((keyword) => normalized.includes(keyword));
			score += matches.length * 5;
			if (docsBoost.test(normalized) && matches.length > 0) score += 8;
			if (testsBoost.test(normalized) && matches.length > 0) score += 4;
			const preview = previews[file];
			if (preview) {
				const previewLower = preview.toLowerCase();
				score += keywords.filter((keyword) => previewLower.includes(keyword)).length * 2;
			}
			return {
				path: file,
				reason: matches.length > 0 ? `matches ${matches.join(", ")}` : "contextually related",
				preview,
				score,
			};
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
}

function buildInitialUserPrompt(input: {
	originalInput: string;
	repoContextSummary?: string;
	relevantFiles: Array<{ path: string; reason: string }>;
	sourcePlanText?: string;
}): string {
	const files = input.relevantFiles.map((file) => `- ${file.path}: ${file.reason}`).join("\n");
	return [
		buildPlanningSystemPrompt(),
		`Requested feature: ${input.originalInput}`,
		input.repoContextSummary || "No repo summary available.",
		files ? `Relevant files:\n${files}` : "Relevant files: none found",
		input.sourcePlanText ? `Existing draft:\n\n${input.sourcePlanText}` : "",
		"Ask narrowing questions before drafting if the request is still vague. First summarize the directly relevant repo evidence for this feature request.",
	].filter(Boolean).join("\n\n");
}

async function assertPlanningPrerequisites(ctx: { model: any; auth?: { authenticated: boolean } }): Promise<void> {
	if (!ctx.model) throw new Error("No active model selected");
	if (ctx.auth && !ctx.auth.authenticated) throw new Error("Authenticate the active model first");
}

async function assertRuntimePlanningPrerequisites(ctx: any): Promise<void> {
	if (!ctx.model) throw new Error("No active model selected");
	if (ctx.modelRegistry?.getApiKey) {
		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) throw new Error("Authenticate the active model first");
	}
}

function summarizeRepoContext(input: {
	repoRoot: string;
	pkg: Record<string, any> | null;
	relevantFiles: RelevantFile[];
	files: string[];
}): string {
	const scripts = Object.keys(input.pkg?.scripts ?? {});
	const sourceDirs = [...new Set(input.files.map((file) => file.split("/")[0]).filter(Boolean))].slice(0, 8);
	const lines = [
		`- Repo root: ${input.repoRoot}`,
		`- package.json: ${input.pkg ? "found" : "not found"}`,
		`- Source directories: ${sourceDirs.join(", ") || "(none detected)"}`,
		`- Scripts: ${scripts.join(", ") || "(none detected)"}`,
	];
	if (input.relevantFiles.length > 0) {
		lines.push("- Relevant files:");
		for (const file of input.relevantFiles.slice(0, 8)) {
			lines.push(`  - ${file.path}: ${file.reason}`);
		}
	} else {
		lines.push("- Relevant files: none found; this may be a greenfield area.");
	}
	return lines.join("\n");
}

async function collectPlanningContext(ctx: any, input: string): Promise<Partial<PlanningSessionState> & { sourcePlanText?: string }> {
	const repoRoot = await detectRepoRoot({ cwd: ctx.cwd ?? process.cwd() });
	const pkg = await loadPlanningPackageJson({ cwd: ctx.cwd ?? process.cwd() }, repoRoot);
	const files = await listFiles(repoRoot, 4);
	const keywords = extractPlanningKeywords(input);
	const sourceCandidate = path.resolve(repoRoot, input);
	let sourcePlanText: string | undefined;
	let sourcePlanPath: string | undefined;
	try {
		const stats = await fs.stat(sourceCandidate);
		if (stats.isFile()) {
			sourcePlanText = await fs.readFile(sourceCandidate, "utf8");
			sourcePlanPath = path.relative(repoRoot, sourceCandidate);
		}
	} catch {}
	const previewCandidates = files.filter((file) => keywords.some((keyword) => file.toLowerCase().includes(keyword))).slice(0, 20);
	const previews = Object.fromEntries(
		await Promise.all(previewCandidates.map(async (file) => [file, (await loadFilePreview(repoRoot, file)) ?? ""])),
	);
	const relevantFiles = rankRelevantFiles(keywords, files, previews).slice(0, 8);
	const repoContextSummary = summarizeRepoContext({ repoRoot, pkg, relevantFiles, files });
	return { repoRoot, sourcePlanPath, sourcePlanText, relevantFiles, repoContextSummary };
}

function synthesizePlanFromState(state: PlanningSessionState): string {
	const openQuestions = state.questions.filter((question) => question.status === "open").map((question) => question.question);
	const scope = state.relevantFiles.slice(0, 4).map((file) => `Review and update ${file.path}`);
	const recommendedSplit = scope.length > 2
		? [
			"Slice 1: deliver the smallest end-to-end version of the feature for a single primary user flow.",
			"Slice 2: add the next user-visible capability or supporting variant on top of slice 1.",
		]
		: undefined;
	const acceptanceCriteria = [
		"The feature behavior is documented in repo-grounded terms.",
		"The plan cites affected modules or explicitly notes when no prior module exists.",
		"Acceptance criteria cover the primary user-visible flow and at least one edge case.",
	];
	const edgeCases = [
		"No obvious existing module is found for the request.",
		"Critical behavior remains ambiguous and needs clarification before implementation.",
	];
	return renderPlanMarkdown({
		title: state.title,
		originalInput: state.originalInput,
		repoContextSummary: state.repoContextSummary,
		recommendedSplit,
		problemStatement: `Add ${state.title} in a way that fits the existing repository structure and conventions.`,
		scope,
		outOfScope: ["Unconfirmed product changes beyond the requested feature"],
		decisions: state.decisions,
		assumptions: state.assumptions.length > 0 ? state.assumptions : ["Reuse existing project conventions unless clarified otherwise."],
		openQuestions,
		acceptanceCriteria,
		edgeCases,
	});
}

function extractAssistantText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((block: any) => block?.type === "text")
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}

function maybeExtractDraftFromMessage(message: any): string | undefined {
	const text = extractAssistantText(message).trim();
	if (!text) return undefined;
	if (/^# Plan:/m.test(text) || (/^## Requested feature$/m.test(text) && /^## Acceptance criteria$/m.test(text))) return text;
	return undefined;
}

function shouldCaptureDraftUpdate(state: PlanningSessionState | undefined, draft: string | undefined): boolean {
	if (!state?.active || !draft) return false;
	if (state.status === "finalized") return false;
	return state.currentDraft !== draft;
}

export const __testables = {
	getPlanningState,
	loadPersistedPlanningState,
	applyPlanningState,
	clearPlanningState,
	setPlanningWidget,
	startPlanningSession,
	restorePlanningStateOnEvent,
	hasUnsavedDraft,
	endPlanningSession,
	handlePlanTests,
	buildPlanningSystemPrompt,
	buildFinalizationPrompt,
	renderPlanMarkdown,
	detectRepoRoot,
	loadPlanningPackageJson,
	extractPlanningKeywords,
	rankRelevantFiles,
	buildInitialUserPrompt,
	assertPlanningPrerequisites,
	collectPlanningContext,
	synthesizePlanFromState,
	maybeExtractDraftFromMessage,
	shouldCaptureDraftUpdate,
	get __fsWriteFile() {
		return writeFileImpl;
	},
	set __fsWriteFile(value) {
		writeFileImpl = value;
	},
	get __fsMkdir() {
		return mkdirImpl;
	},
	set __fsMkdir(value) {
		mkdirImpl = value;
	},
};

export default function planFeatureExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await restorePlanningStateOnEvent(ctx, _event);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await restorePlanningStateOnEvent(ctx, _event);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restorePlanningStateOnEvent(ctx, _event);
	});

	pi.on("turn_end", async (event, ctx) => {
		const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
		const draft = maybeExtractDraftFromMessage((event as any)?.message);
		if (!shouldCaptureDraftUpdate(state, draft)) return;
		const nextStatus: PlanningStatus = /## Open questions\n- \(none\)/i.test(draft) ? "finalized" : "drafting";
		const nextState: PlanningSessionState = {
			...state,
			currentDraft: draft,
			status: nextStatus,
			updatedAt: new Date().toISOString(),
		};
		await applyPlanningState(ctx, nextState);
		await setPlanningWidget(ctx, true, true);
	});

	pi.registerCommand("plan", {
		description: "Start an interactive feature planning session in an isolated branch",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input) {
				ctx.ui.notify("Usage: /plan <feature brief or plan path>", "warning");
				return;
			}

			try {
				await assertRuntimePlanningPrerequisites(ctx);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
				return;
			}

			let state: PlanningSessionState;
			try {
				state = await startPlanningSession({ ...ctx, pi }, input);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "warning");
				return;
			}

			const planningContext = await collectPlanningContext(ctx, input);
			state = {
				...state,
				repoRoot: planningContext.repoRoot ?? state.repoRoot,
				sourcePlanPath: planningContext.sourcePlanPath,
				relevantFiles: planningContext.relevantFiles ?? state.relevantFiles,
				repoContextSummary: planningContext.repoContextSummary,
				status: "clarifying",
				updatedAt: new Date().toISOString(),
			};
			await applyPlanningState({ ...ctx, pi }, state);
			await setPlanningWidget(ctx, true, Boolean(state.currentDraft));
			ctx.ui.notify("Planning context collected.", "info");

			const prompt = buildInitialUserPrompt({
				originalInput: state.originalInput,
				repoContextSummary: state.repoContextSummary,
				relevantFiles: state.relevantFiles,
				sourcePlanText: planningContext.sourcePlanText,
			});
			if (typeof pi.sendUserMessage === "function") pi.sendUserMessage(prompt);
			else sendDisplayMessage(pi, prompt);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current planning workflow status",
		handler: async (_args, ctx) => {
			const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
			if (!state?.active) {
				ctx.ui.notify("No active planning session.", "warning");
				return;
			}
			const openQuestions = state.questions.filter((question) => question.status === "open").length;
			const answeredQuestions = state.questions.filter((question) => question.status === "answered").length;
			const body = [
				`# Planning status: ${state.title}`,
				"",
				`- slug: ${state.slug}`,
				`- status: ${state.status}`,
				`- repo root: ${state.repoRoot}`,
				`- source input: ${state.sourcePlanPath ? "file" : "brief"}`,
				`- relevant files: ${state.relevantFiles.length}`,
				`- open questions: ${openQuestions}`,
				`- answered questions: ${answeredQuestions}`,
				`- saved path: ${state.savedPath ?? "(not saved)"}`,
				`- planning mode active: ${state.active ? "yes" : "no"}`,
			].join("\n");
			sendDisplayMessage(pi, body);
			ctx.ui.notify("Planning status shown.", "info");
		},
	});

	pi.registerCommand("plan-done", {
		description: "Finalize the current plan draft",
		handler: async (_args, ctx) => {
			const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
			if (!state?.active) {
				ctx.ui.notify("No active planning session.", "warning");
				return;
			}
			const draft = state.currentDraft || synthesizePlanFromState(state);
			const nextState: PlanningSessionState = {
				...state,
				currentDraft: draft,
				status: "finalized",
				updatedAt: new Date().toISOString(),
			};
			await applyPlanningState({ ...ctx, pi }, nextState);
			await setPlanningWidget(ctx, true, true);
			if (typeof ctx.ui.setEditorText === "function") ctx.ui.setEditorText(draft);
			ctx.ui.notify("Plan finalized. Next step: /plan-save", "info");
		},
	});

	pi.registerCommand("plan-save", {
		description: "Save the current plan markdown",
		handler: async (args, ctx) => {
			const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
			if (!state?.active) {
				ctx.ui.notify("No active planning session.", "warning");
				return;
			}
			let draft = state.currentDraft;
			if (!draft) {
				draft = synthesizePlanFromState(state);
				if (ctx.hasUI && typeof ctx.ui.confirm === "function") {
					const confirmed = await ctx.ui.confirm("Save partial plan?", "No finalized draft exists yet; save the current best synthesized plan.");
					if (!confirmed) {
						ctx.ui.notify("plan-save cancelled", "info");
						return;
					}
				}
			}
			const relativePath = (args ?? "").trim() || path.join(".pi", "plans", `${state.slug}.plan.md`);
			const absolutePath = path.resolve(state.repoRoot, relativePath);
			await mkdirImpl(path.dirname(absolutePath), { recursive: true });
			await writeFileImpl(absolutePath, draft.endsWith("\n") ? draft : `${draft}\n`, "utf8");
			const savedPath = path.relative(state.repoRoot, absolutePath);
			const nextState: PlanningSessionState = {
				...state,
				currentDraft: draft,
				savedPath,
				status: "finalized",
				updatedAt: new Date().toISOString(),
			};
			appendCustomEntry(pi, PLANNING_METADATA_TYPE, {
				id: state.id,
				slug: state.slug,
				savedPath,
				updatedAt: nextState.updatedAt,
			});
			await applyPlanningState({ ...ctx, pi }, nextState);
			await setPlanningWidget(ctx, true, true);
			ctx.ui.notify(`Plan saved: ${savedPath}`, "info");
		},
	});

	pi.registerCommand("plan-tests", {
		description: "Show the next tdd-plan handoff command for the saved plan",
		handler: async (_args, ctx) => {
			try {
				const command = await handlePlanTests(ctx);
				sendDisplayMessage(pi, `Run:\n\n${command}`);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "warning");
			}
		},
	});

	pi.registerCommand("end-planning", {
		description: "Return from planning to the original position",
		handler: async (_args, ctx) => {
			try {
				await endPlanningSession(ctx);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "warning");
			}
		},
	});
}
