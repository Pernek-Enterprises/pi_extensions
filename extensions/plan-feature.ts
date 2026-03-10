import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@mariozechner/pi-tui";

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

type ExtractedQuestion = {
	question: string;
	context?: string;
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
	savedMachinePath?: string;
	lastInteractivePromptSignature?: string;
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

type PlanMachineRequirement = {
	id: string;
	text: string;
	priority: "primary" | "secondary";
	sourceSection: string;
};

type PlanMachineAmbiguity = {
	id: string;
	text: string;
	blocksTdd: boolean;
	sourceSection: string;
};

type PlanMachineArtifact = {
	version: 1;
	generatedAt: string;
	sourcePlanPath: string;
	title: string;
	requestedFeature: string;
	behavioralRequirements: PlanMachineRequirement[];
	testableOperationalRequirements: PlanMachineRequirement[];
	blockingAmbiguities: PlanMachineAmbiguity[];
	advisoryAmbiguities: PlanMachineAmbiguity[];
	outOfScope: string[];
	repoGrounding: {
		repoContextSummary?: string;
		relevantFiles: Array<{ path: string; reason?: string }>;
	};
	generationConstraints: {
		preferRepoGroundedTests: true;
		forbidInventedApis: true;
		preferBehavioralAssertions: true;
	};
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

function isPathInsideRoot(rootDir: string, filePath: string): boolean {
	const relative = path.relative(rootDir, filePath);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolvePlanOutputPath(repoRoot: string, requestedPath: string): string {
	const resolved = path.resolve(repoRoot, requestedPath);
	if (!isPathInsideRoot(repoRoot, resolved)) {
		throw new Error("Plan path must stay inside the repository root");
	}
	return resolved;
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
	if (!entry) return undefined;
	if (entry.type === "custom") return entry.data;
	if (Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
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
		const isCustomShape = entry?.type === "custom" && entry?.customType === PLANNING_STATE_TYPE;
		const isLegacyShape = entry?.type === PLANNING_STATE_TYPE;
		if (!isCustomShape && !isLegacyShape) continue;
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
		const renderer = (_tui: any, theme: any) => {
			const message = theme && typeof theme.fg === "function" ? theme.fg("warning", text) : text;
			const textComponent = new Text(message, 0, 0);
			return {
				render(width: number) {
					return textComponent.render(width);
				},
				invalidate() {
					textComponent.invalidate();
				},
			};
		};
		if (ctx.ui.setWidget.length >= 2) ctx.ui.setWidget(PLANNING_WIDGET_ID, renderer);
		else ctx.ui.setWidget(renderer);
	}
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx?.hasUI && typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, level);
	else if (typeof ctx?.notify === "function") ctx.notify(message);
}

function notifyUI(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	notify(ctx, message, level);
}

function sendDisplayMessage(pi: any, content: string): void {
	if (typeof pi?.sendMessage !== "function") return;
	pi.sendMessage({ customType: "planning-status", content, display: true }, { triggerTurn: false });
}

class PlanningQnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) parts.push(`> ${q.context}`);
			parts.push(`A: ${a}`);
			parts.push("");
		}
		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) this.navigateTo(this.currentIndex + 1);
			else this.showingConfirmation = true;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;
		const horizontalLine = (count: number) => "─".repeat(count);
		const boxLine = (content: string, leftPad = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};
		const emptyBoxLine = (): string => this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		const padToWidth = (line: string): string => line + " ".repeat(Math.max(0, width - visibleWidth(line)));

		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Planning questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) progressParts.push(this.cyan("●"));
			else if (answered) progressParts.push(this.green("●"));
			else progressParts.push(this.dim("○"));
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		const q = this.questions[this.currentIndex];
		for (const line of wrapTextWithAnsi(`${this.bold("Q:")} ${q.question}`, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(this.gray(`> ${q.context}`), contentWidth - 2)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}
		lines.push(padToWidth(emptyBoxLine()));

		const answerPrefix = this.bold("A: ");
		const editorWidth = contentWidth - 7;
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			else lines.push(padToWidth(boxLine("   " + editorLines[i])));
		}
		lines.push(padToWidth(emptyBoxLine()));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
		if (this.showingConfirmation) {
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
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
			await savePlanningDraft(ctx, ctx.pi ?? ctx, state);
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
		"Keep the final plan short, clear, and easy to scan.",
		"Prefer short bullets over long prose.",
		"Only keep sections that add real value; omit empty or boilerplate sections.",
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
	return "Stop questioning and finalize the plan in short structured markdown. Keep it concise, use only sections that add value, omit empty/boilerplate sections, then suggest /plan-save as the next step.";
}

