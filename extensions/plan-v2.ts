import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractExecutionContract } from "./planning-v2/contract-extractor.ts";
import { buildExecutionContractPath, buildRawPlanPath, renderRawPlanMarkdown } from "./planning-v2/raw-artifact.ts";
import { renderMarkdownFromExecutionContract } from "./planning-v2/contract-render.ts";
import type { ExecutionContract } from "./planning-v2/contract-schema.ts";
import {
	extractOpenQuestionsFromRawPlan,
	formatAnsweredQuestions,
	formatQuestionsForFollowup,
	mergeQuestions,
	type PlanningV2Question,
} from "./planning-v2/question-loop.ts";
import { PlanningV2QnAComponent } from "./planning-v2/question-ui.ts";

type RelevantFile = { path: string; reason: string };

type PlanningV2State = {
	active: boolean;
	title: string;
	slug: string;
	originalInput: string;
	repoRoot: string;
	repoContextSummary?: string;
	relevantFiles: RelevantFile[];
	rawDraft?: string;
	questions: PlanningV2Question[];
	contract?: ExecutionContract;
	savedPath?: string;
	savedContractPath?: string;
};

const PLANNING_V2_STATE_TYPE = "planning-v2-session";

function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	if (typeof ctx?.notify === "function") ctx.notify(message, level);
	else if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, level);
	else if (typeof ctx?.pi?.sendMessage === "function") ctx.pi.sendMessage({ content: message, display: true }, { triggerTurn: false });
}

function getState(ctx: any): PlanningV2State | undefined {
	return ctx?.state?.planningV2;
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
	if (entry.type === PLANNING_V2_STATE_TYPE && Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
}

function setState(ctx: any, state: PlanningV2State | undefined) {
	if (!ctx.state) ctx.state = {};
	ctx.state.planningV2 = state;
}

function loadPersistedState(ctx: any): PlanningV2State | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!(entry?.type === "custom" && entry?.customType === PLANNING_V2_STATE_TYPE) && entry?.type !== PLANNING_V2_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data || data.active === false) return undefined;
		setState(ctx, data as PlanningV2State);
		return data as PlanningV2State;
	}
	return undefined;
}

async function applyState(ctx: any, state: PlanningV2State): Promise<PlanningV2State> {
	setState(ctx, state);
	appendCustomEntry(ctx.pi ?? ctx, PLANNING_V2_STATE_TYPE, state);
	return state;
}

async function clearState(ctx: any): Promise<void> {
	setState(ctx, undefined);
	appendCustomEntry(ctx.pi ?? ctx, PLANNING_V2_STATE_TYPE, { active: false });
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

async function maybeAskClarifyingQuestions(pi: ExtensionAPI, state: PlanningV2State): Promise<void> {
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
	renderRawPlanMarkdown,
	buildRawPlanPath,
	buildExecutionContractPath,
	extractAssistantText,
	getState,
	loadPersistedState,
	applyState,
	clearState,
};

export default function planV2Extension(pi: ExtensionAPI) {
	pi.on?.("session_start", async (_event, ctx) => {
		loadPersistedState(ctx);
	});
	pi.on?.("session_switch", async (_event, ctx) => {
		loadPersistedState(ctx);
	});
	pi.on?.("session_tree", async (_event, ctx) => {
		loadPersistedState(ctx);
	});

	pi.registerCommand("plan-v2", {
		description: "Start a clean-slate v2 planning session",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input) {
				notify(ctx, "Usage: /plan-v2 <feature brief>", "warning");
				return;
			}
			notify(ctx, "Collecting planning context...", "info");
			const repoRoot = await detectRepoRoot(ctx.cwd ?? process.cwd());
			const { repoContextSummary, relevantFiles } = await collectRepoSummary(repoRoot);
			const initialDraft = renderRawPlanMarkdown({
				title: input.charAt(0).toUpperCase() + input.slice(1),
				requestedFeature: input,
				repoContextSummary,
			});
			const state: PlanningV2State = {
				active: true,
				title: input.charAt(0).toUpperCase() + input.slice(1),
				slug: slugify(input),
				originalInput: input,
				repoRoot,
				repoContextSummary,
				relevantFiles,
				rawDraft: initialDraft,
				questions: extractOpenQuestionsFromRawPlan(initialDraft),
			};
			await applyState({ ...ctx, pi }, state);
			notify(ctx, "Planning v2 started. Refine the raw plan, then run /plan-save-v2.", "info");
			if (typeof pi.sendUserMessage === "function") {
				pi.sendUserMessage([
					"You are in planning v2 mode.",
					"Produce a rich raw plan artifact in markdown.",
					"Do not force one rigid schema.",
					"Be explicit about evidence, intended behavior, ambiguities, and checks.",
					"If key information is missing, include a concise `## Open questions` section with only high-value clarifications.",
					`Requested feature: ${input}`,
					repoContextSummary,
				].join("\n\n"));
			}
		},
	});

	pi.on?.("turn_end", async (event, ctx) => {
		const state = getState(ctx) ?? loadPersistedState(ctx);
		if (!state?.active) return;
		const text = extractAssistantText((event as any)?.message).trim();
		if (!text) return;
		if (/^# /m.test(text) || /^## /m.test(text)) {
			const extractedQuestions = extractOpenQuestionsFromRawPlan(text);
			const nextState = await applyState({ ...ctx, pi }, {
				...state,
				rawDraft: text,
				questions: mergeQuestions(state.questions, extractedQuestions),
			});
			await maybeAskClarifyingQuestions(pi, nextState);
		}
	});

	pi.registerCommand("plan-answer-v2", {
		description: "Provide answers to open v2 planning questions",
		handler: async (args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			if (!state?.active) {
				notify(ctx, "No active v2 planning session.", "warning");
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
						customType: "planning-v2-answers",
						content: "I answered the v2 planning questions:\n\n" + formatAnsweredQuestions(nextQuestions),
						display: true,
					}, { triggerTurn: true });
				}
				notify(ctx, "Saved v2 planning answers and asked the planner to continue.", "info");
			};
			const input = (args ?? "").trim();
			if (!input && ctx.hasUI && typeof ctx.ui.custom === "function") {
				const openQuestions = state.questions.filter((q) => q.status === "open");
				if (openQuestions.length === 0) {
					notify(ctx, "No open v2 planning questions.", "info");
					return;
				}
				const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => new PlanningV2QnAComponent(openQuestions, tui, done));
				if (answersResult === null) {
					notify(ctx, "Cancelled", "info");
					return;
				}
				await applyAnswers(answersResult);
				return;
			}
			if (!input) {
				notify(ctx, "Usage: /plan-answer-v2 Q: <question>\nA: <answer> ...", "warning");
				return;
			}
			await applyAnswers(input);
		},
	});

	pi.registerCommand("plan-save-v2", {
		description: "Save the raw v2 plan and extract an execution contract",
		handler: async (args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			try {
				const requestedPath = (args ?? "").trim();
				const repoRoot = state?.repoRoot ?? await detectRepoRoot(ctx.cwd ?? process.cwd());
				let rawRelativePath: string;
				let rawAbsolutePath: string;
				let rawDraft: string;
				let title: string;
				let originalInput: string;
				let repoContextSummary = state?.repoContextSummary;
				let relevantFiles = state?.relevantFiles ?? [];

				if (requestedPath) {
					rawAbsolutePath = path.resolve(repoRoot, requestedPath);
					if (!(await exists(rawAbsolutePath))) {
						notify(ctx, `Plan file not found: ${rawAbsolutePath}`, "warning");
						return;
					}
					rawRelativePath = path.relative(repoRoot, rawAbsolutePath);
					rawDraft = await fs.readFile(rawAbsolutePath, "utf8");
					title = path.basename(rawAbsolutePath).replace(/\.plan\.md$/i, "").replace(/[-_]+/g, " ");
					originalInput = rawDraft.match(/^##\s+Requested feature\s*\n([\s\S]*?)(?:\n##\s+|$)/im)?.[1]?.replace(/\s+/g, " ").trim() || title;
					if (!repoContextSummary) {
						const collected = await collectRepoSummary(repoRoot);
						repoContextSummary = collected.repoContextSummary;
						relevantFiles = collected.relevantFiles;
					}
				} else if (state?.active && state.rawDraft) {
					rawRelativePath = state.savedPath ?? buildRawPlanPath(state.slug);
					rawAbsolutePath = path.join(repoRoot, rawRelativePath);
					rawDraft = state.rawDraft;
					title = state.title;
					originalInput = state.originalInput;
				} else {
					notify(ctx, "No active v2 planning draft to save. Pass a .plan.md path to /plan-save-v2 or start /plan-v2 first.", "warning");
					return;
				}

				const contractRelativePath = buildExecutionContractPath(rawRelativePath);
				const contractAbsolutePath = path.join(repoRoot, contractRelativePath);
				await fs.mkdir(path.dirname(rawAbsolutePath), { recursive: true });
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
				await fs.writeFile(rawAbsolutePath, renderedRaw.endsWith("\n") ? renderedRaw : renderedRaw + "\n", "utf8");
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
				notify(ctx, `plan-save-v2 failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("plan-status-v2", {
		description: "Show the current v2 planning state",
		handler: async (_args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			if (!state?.active) {
				notify(ctx, "No active v2 planning session.", "warning");
				return;
			}
			const openQuestions = state.questions.filter((q) => q.status === "open").length;
			const answeredQuestions = state.questions.filter((q) => q.status === "answered").length;
			const contractStatus = state.contract ? ` | contract: ${state.contract.status}` : "";
			notify(ctx, `V2 planning active: ${state.title} | open questions: ${openQuestions} | answered: ${answeredQuestions}${contractStatus}`, "info");
		},
	});

	pi.registerCommand("plan-tests-v2", {
		description: "Suggest the next TDD step from v2 planning",
		handler: async (_args, ctx) => {
			const state = getState(ctx) ?? loadPersistedState(ctx);
			if (!state?.savedContractPath) {
				notify(ctx, "Save the v2 plan first with /plan-save-v2.", "warning");
				return;
			}
			const command = `/tdd-plan ${state.savedContractPath}`;
			notify(ctx, `Next step: run ${command}`, "info");
		},
	});

	pi.registerCommand("end-planning-v2", {
		description: "End the active v2 planning session",
		handler: async (_args, ctx) => {
			await clearState({ ...ctx, pi });
			notify(ctx, "Planning v2 ended.", "info");
		},
	});
}