function section(title: string, items?: string[], ordered = false): string {
	const values = items?.filter(Boolean) ?? [];
	if (values.length === 0) return "";
	if (ordered) return `## ${title}\n${values.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;
	return `## ${title}\n${values.map((item) => `- ${item}`).join("\n")}`;
}

function renderPlanMarkdown(input: PlanMarkdownInput): string {
	const sections = [
		(input.recommendedSplit?.filter(Boolean) ?? []).length > 0 ? section("Recommended Split", input.recommendedSplit) : "",
		"## Requested feature\n" + input.originalInput,
		input.repoContextSummary ? `## Existing codebase context\n${input.repoContextSummary}` : "",
		input.problemStatement ? `## Problem statement\n${input.problemStatement}` : "",
		section("Scope", input.scope),
		section("Out of scope", input.outOfScope),
		section("Clarified decisions", input.decisions),
		section("Assumptions", input.assumptions),
		section("Open questions", input.openQuestions),
		section("Acceptance criteria", input.acceptanceCriteria),
		section("Edge cases", input.edgeCases),
	].filter(Boolean);

	return [`# Plan: ${input.title}`, "", ...sections].join("\n\n").trim() + "\n";
}

function buildPlanMachineArtifactPath(planPath: string): string {
	if (planPath.endsWith(".plan.md")) return planPath.replace(/\.plan\.md$/i, ".plan.tdd.json");
	if (planPath.endsWith(".md")) return planPath.replace(/\.md$/i, ".plan.tdd.json");
	return `${planPath}.plan.tdd.json`;
}

function splitPlanMarkdownSections(markdown: string): Array<{ heading?: string; content: string }> {
	const lines = markdown.split(/\r?\n/);
	const sections: Array<{ heading?: string; lines: string[] }> = [];
	let current: { heading?: string; lines: string[] } = { lines: [] };
	let inCode = false;

	const pushCurrent = () => {
		const content = current.lines.join("\n").trim();
		if (content) sections.push({ heading: current.heading, lines: current.lines.slice() });
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) inCode = !inCode;
		const headingMatch = !inCode ? trimmed.match(/^#{1,6}\s+(.+)$/) : null;
		if (headingMatch) {
			pushCurrent();
			current = { heading: headingMatch[1].trim(), lines: [] };
			continue;
		}
		current.lines.push(line);
	}
	pushCurrent();

	return sections.map((section) => ({
		heading: section.heading,
		content: section.lines.join("\n").trim(),
	}));
}

function extractSectionItems(content: string): string[] {
	const items: string[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const bulletMatch = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/);
		if (bulletMatch) {
			items.push(bulletMatch[1].trim());
			continue;
		}
		const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
		if (numberedMatch) {
			items.push(numberedMatch[1].trim());
		}
	}
	if (items.length > 0) return items;
	const paragraph = content.replace(/\s+/g, " ").trim();
	return paragraph ? [paragraph] : [];
}

function isMetaPlanBullet(text: string): boolean {
	const normalized = text.toLowerCase().trim();
	if (!normalized || normalized === "(none)") return true;
	return [
		/the feature behavior is documented in repo-grounded terms/,
		/the plan cites affected modules/,
		/acceptance criteria cover the primary user-visible flow/,
		/no obvious existing module is found/,
		/critical behavior remains ambiguous and needs clarification/,
		/review and update /,
	].some((pattern) => pattern.test(normalized));
}

function isBlockingAmbiguityText(text: string): boolean {
	const normalized = text.toLowerCase();
	return [
		/before implementation/,
		/before tests can be written/,
		/needs clarification/,
		/cannot infer/,
		/can't infer/,
		/impossible to infer/,
		/unknown seam/,
		/unsupported seam/,
	].some((pattern) => pattern.test(normalized));
}

function buildMachineRequirements(items: string[], sourceSection: string, prefix: string, priority: "primary" | "secondary"): PlanMachineRequirement[] {
	let index = 0;
	return items
		.filter((item) => !isMetaPlanBullet(item))
		.map((text) => ({
			id: `${prefix}${++index}`,
			text,
			priority,
			sourceSection,
		}));
}

function buildPlanMachineArtifact(markdown: string, state: Pick<PlanningSessionState, "title" | "originalInput" | "repoContextSummary" | "relevantFiles">, planPath: string): PlanMachineArtifact {
	const sections = splitPlanMarkdownSections(markdown);
	const getSection = (name: string) => sections.find((section) => section.heading?.toLowerCase() === name.toLowerCase())?.content ?? "";
	const requestedFeature = getSection("Requested feature").replace(/\s+/g, " ").trim() || state.originalInput;
	const acceptanceCriteria = extractSectionItems(getSection("Acceptance criteria"));
	const edgeCases = extractSectionItems(getSection("Edge cases"));
	const decisions = extractSectionItems(getSection("Clarified decisions"));
	const openQuestions = extractSectionItems(getSection("Open questions"));
	const assumptions = extractSectionItems(getSection("Assumptions"));
	const outOfScope = extractSectionItems(getSection("Out of scope")).filter((item) => !isMetaPlanBullet(item));

	const behavioralRequirements = [
		...buildMachineRequirements(acceptanceCriteria, "Acceptance criteria", "AC", "primary"),
		...buildMachineRequirements(edgeCases, "Edge cases", "EC", "primary"),
	];
	const testableOperationalRequirements = buildMachineRequirements(decisions, "Clarified decisions", "OP", "secondary");

	let advisoryIndex = 0;
	let blockingIndex = 0;
	const advisoryAmbiguities: PlanMachineAmbiguity[] = [];
	const blockingAmbiguities: PlanMachineAmbiguity[] = [];
	for (const text of [...openQuestions, ...assumptions].filter((item) => !isMetaPlanBullet(item))) {
		const ambiguity = {
			id: isBlockingAmbiguityText(text) ? `AMB${++blockingIndex}` : `AMB${++advisoryIndex}`,
			text,
			blocksTdd: isBlockingAmbiguityText(text),
			sourceSection: openQuestions.includes(text) ? "Open questions" : "Assumptions",
		};
		if (ambiguity.blocksTdd) blockingAmbiguities.push(ambiguity);
		else advisoryAmbiguities.push(ambiguity);
	}

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		sourcePlanPath: planPath,
		title: state.title,
		requestedFeature,
		behavioralRequirements,
		testableOperationalRequirements,
		blockingAmbiguities,
		advisoryAmbiguities,
		outOfScope,
		repoGrounding: {
			repoContextSummary: state.repoContextSummary,
			relevantFiles: state.relevantFiles.map((file) => ({ path: file.path, reason: file.reason })),
		},
		generationConstraints: {
			preferRepoGroundedTests: true,
			forbidInventedApis: true,
			preferBehavioralAssertions: true,
		},
	};
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
	return renderPlanMarkdown({
		title: state.title,
		originalInput: state.originalInput,
		repoContextSummary: state.repoContextSummary,
		decisions: state.decisions,
		assumptions: state.assumptions,
		openQuestions,
	});
}

function extractOpenQuestionsFromDraft(draft: string): ExtractedQuestion[] {
	const lines = draft.split(/\r?\n/);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+Open questions\s*$/i.test(lines[i].trim())) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return [];

	const questions: ExtractedQuestion[] = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		if (/^##\s+/.test(line)) break;
		const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
		const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
		const value = bulletMatch?.[1] ?? numberedMatch?.[1];
		if (!value) continue;
		if (/^\(none\)$/i.test(value.trim())) return [];
		questions.push({ question: value.trim() });
	}
	return questions;
}

function syncQuestionsWithDraft(state: PlanningSessionState, extractedQuestions: ExtractedQuestion[]): PlanningQuestion[] {
	if (extractedQuestions.length === 0) {
		return state.questions.map((question) => ({
			...question,
			status: question.answer?.trim() ? "answered" : "skipped",
		}));
	}

	const existingByText = new Map(state.questions.map((question) => [question.question.trim().toLowerCase(), question]));
	return extractedQuestions.map((question, index) => {
		const existing = existingByText.get(question.question.trim().toLowerCase());
		return {
			id: existing?.id ?? `q-${index + 1}`,
			question: question.question,
			answer: existing?.answer,
			status: existing?.answer?.trim() ? "answered" : existing?.status === "skipped" ? "skipped" : "open",
		};
	});
}

function applyAnswersToQuestions(state: PlanningSessionState, answers: string): PlanningQuestion[] {
	const answerByQuestion = new Map<string, string>();
	const blocks = answers.split(/\n\s*\n+/);
	for (const block of blocks) {
		const questionMatch = block.match(/(?:^|\n)Q:\s*(.+)/i);
		const answerMatch = block.match(/(?:^|\n)A:\s*([\s\S]+)/i);
		const question = questionMatch?.[1]?.trim();
		const answer = answerMatch?.[1]?.trim();
		if (question && answer && answer !== "(no answer)") answerByQuestion.set(question.toLowerCase(), answer);
	}

	return state.questions.map((question) => {
		const answer = answerByQuestion.get(question.question.trim().toLowerCase()) ?? question.answer;
		return {
			...question,
			answer,
			status: answer?.trim() ? "answered" : question.status,
		};
	});
}

async function promptForPlanningAnswers(ctx: any, questions: ExtractedQuestion[]): Promise<string | null> {
	if (!ctx?.hasUI || typeof ctx?.ui?.custom !== "function") return null;
	return ctx.ui.custom<string | null>((tui: TUI, _theme: any, _kb: any, done: (value: string | null) => void) => {
		return new PlanningQnAComponent(questions, tui, done);
	});
}

async function savePlanningDraft(ctx: any, pi: any, state: PlanningSessionState, requestedPath?: string): Promise<PlanningSessionState | undefined> {
	let draft = state.currentDraft;
	if (!draft) {
		draft = synthesizePlanFromState(state);
		if (ctx.hasUI && typeof ctx.ui.confirm === "function") {
			const confirmed = await ctx.ui.confirm("Save partial plan?", "No finalized draft exists yet; save the current best synthesized plan.");
			if (!confirmed) {
				notifyUI(ctx, "plan-save cancelled", "info");
				return undefined;
			}
		}
	}
	const relativePath = requestedPath?.trim() || path.join(".pi", "plans", `${state.slug}.plan.md`);
	const absolutePath = resolvePlanOutputPath(state.repoRoot, relativePath);
	const machineAbsolutePath = buildPlanMachineArtifactPath(absolutePath);
	await mkdirImpl(path.dirname(absolutePath), { recursive: true });
	await writeFileImpl(absolutePath, draft.endsWith("\n") ? draft : `${draft}\n`, "utf8");
	const machineArtifact = buildPlanMachineArtifact(draft, state, path.relative(state.repoRoot, absolutePath));
	await writeFileImpl(machineAbsolutePath, JSON.stringify(machineArtifact, null, 2) + "\n", "utf8");
	const savedPath = path.relative(state.repoRoot, absolutePath);
	const savedMachinePath = path.relative(state.repoRoot, machineAbsolutePath);
	const nextState: PlanningSessionState = {
		...state,
		currentDraft: draft,
		savedPath,
		savedMachinePath,
		status: "finalized",
		updatedAt: new Date().toISOString(),
	};
	appendCustomEntry(pi, PLANNING_METADATA_TYPE, {
		id: state.id,
		slug: state.slug,
		savedPath,
		savedMachinePath,
		updatedAt: nextState.updatedAt,
	});
	await applyPlanningState({ ...ctx, pi }, nextState);
	await setPlanningWidget(ctx, true, true);
	notifyUI(ctx, `Plan saved: ${savedPath}`, "info");
	notifyUI(ctx, `TDD artifact saved: ${savedMachinePath}`, "info");
	return nextState;
}

async function maybeHandlePlanningFollowUp(pi: any, ctx: any, state: PlanningSessionState, draft: string): Promise<void> {
	if (!ctx?.hasUI) return;
	const signature = draft.trim();
	if (!signature || state.lastInteractivePromptSignature === signature) return;

	const questions = extractOpenQuestionsFromDraft(draft);
	const nextStateBase: PlanningSessionState = {
		...state,
		questions: syncQuestionsWithDraft(state, questions),
		lastInteractivePromptSignature: signature,
		updatedAt: new Date().toISOString(),
	};
	await applyPlanningState({ ...ctx, pi }, nextStateBase);

	if (questions.length > 0) {
		const answers = await promptForPlanningAnswers(ctx, questions);
		if (answers === null) {
			notifyUI(ctx, "Planning questions cancelled", "info");
			return;
		}
		await applyPlanningState({
			...ctx,
			pi,
		}, {
			...nextStateBase,
			questions: applyAnswersToQuestions(nextStateBase, answers),
			updatedAt: new Date().toISOString(),
		});
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your planning questions in the following way:\n\n" + answers,
				display: true,
			},
			{ triggerTurn: true },
		);
		return;
	}

	if (typeof ctx?.ui?.select !== "function") return;
	const options = state.savedPath
		? ["End planning", "Keep planning"]
		: ["Save plan", "Save plan and end planning", "End planning", "Keep planning"];
	const choice = await ctx.ui.select("Plan draft complete:", options);
	if (!choice || choice === "Keep planning") return;
	if (choice === "Save plan") {
		await savePlanningDraft(ctx, pi, state);
		return;
	}
	if (choice === "Save plan and end planning") {
		const savedState = await savePlanningDraft(ctx, pi, state);
		if (savedState) await endPlanningSession({ ...ctx, state: { ...(ctx.state ?? {}), planning: savedState } });
		return;
	}
	if (choice === "End planning") await endPlanningSession(ctx);
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

function formatPlanningWarning(state: Record<string, unknown>): string {
	if (!state?.active) return "";

	const title = typeof state.title === "string" ? state.title : "";
	const yellow = "\x1b[33m";
	const bold = "\x1b[1m";
	const reset = "\x1b[0m";

	const label = "⚠ ACTIVE PLANNING";
	const titleLine = title ? ` │ ${title}` : "";
	const content = `${label}${titleLine}`;
	const innerWidth = Math.max(content.length + 4, 40);
	const top = `${yellow}╔${"═".repeat(innerWidth)}╗${reset}`;
	const bottom = `${yellow}╚${"═".repeat(innerWidth)}╝${reset}`;
	const pad = innerWidth - content.length;
	const middle = `${yellow}║${reset} ${bold}${yellow}${content}${reset}${" ".repeat(pad - 1)}${yellow}║${reset}`;
	return `${top}\n${middle}\n${bottom}`;
}

export const __testables = {
	formatPlanningWarning,
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
	buildPlanMachineArtifactPath,
	splitPlanMarkdownSections,
	extractSectionItems,
	isMetaPlanBullet,
	isBlockingAmbiguityText,
	buildMachineRequirements,
	buildPlanMachineArtifact,
	resolvePlanOutputPath,
	detectRepoRoot,
	loadPlanningPackageJson,
	extractPlanningKeywords,
	rankRelevantFiles,
	buildInitialUserPrompt,
	assertPlanningPrerequisites,
	collectPlanningContext,
	synthesizePlanFromState,
	extractOpenQuestionsFromDraft,
	syncQuestionsWithDraft,
	applyAnswersToQuestions,
	savePlanningDraft,
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
		const extractedQuestions = extractOpenQuestionsFromDraft(draft);
		const nextStatus: PlanningStatus = extractedQuestions.length === 0 ? "finalized" : "drafting";
		const nextState: PlanningSessionState = {
			...state,
			currentDraft: draft,
			questions: syncQuestionsWithDraft(state, extractedQuestions),
			status: nextStatus,
			updatedAt: new Date().toISOString(),
		};
		await applyPlanningState(ctx, nextState);
		await setPlanningWidget(ctx, true, true);
		await maybeHandlePlanningFollowUp(pi, ctx, nextState, draft);
	});

	pi.registerCommand("plan", {
		description: "Start an interactive feature planning session in an isolated branch",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input) {
				notifyUI(ctx, "Usage: /plan <feature brief or plan path>", "warning");
				return;
			}

			try {
				await assertRuntimePlanningPrerequisites(ctx);
			} catch (error) {
				notifyUI(ctx, (error as Error).message, "error");
				return;
			}

			let state: PlanningSessionState;
			try {
				state = await startPlanningSession({ ...ctx, pi }, input);
			} catch (error) {
				notifyUI(ctx, (error as Error).message, "warning");
				return;
			}

			let planningContext: Awaited<ReturnType<typeof collectPlanningContext>>;
			try {
				planningContext = await collectPlanningContext(ctx, input);
			} catch (error) {
				await clearPlanningState(ctx);
				await setPlanningWidget(ctx, false, false);
				if (state.originId && typeof ctx.navigateTree === "function") {
					await ctx.navigateTree(state.originId, { summarize: false });
				}
				notifyUI(ctx, `Failed to collect planning context: ${(error as Error).message}`, "error");
				return;
			}
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
			notifyUI(ctx, "Planning context collected.", "info");

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
				notifyUI(ctx, "No active planning session.", "warning");
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
				`- saved tdd artifact: ${state.savedMachinePath ?? "(not saved)"}`,
				`- planning mode active: ${state.active ? "yes" : "no"}`,
			].join("\n");
			sendDisplayMessage(pi, body);
			notifyUI(ctx, "Planning status shown.", "info");
		},
	});

	pi.registerCommand("plan-done", {
		description: "Finalize the current plan draft",
		handler: async (_args, ctx) => {
			const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
			if (!state?.active) {
				notifyUI(ctx, "No active planning session.", "warning");
				return;
			}
			const fallbackDraft = state.currentDraft || synthesizePlanFromState(state);
			const nextState: PlanningSessionState = {
				...state,
				currentDraft: fallbackDraft,
				status: "drafting",
				updatedAt: new Date().toISOString(),
			};
			await applyPlanningState({ ...ctx, pi }, nextState);
			await setPlanningWidget(ctx, true, true);
			if (typeof ctx?.ui?.setEditorText === "function") ctx.ui.setEditorText(fallbackDraft);

			if (typeof pi.sendUserMessage === "function") {
				pi.sendUserMessage(buildFinalizationPrompt());
				notifyUI(ctx, "Asked the planner to finalize the current plan. Next step: /plan-save", "info");
				return;
			}

			const finalizedState: PlanningSessionState = {
				...nextState,
				status: "finalized",
				updatedAt: new Date().toISOString(),
			};
			await applyPlanningState({ ...ctx, pi }, finalizedState);
			notifyUI(ctx, "Plan finalized. Next step: /plan-save", "info");
		},
	});

	pi.registerCommand("plan-save", {
		description: "Save the current plan markdown",
		handler: async (args, ctx) => {
			const state = getPlanningState(ctx) ?? loadPersistedPlanningState(ctx);
			if (!state?.active) {
				notifyUI(ctx, "No active planning session.", "warning");
				return;
			}
			await savePlanningDraft(ctx, pi, state, args ?? "");
		},
	});

	pi.registerCommand("plan-tests", {
		description: "Show the next tdd-plan handoff command for the saved plan",
		handler: async (_args, ctx) => {
			try {
				const command = await handlePlanTests(ctx);
				sendDisplayMessage(pi, `Run:\n\n${command}`);
			} catch (error) {
				notifyUI(ctx, (error as Error).message, "warning");
			}
		},
	});

	pi.registerCommand("end-planning", {
		description: "Return from planning to the original position",
		handler: async (_args, ctx) => {
			try {
				await endPlanningSession(ctx);
			} catch (error) {
				notifyUI(ctx, (error as Error).message, "warning");
			}
		},
	});
}
