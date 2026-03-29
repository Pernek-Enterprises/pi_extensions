import { promises as fs } from "node:fs";
import path from "node:path";
import { complete, type Api, type Model, type UserMessage } from "./lib/pi-ai-compat.ts";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExecutionContract } from "./planning/contract-schema.ts";
import { loadReadyImplementationContract } from "./implement/contract-input.ts";
import { buildImplementationLoopArtifactPaths, slugFromContractPath } from "./implement/loop-artifacts.ts";
import {
	applyImplementLoopState,
	clearImplementLoopState,
	getImplementLoopState,
	loadPersistedImplementLoopState,
	type ImplementPlanLoopIteration,
	type ImplementPlanLoopNextState,
	type ImplementPlanLoopState,
} from "./implement/loop-state.ts";
import {
	buildImplementationPrompt,
	buildReviewSystemPrompt,
	buildReviewUserPrompt,
	parseJson,
	renderFixHandoff,
	renderReviewMarkdown,
	type ImplementationReviewFinding,
	type ImplementationReviewResult,
	type ReviewResolutionType,
} from "./implement/prompts.ts";

const IMPLEMENT_LOOP_MAX_ITERATIONS = 8;
const IMPLEMENT_LOOP_START_TIMEOUT_MS = 15000;
const IMPLEMENT_LOOP_START_POLL_MS = 250;
const MAX_CHANGED_FILE_PREVIEW_CHARS = 2200;
const MAX_TARGET_FILE_PREVIEW_CHARS = 5000;
const MAX_CHANGED_FILES_FOR_REVIEW = 8;
const MAX_DIFF_PREVIEW_CHARS = 12000;
const MAX_EVIDENCE_FILES = 6;

type AssistantSnapshot = {
	id: string;
	text: string;
	stopReason?: string;
};

type LoopActionState = "implementing" | "repairing" | "gathering-evidence";

type EvidenceBundle = {
	mode: "evidence-rereview";
	summary: string;
	blockerTitles: string[];
	targetIds: string[];
	targetFiles: Array<{ path: string; preview: string; available: boolean; source: "review-target" | "contract-evidence" | "changed-file" }>;
	changedFiles: string[];
	diffPreview?: string;
};

type RequestAuth = {
	apiKey: string;
	headers?: Record<string, string>;
};

type TriageDecision = {
	nextState: ImplementPlanLoopNextState;
	reason: string;
	blockerSignatures: string[];
	implementationBlockingCount: number;
	evidenceBlockingCount: number;
	externalValidationBlockingCount: number;
	targetIds: string[];
	targetFiles: string[];
};

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	if (typeof ctx?.notify === "function") ctx.notify(message, level);
	else if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, level);
	else if (typeof ctx?.pi?.sendMessage === "function") ctx.pi.sendMessage({ content: message, display: true }, { triggerTurn: false });
}

async function assertModelReady(ctx: ExtensionContext): Promise<RequestAuth> {
	if (!ctx.model) throw new Error("No active model selected");
	const model = ctx.model as Model<Api>;
	const modelRegistry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (model: Model<Api>) => Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
		getApiKey?: (model: Model<Api>) => Promise<string | undefined>;
	};
	const auth = modelRegistry.getApiKeyAndHeaders
		? await modelRegistry.getApiKeyAndHeaders(model)
		: { ok: true as const, apiKey: modelRegistry.getApiKey ? await modelRegistry.getApiKey(model) : undefined };
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("Authenticate the active model first");
	return { apiKey: auth.apiKey, headers: auth.headers };
}

function extractAssistantTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && "type" in part && (part as any).type === "text" && "text" in part))
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getLastAssistantSnapshot(ctx: ExtensionContext): AssistantSnapshot | null {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const assistantMessage = entry.message as { content?: unknown; stopReason?: string };
		return {
			id: entry.id,
			text: extractAssistantTextContent(assistantMessage.content),
			stopReason: assistantMessage.stopReason,
		};
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoopTurnToStart(ctx: ExtensionContext, previousAssistantId?: string): Promise<boolean> {
	const deadline = Date.now() + IMPLEMENT_LOOP_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || (lastAssistantId && lastAssistantId !== previousAssistantId)) return true;
		await sleep(IMPLEMENT_LOOP_START_POLL_MS);
	}
	return false;
}

async function execInRepo(pi: ExtensionAPI, repoRoot: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
	const shellCommand = `cd ${JSON.stringify(repoRoot)} && ${command}`;
	return await pi.exec("bash", ["-lc", shellCommand]);
}

function tokenizeFocusText(text: string | undefined): string[] {
	if (!text) return [];
	return [...new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9_/.-]+/g, " ")
			.split(/\s+/)
			.map((token) => token.trim())
			.filter((token) => token.length >= 4)
	)];
}

function buildEvidenceFocusTerms(contract: ExecutionContract, extraFocusText?: string): string[] {
	const text = [
		contract.goal,
		...(contract.requirements ?? []).map((item) => item.text),
		...(contract.checks ?? []).map((item) => item.text),
		...(contract.evidence ?? []).flatMap((item) => [item.path, item.reason ?? ""]),
		extraFocusText ?? "",
	].join("\n");
	return tokenizeFocusText(text).slice(0, 80);
}

function countTermHits(text: string, terms: string[]): number {
	const haystack = text.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (haystack.includes(term)) score += term.length >= 10 ? 3 : term.length >= 6 ? 2 : 1;
	}
	return score;
}

function truncatePreview(text: string, maxChars = MAX_CHANGED_FILE_PREVIEW_CHARS): string {
	const normalized = text.replace(/\t/g, "  ").trim();
	if (normalized.length <= maxChars) return normalized;
	return normalized.slice(0, maxChars).trimEnd() + "\n... [truncated]";
}

async function collectRepoContext(repoRoot: string, contract: ExecutionContract, extraFocusText?: string): Promise<string> {
	const packageJsonPath = path.join(repoRoot, "package.json");
	const lines: string[] = [];
	try {
		const raw = await fs.readFile(packageJsonPath, "utf8");
		const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 10);
		const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 20);
		lines.push(`Repo root: ${repoRoot}`);
		lines.push(`package.json: ${path.relative(repoRoot, packageJsonPath)}`);
		if (scripts.length > 0) lines.push(`Scripts: ${scripts.join(", ")}`);
		if (deps.length > 0) lines.push(`Dependencies/devDependencies: ${deps.join(", ")}`);
	} catch {
		lines.push(`Repo root: ${repoRoot}`);
	}

	const focusTerms = buildEvidenceFocusTerms(contract, extraFocusText);
	if (focusTerms.length > 0) lines.push(`Focus terms: ${focusTerms.slice(0, 24).join(", ")}`);
	const evidencePreviews = await Promise.all((contract.evidence ?? []).map(async (item) => {
		const absolutePath = path.join(repoRoot, item.path);
		try {
			const preview = truncatePreview(await fs.readFile(absolutePath, "utf8"), 1800);
			const score = countTermHits(`${item.path}\n${item.reason ?? ""}\n${preview}`, focusTerms) + (item.reason ? 2 : 0);
			return { path: item.path, reason: item.reason, preview, score };
		} catch {
			return { path: item.path, reason: item.reason, preview: "[unavailable]", score: -1 };
		}
	}));
	for (const item of evidencePreviews.sort((a, b) => b.score - a.score).slice(0, 6)) {
		lines.push(`\n--- FILE: ${item.path}${item.reason ? ` — ${item.reason}` : ""} ---\n${item.preview}`);
	}
	return lines.join("\n");
}

function extractImplementationSummary(text: string): string {
	const match = text.match(/^##\s+Implementation summary\s*\n([\s\S]*)$/im);
	return match?.[1]?.trim() || text.trim();
}

export function parseChangedFilesFromPorcelain(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/, ""))
		.filter(Boolean)
		.map((line) => {
			const renamed = line.match(/^..\s+.+?\s+->\s+(.+)$/);
			if (renamed) return renamed[1].trim();
			if (line.length <= 3) return "";
			return line.slice(3).trim();
		})
		.filter((filePath) => Boolean(filePath) && !/^\.pi(\/|$)/i.test(filePath));
}

async function collectChangedFiles(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
	const result = await execInRepo(pi, repoRoot, "git status --porcelain");
	if (result.code !== 0) return [];
	return parseChangedFilesFromPorcelain(result.stdout);
}

async function collectChangedFilePreviews(repoRoot: string, changedFiles: string[]): Promise<Array<{ path: string; preview: string }>> {
	const previews: Array<{ path: string; preview: string }> = [];
	for (const filePath of changedFiles.slice(0, MAX_CHANGED_FILES_FOR_REVIEW)) {
		try {
			const absolutePath = path.join(repoRoot, filePath);
			const preview = truncatePreview(await fs.readFile(absolutePath, "utf8"));
			previews.push({ path: filePath, preview });
		} catch {
			previews.push({ path: filePath, preview: "[unavailable or binary]" });
		}
	}
	return previews;
}

async function collectDiffPreview(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const result = await execInRepo(pi, repoRoot, "git diff --no-color --unified=1 -- . ':(exclude).pi/generated-*' ':(exclude).pi/generated-*/*'");
	if (result.code !== 0) return "";
	return result.stdout.length <= MAX_DIFF_PREVIEW_CHARS ? result.stdout : result.stdout.slice(0, MAX_DIFF_PREVIEW_CHARS) + "\n... [truncated]";
}

async function readFilePreview(filePath: string, maxChars: number): Promise<{ available: boolean; preview: string }> {
	try {
		const preview = truncatePreview(await fs.readFile(filePath, "utf8"), maxChars);
		return { available: true, preview };
	} catch {
		return { available: false, preview: "[unavailable or binary]" };
	}
}

async function callModelJson<T>(ctx: ExtensionContext, auth: RequestAuth, systemPrompt: string, userPrompt: string): Promise<T> {
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userPrompt }],
		timestamp: Date.now(),
	};
	const response = await complete(ctx.model as Model<Api>, { systemPrompt, messages: [message] }, { apiKey: auth.apiKey, headers: auth.headers });
	if (response.stopReason === "aborted") throw new Error("Model call aborted");
	if (response.stopReason === "error") throw new Error("Model call failed");
	const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
	const parsed = parseJson<T>(text);
	if (parsed) return parsed;
	const repairPrompt = [
		"Convert the following model output into strict JSON only.",
		"Preserve the content semantically, but return only one valid JSON object matching the intended schema.",
		"Do not add commentary or markdown fences.",
		"Original output:",
		text,
	].join("\n\n");
	const repairMessage: UserMessage = { role: "user", content: [{ type: "text", text: repairPrompt }], timestamp: Date.now() };
	const repaired = await complete(
		ctx.model as Model<Api>,
		{ systemPrompt: "You repair malformed JSON model outputs. Return strict JSON only.", messages: [repairMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers },
	);
	if (repaired.stopReason === "aborted") throw new Error("Model call aborted during JSON repair");
	if (repaired.stopReason === "error") throw new Error("Model call failed during JSON repair");
	const repairedText = repaired.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
	const repairedParsed = parseJson<T>(repairedText);
	if (!repairedParsed) throw new Error(`Model did not return valid JSON. Raw response preview: ${text.slice(0, 240).replace(/\s+/g, " ")}`);
	return repairedParsed;
}

function inferResolutionType(finding: Partial<ImplementationReviewFinding>): ReviewResolutionType {
	const text = `${finding.title ?? ""}\n${finding.details ?? ""}\n${finding.suggestedFix ?? ""}`.toLowerCase();
	if (/deployment|live validation|preview deployment|runtime env|dashboard|provider settings|environment settings|cannot be verified locally|manual validation|cloudflare pages preview/.test(text)) {
		return "external-validation";
	}
	if (/not evidenced|not verifiable|not shown|not demonstrated|preview unavailable|unsupported check|insufficient evidence|provided evidence|not available in the repository evidence|cannot confirm from the evidence/.test(text)) {
		return "evidence";
	}
	return "implementation";
}

function normalizeReview(review: ImplementationReviewResult): ImplementationReviewResult {
	const findings = Array.isArray(review.findings)
		? review.findings.map((finding) => ({
			category: finding.category ?? "other",
			disposition: finding.disposition === "advisory" ? "advisory" : "blocking",
			resolutionType:
				finding.resolutionType === "evidence" || finding.resolutionType === "external-validation" || finding.resolutionType === "implementation"
					? finding.resolutionType
					: inferResolutionType(finding),
			title: finding.title?.trim() || "Unnamed finding",
			details: finding.details?.trim() || "",
			suggestedFix: finding.suggestedFix?.trim() || "Refine the implementation to address this issue.",
			targetIds: Array.isArray(finding.targetIds) ? finding.targetIds.filter(Boolean) : [],
			targetFiles: Array.isArray(finding.targetFiles) ? finding.targetFiles.filter(Boolean) : [],
			confidence:
				finding.confidence === "high" || finding.confidence === "medium" || finding.confidence === "low"
					? finding.confidence
					: undefined,
		}))
		: [];
	let blockers = 0;
	const boundedFindings = findings.map((finding) => {
		if (finding.disposition !== "blocking") return finding;
		blockers += 1;
		if (blockers <= 3) return finding;
		return { ...finding, disposition: "advisory" as const, title: `[downgraded] ${finding.title}` };
	});
	const blockingCount = boundedFindings.filter((finding) => finding.disposition === "blocking").length;
	return {
		verdict: review.verdict === "pass" && blockingCount === 0 ? "pass" : "fail",
		summary: review.summary?.trim() || "Implementation review completed.",
		satisfiedRequirementIds: Array.isArray(review.satisfiedRequirementIds) ? review.satisfiedRequirementIds.filter(Boolean) : [],
		partialRequirementIds: Array.isArray(review.partialRequirementIds) ? review.partialRequirementIds.filter(Boolean) : [],
		unsatisfiedRequirementIds: Array.isArray(review.unsatisfiedRequirementIds) ? review.unsatisfiedRequirementIds.filter(Boolean) : [],
		supportedCheckIds: Array.isArray(review.supportedCheckIds) ? review.supportedCheckIds.filter(Boolean) : [],
		unsupportedCheckIds: Array.isArray(review.unsupportedCheckIds) ? review.unsupportedCheckIds.filter(Boolean) : [],
		findings: boundedFindings,
		strengths: Array.isArray(review.strengths) ? review.strengths.filter(Boolean) : [],
	};
}

async function reviewImplementation(ctx: ExtensionContext, auth: RequestAuth, input: {
	contract: ExecutionContract;
	repoContext: string;
	implementationSummary: string;
	changedFiles: string[];
	changedFilePreviews: Array<{ path: string; preview: string }>;
	diffPreview: string;
	evidenceBundle?: string;
	reviewMode?: "implementation-review" | "evidence-rereview";
}): Promise<ImplementationReviewResult> {
	const review = await callModelJson<ImplementationReviewResult>(
		ctx,
		auth,
		buildReviewSystemPrompt(),
		buildReviewUserPrompt(input),
	);
	return normalizeReview(review);
}

function blockerSignature(finding: ImplementationReviewFinding): string {
	const ids = [...finding.targetIds].sort().join(",");
	const files = [...finding.targetFiles].sort().join(",");
	const title = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	return `${finding.resolutionType}|${finding.category}|${ids}|${files}|${title}`;
}

function buildTriageDecision(
	review: ImplementationReviewResult,
	previousIteration: ImplementPlanLoopIteration | undefined,
	currentMode: LoopActionState,
): TriageDecision {
	const blockers = review.findings.filter((finding) => finding.disposition === "blocking");
	const implementationBlockers = blockers.filter((finding) => finding.resolutionType === "implementation");
	const evidenceBlockers = blockers.filter((finding) => finding.resolutionType === "evidence");
	const externalValidationBlockers = blockers.filter((finding) => finding.resolutionType === "external-validation");
	const blockerSignatures = blockers.map(blockerSignature).sort();
	const previousSignatures = [...(previousIteration?.blockerSignatures ?? [])].sort();
	const repeatedBlockers =
		blockerSignatures.length > 0 &&
		previousSignatures.length === blockerSignatures.length &&
		previousSignatures.every((signature, index) => signature === blockerSignatures[index]);
	const targetIds = [...new Set(blockers.flatMap((finding) => finding.targetIds))];
	const targetFiles = [...new Set(blockers.flatMap((finding) => finding.targetFiles))];

	if (blockers.length === 0) {
		return {
			nextState: "completed",
			reason: "No blocking findings remain.",
			blockerSignatures,
			implementationBlockingCount: 0,
			evidenceBlockingCount: 0,
			externalValidationBlockingCount: 0,
			targetIds,
			targetFiles,
		};
	}

	if (implementationBlockers.length > 0) {
		return {
			nextState: "repairing",
			reason: repeatedBlockers
				? "Blocking findings persisted and still require repository changes; continue with a targeted repair pass."
				: "Blocking findings require targeted repository changes.",
			blockerSignatures,
			implementationBlockingCount: implementationBlockers.length,
			evidenceBlockingCount: evidenceBlockers.length,
			externalValidationBlockingCount: externalValidationBlockers.length,
			targetIds,
			targetFiles,
		};
	}

	if (evidenceBlockers.length > 0) {
		if (currentMode === "gathering-evidence" && repeatedBlockers) {
			return {
				nextState: "repairing",
				reason: "Evidence blockers persisted after an evidence pass; fall back to a targeted repair/proof pass.",
				blockerSignatures,
				implementationBlockingCount: implementationBlockers.length,
				evidenceBlockingCount: evidenceBlockers.length,
				externalValidationBlockingCount: externalValidationBlockers.length,
				targetIds,
				targetFiles,
			};
		}
		return {
			nextState: "gathering-evidence",
			reason: "Current blockers are primarily evidence gaps; gather stronger repo-grounded proof before changing code again.",
			blockerSignatures,
			implementationBlockingCount: implementationBlockers.length,
			evidenceBlockingCount: evidenceBlockers.length,
			externalValidationBlockingCount: externalValidationBlockers.length,
			targetIds,
			targetFiles,
		};
	}

	if (externalValidationBlockers.length > 0) {
		return {
			nextState: "awaiting-external-validation",
			reason: "Remaining blockers require deployment/runtime validation outside the local repository loop.",
			blockerSignatures,
			implementationBlockingCount: implementationBlockers.length,
			evidenceBlockingCount: evidenceBlockers.length,
			externalValidationBlockingCount: externalValidationBlockers.length,
			targetIds,
			targetFiles,
		};
	}

	return {
		nextState: "repairing",
		reason: "Defaulting to targeted repair because blocking findings remain.",
		blockerSignatures,
		implementationBlockingCount: implementationBlockers.length,
		evidenceBlockingCount: evidenceBlockers.length,
		externalValidationBlockingCount: externalValidationBlockers.length,
		targetIds,
		targetFiles,
	};
}

async function buildEvidenceBundle(input: {
	repoRoot: string;
	contract: ExecutionContract;
	review: ImplementationReviewResult;
	changedFiles: string[];
	diffPreview: string;
}): Promise<EvidenceBundle> {
	const blockers = input.review.findings.filter((finding) => finding.disposition === "blocking");
	const targetFiles = [...new Set([
		...blockers.flatMap((finding) => finding.targetFiles),
		...(input.contract.evidence ?? []).map((item) => item.path),
		...input.changedFiles,
	])].slice(0, MAX_EVIDENCE_FILES);

	const items: EvidenceBundle["targetFiles"] = [];
	for (const relativePath of targetFiles) {
		const source: EvidenceBundle["targetFiles"][number]["source"] = blockers.some((finding) => finding.targetFiles.includes(relativePath))
			? "review-target"
			: (input.contract.evidence ?? []).some((item) => item.path === relativePath)
				? "contract-evidence"
				: "changed-file";
		const absolutePath = path.join(input.repoRoot, relativePath);
		const { available, preview } = await readFilePreview(absolutePath, MAX_TARGET_FILE_PREVIEW_CHARS);
		items.push({ path: relativePath, preview, available, source });
	}

	return {
		mode: "evidence-rereview",
		summary: blockers.length > 0
			? `Collected focused repository evidence for ${blockers.length} blocking finding(s) without making additional code changes.`
			: "Collected focused repository evidence for re-review.",
		blockerTitles: blockers.map((finding) => finding.title),
		targetIds: [...new Set(blockers.flatMap((finding) => finding.targetIds))],
		targetFiles: items,
		changedFiles: input.changedFiles,
		diffPreview: input.diffPreview,
	};
}

function renderEvidenceBundle(bundle: EvidenceBundle): string {
	return [
		`Evidence mode: ${bundle.mode}`,
		`Summary: ${bundle.summary}`,
		bundle.blockerTitles.length > 0 ? `Current blockers:\n- ${bundle.blockerTitles.join("\n- ")}` : undefined,
		bundle.targetIds.length > 0 ? `Target ids:\n- ${bundle.targetIds.join("\n- ")}` : undefined,
		bundle.targetFiles.length > 0
			? `Focused file evidence:\n${bundle.targetFiles
				.map((item) => `--- FILE: ${item.path} [${item.source}] ${item.available ? "" : "(unavailable)"} ---\n${item.preview}`)
				.join("\n\n")}`
			: undefined,
		bundle.diffPreview ? `Current diff preview:\n${bundle.diffPreview}` : undefined,
	].filter(Boolean).join("\n\n");
}

function renderExternalValidationHandoff(contract: ExecutionContract, review: ImplementationReviewResult): string {
	const blockers = review.findings.filter(
		(finding) => finding.disposition === "blocking" && finding.resolutionType === "external-validation",
	);
	return [
		`# Implement loop external validation handoff`,
		"",
		`Goal: ${contract.goal}`,
		`Summary: ${review.summary}`,
		"",
		...(blockers.length > 0
			? blockers.map((finding, index) => [
				`## External validation blocker ${index + 1}: ${finding.title}`,
				finding.targetIds.length > 0 ? `- target ids: ${finding.targetIds.join(", ")}` : undefined,
				finding.targetFiles.length > 0 ? `- target files: ${finding.targetFiles.join(", ")}` : undefined,
				`- details: ${finding.details}`,
				`- expected validation: ${finding.suggestedFix}`,
			].filter(Boolean).join("\n"))
			: ["No external validation blockers."])
	].join("\n").trim() + "\n";
}

function buildStatusBody(state: ImplementPlanLoopState): string {
	return [
		`# Implement loop status`,
		"",
		`- contract path: ${state.contractPath}`,
		`- status: ${state.status}`,
		`- iteration: ${state.iteration}/${state.maxIterations}`,
		`- stop reason: ${state.stopReason ?? "(not stopped)"}`,
		`- last review summary: ${state.lastReviewSummary ?? "(none)"}`,
		`- last implementation summary: ${state.lastImplementationSummary ?? "(none)"}`,
		`- last evidence summary: ${state.lastEvidenceSummary ?? "(none)"}`,
		`- last triage decision: ${state.lastTriageDecision ?? "(none)"}`,
		`- last transition reason: ${state.lastTransitionReason ?? "(none)"}`,
		`- blocking findings: ${state.lastBlockingCount ?? 0}`,
		`- advisory findings: ${state.lastAdvisoryCount ?? 0}`,
		`- changed files: ${state.changedFiles.length}`,
		`- iterations recorded: ${state.iterations.length}`,
	].join("\n");
}

export const __testables = {
	IMPLEMENT_LOOP_MAX_ITERATIONS: IMPLEMENT_LOOP_MAX_ITERATIONS,
	slugFromContractPath,
	buildImplementationLoopArtifactPaths,
	buildStatusBody,
	buildEvidenceFocusTerms,
	getImplementLoopState,
	loadPersistedImplementLoopState,
	applyImplementLoopState,
	clearImplementLoopState,
	extractImplementationSummary,
	parseChangedFilesFromPorcelain,
	normalizeReview,
	buildTriageDecision,
	renderEvidenceBundle,
};

export default function implementPlanLoopExtension(pi: ExtensionAPI) {
	pi.on?.("session_start", async (_event, ctx) => {
		loadPersistedImplementLoopState(ctx);
	});
	pi.on?.("session_switch", async (_event, ctx) => {
		loadPersistedImplementLoopState(ctx);
	});
	pi.on?.("session_tree", async (_event, ctx) => {
		loadPersistedImplementLoopState(ctx);
	});

	pi.registerCommand("implement-plan-loop", {
		description: "Implement a ready execution contract using an implementation/review state machine",
		handler: async (args, ctx) => {
			const existing = getImplementLoopState(ctx) ?? loadPersistedImplementLoopState(ctx);
			if (existing?.active) {
				notify(ctx, "implement-plan-loop is already running. Use /end-implement-plan-loop first.", "warning");
				return;
			}

			let contractInput = (args ?? "").trim();
			if (!contractInput && ctx.hasUI && typeof ctx.ui.input === "function") {
				const input = await ctx.ui.input("Execution contract path", ".pi/plans/feature.plan.contract.json");
				if (!input?.trim()) {
					notify(ctx, "implement-plan-loop cancelled", "info");
					return;
				}
				contractInput = input.trim();
			}
			if (!contractInput) {
				notify(ctx, "Usage: /implement-plan-loop <plan.contract.json>", "warning");
				return;
			}

			let state: ImplementPlanLoopState = {
				active: true,
				repoRoot: ctx.cwd ?? process.cwd(),
				contractPath: contractInput,
				slug: slugFromContractPath(contractInput),
				status: "preflight",
				iteration: 0,
				maxIterations: IMPLEMENT_LOOP_MAX_ITERATIONS,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				changedFiles: [],
				iterations: [],
				lastTransitionReason: "Validating contract, repository, and model before starting the implementation loop.",
			};
			await applyImplementLoopState({ ...ctx, pi }, state);

			let loaded: Awaited<ReturnType<typeof loadReadyImplementationContract>>;
			try {
				loaded = await loadReadyImplementationContract(ctx.cwd ?? process.cwd(), contractInput);
			} catch (error) {
				await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					active: false,
					status: "failed",
					updatedAt: new Date().toISOString(),
					stopReason: "preflight-contract-invalid",
					lastTransitionReason: (error as Error).message,
				});
				notify(ctx, (error as Error).message, "warning");
				return;
			}

			let auth: RequestAuth;
			try {
				auth = await assertModelReady(ctx);
			} catch (error) {
				await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					active: false,
					status: "failed",
					updatedAt: new Date().toISOString(),
					stopReason: "preflight-model-unavailable",
					lastTransitionReason: (error as Error).message,
				});
				notify(ctx, (error as Error).message, "error");
				return;
			}

			let repoContext = await collectRepoContext(loaded.repoRoot, loaded.contract);
			state = await applyImplementLoopState({ ...ctx, pi }, {
				...state,
				repoRoot: loaded.repoRoot,
				contractPath: loaded.relativePath,
				slug: slugFromContractPath(loaded.relativePath),
				status: "implementing",
				updatedAt: new Date().toISOString(),
				lastTransitionReason: "Preflight passed. Starting the initial implementation pass.",
			});
			notify(ctx, `Starting implement-plan-loop for ${loaded.relativePath}`, "info");

			let nextAction: LoopActionState = "implementing";
			let previousImplementationHandoff: string | undefined;
			let previousReviewSummary: string | undefined;
			let previousChangedFiles: string[] = [];
			let previousReview: ImplementationReviewResult | undefined;
			let previousDiffPreview = "";

			for (let iteration = 1; iteration <= IMPLEMENT_LOOP_MAX_ITERATIONS; iteration++) {
				const artifactPaths = buildImplementationLoopArtifactPaths(loaded.repoRoot, loaded.relativePath, iteration);
				await fs.mkdir(artifactPaths.directory, { recursive: true });
				state = await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					status: nextAction,
					iteration,
					updatedAt: new Date().toISOString(),
					lastTransitionReason:
						nextAction === "gathering-evidence"
							? "Collecting stronger repository-grounded evidence for the current blockers before changing code again."
							: nextAction === "repairing"
								? "Applying a targeted repair pass for the current implementation blockers."
								: "Running the initial implementation pass against the execution contract.",
				});

				let implementationSummary = state.lastImplementationSummary ?? previousReviewSummary ?? "";
				let changedFiles = previousChangedFiles;
				let changedFilePreviews: Array<{ path: string; preview: string }> = [];
				let diffPreview = previousDiffPreview;
				let evidenceBundleText: string | undefined;
				let evidenceBundlePath: string | undefined;

				if (nextAction === "gathering-evidence") {
					const evidenceBundle = await buildEvidenceBundle({
						repoRoot: loaded.repoRoot,
						contract: loaded.contract,
						review: previousReview!,
						changedFiles: previousChangedFiles,
						diffPreview: previousDiffPreview,
					});
					evidenceBundleText = renderEvidenceBundle(evidenceBundle);
					evidenceBundlePath = path.relative(loaded.repoRoot, artifactPaths.evidenceBundlePath);
					await fs.writeFile(artifactPaths.evidenceBundlePath, JSON.stringify(evidenceBundle, null, 2) + "\n", "utf8");
					changedFiles = previousChangedFiles;
					changedFilePreviews = evidenceBundle.targetFiles.map((item) => ({ path: item.path, preview: item.preview }));
					diffPreview = previousDiffPreview || (await collectDiffPreview(pi, loaded.repoRoot));
					implementationSummary = previousReviewSummary ?? state.lastImplementationSummary ?? "Evidence re-review with focused repository snippets.";
					state = await applyImplementLoopState({ ...ctx, pi }, {
						...state,
						lastEvidenceSummary: evidenceBundle.summary,
						updatedAt: new Date().toISOString(),
					});
				} else {
					const prompt = buildImplementationPrompt({
						contract: loaded.contract,
						repoContext,
						fixHandoff: previousImplementationHandoff,
						previousSummary: previousReviewSummary,
						changedFiles: previousChangedFiles,
					});
					const baselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
					if (typeof pi.sendUserMessage === "function") pi.sendUserMessage(prompt);
					else if (typeof pi.sendMessage === "function") pi.sendMessage({ customType: "implement-plan-loop", content: prompt, display: true }, { triggerTurn: true });
					else throw new Error("No messaging API available to start implementation pass");
					const started = await waitForLoopTurnToStart(ctx, baselineAssistantId);
					if (!started) {
						await applyImplementLoopState({ ...ctx, pi }, {
							...state,
							active: false,
							status: "failed",
							updatedAt: new Date().toISOString(),
							stopReason: "implementation-turn-timeout",
							lastTransitionReason: "Implementation pass did not start in time.",
						});
						notify(ctx, "Implementation pass did not start in time.", "error");
						return;
					}
					await ctx.waitForIdle();
					const snapshot = getLastAssistantSnapshot(ctx);
					if (!snapshot || snapshot.id === baselineAssistantId) {
						await applyImplementLoopState({ ...ctx, pi }, {
							...state,
							active: false,
							status: "failed",
							updatedAt: new Date().toISOString(),
							stopReason: "implementation-no-result",
							lastTransitionReason: "Could not read the implementation result.",
						});
						notify(ctx, "Implementation loop stopped: could not read the implementation result.", "warning");
						return;
					}
					if (snapshot.stopReason === "aborted" || snapshot.stopReason === "error" || snapshot.stopReason === "length") {
						const stopReason = snapshot.stopReason === "aborted"
							? "implementation-aborted"
							: snapshot.stopReason === "error"
								? "implementation-error"
								: "implementation-length-truncated";
						await applyImplementLoopState({ ...ctx, pi }, {
							...state,
							active: false,
							status: "failed",
							updatedAt: new Date().toISOString(),
							stopReason,
							lastTransitionReason: `Implementation pass ended with stopReason=${snapshot.stopReason}.`,
						});
						notify(ctx, `Implementation loop stopped: implementation pass ended with ${snapshot.stopReason}.`, snapshot.stopReason === "error" ? "error" : "warning");
						return;
					}

					implementationSummary = extractImplementationSummary(snapshot.text);
					changedFiles = await collectChangedFiles(pi, loaded.repoRoot);
					changedFilePreviews = await collectChangedFilePreviews(loaded.repoRoot, changedFiles);
					diffPreview = await collectDiffPreview(pi, loaded.repoRoot);
					await fs.writeFile(artifactPaths.implementationSummaryPath, snapshot.text.endsWith("\n") ? snapshot.text : snapshot.text + "\n", "utf8");
					await fs.writeFile(artifactPaths.changedFilesPath, JSON.stringify(changedFiles, null, 2) + "\n", "utf8");
					await fs.writeFile(artifactPaths.diffPath, diffPreview.endsWith("\n") ? diffPreview : diffPreview + (diffPreview ? "\n" : ""), "utf8");
				}

				if (nextAction === "gathering-evidence") {
					await fs.writeFile(artifactPaths.changedFilesPath, JSON.stringify(changedFiles, null, 2) + "\n", "utf8");
					await fs.writeFile(artifactPaths.diffPath, diffPreview.endsWith("\n") ? diffPreview : diffPreview + (diffPreview ? "\n" : ""), "utf8");
				}

				state = await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					status: "reviewing",
					updatedAt: new Date().toISOString(),
					changedFiles,
					lastImplementationSummary: implementationSummary,
					lastTransitionReason:
						nextAction === "gathering-evidence"
							? "Re-reviewing the current repository state with stronger targeted evidence."
							: "Reviewing the latest repository state against the execution contract.",
				});
				notify(ctx, `implement-plan-loop round ${iteration}: reviewing implementation against the contract...`, "info");
				const review = await reviewImplementation(ctx, auth, {
					contract: loaded.contract,
					repoContext,
					implementationSummary,
					changedFiles,
					changedFilePreviews,
					diffPreview,
					evidenceBundle: evidenceBundleText,
					reviewMode: nextAction === "gathering-evidence" ? "evidence-rereview" : "implementation-review",
				});
				const blockingCount = review.findings.filter((finding) => finding.disposition === "blocking").length;
				const advisoryCount = review.findings.filter((finding) => finding.disposition === "advisory").length;
				const reviewMarkdown = renderReviewMarkdown(review);
				await fs.writeFile(artifactPaths.reviewJsonPath, JSON.stringify(review, null, 2) + "\n", "utf8");
				await fs.writeFile(artifactPaths.reviewMarkdownPath, reviewMarkdown, "utf8");
				const targetIds = [...new Set(review.findings.flatMap((finding) => finding.targetIds))];
				const targetFiles = [...new Set(review.findings.flatMap((finding) => finding.targetFiles))];

				if (blockingCount === 0) {
					const iterationRecord: ImplementPlanLoopIteration = {
						iteration,
						mode: nextAction,
						implementationSummaryPath: nextAction === "gathering-evidence" ? undefined : path.relative(loaded.repoRoot, artifactPaths.implementationSummaryPath),
						reviewJsonPath: path.relative(loaded.repoRoot, artifactPaths.reviewJsonPath),
						reviewMarkdownPath: path.relative(loaded.repoRoot, artifactPaths.reviewMarkdownPath),
						triageJsonPath: undefined,
						evidenceBundlePath,
						externalValidationPath: undefined,
						fixHandoffPath: undefined,
						changedFilesPath: path.relative(loaded.repoRoot, artifactPaths.changedFilesPath),
						diffPath: path.relative(loaded.repoRoot, artifactPaths.diffPath),
						blockingCount,
						advisoryCount,
						implementationBlockingCount: 0,
						evidenceBlockingCount: 0,
						externalValidationBlockingCount: 0,
						summary: review.summary,
						targetIds,
						targetFiles,
						changedFiles,
						blockerSignatures: [],
						triageDecision: "completed",
					};
					state = await applyImplementLoopState({ ...ctx, pi }, {
						...state,
						active: false,
						status: "completed",
						updatedAt: new Date().toISOString(),
						lastReviewSummary: review.summary,
						lastBlockingCount: 0,
						lastAdvisoryCount: advisoryCount,
						lastTriageDecision: "completed",
						lastTransitionReason: "Review found no blocking findings.",
						stopReason: "no-blocking-findings",
						iterations: [...state.iterations, iterationRecord],
					});
					const finalSummary = [
						`# implement-plan-loop final summary`,
						"",
						`Contract: ${loaded.relativePath}`,
						`Summary: ${review.summary}`,
						`Changed files: ${changedFiles.length}`,
						changedFiles.length > 0 ? `- ${changedFiles.join("\n- ")}` : "- (none)",
					].join("\n") + "\n";
					await fs.writeFile(artifactPaths.finalSummaryPath, finalSummary, "utf8");
					notify(ctx, `Implementation loop complete: ${review.summary}`, "info");
					return;
				}

				state = await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					status: "triaging-findings",
					updatedAt: new Date().toISOString(),
					lastReviewSummary: review.summary,
					lastBlockingCount: blockingCount,
					lastAdvisoryCount: advisoryCount,
					lastTransitionReason: "Blocking findings remain; selecting the next state-machine path.",
				});
				const triage = buildTriageDecision(review, state.iterations[state.iterations.length - 1], nextAction);
				await fs.writeFile(artifactPaths.triageJsonPath, JSON.stringify(triage, null, 2) + "\n", "utf8");
				const fixHandoffPath = triage.nextState === "repairing"
					? path.relative(loaded.repoRoot, artifactPaths.fixHandoffPath)
					: undefined;
				if (triage.nextState === "repairing") {
					const fixHandoff = renderFixHandoff(loaded.contract, review, { resolutionType: "implementation" });
					await fs.writeFile(artifactPaths.fixHandoffPath, fixHandoff, "utf8");
				}

				const iterationRecord: ImplementPlanLoopIteration = {
					iteration,
					mode: nextAction,
					implementationSummaryPath: nextAction === "gathering-evidence" ? undefined : path.relative(loaded.repoRoot, artifactPaths.implementationSummaryPath),
					reviewJsonPath: path.relative(loaded.repoRoot, artifactPaths.reviewJsonPath),
					reviewMarkdownPath: path.relative(loaded.repoRoot, artifactPaths.reviewMarkdownPath),
					triageJsonPath: path.relative(loaded.repoRoot, artifactPaths.triageJsonPath),
					evidenceBundlePath,
					externalValidationPath: undefined,
					fixHandoffPath,
					changedFilesPath: path.relative(loaded.repoRoot, artifactPaths.changedFilesPath),
					diffPath: path.relative(loaded.repoRoot, artifactPaths.diffPath),
					blockingCount,
					advisoryCount,
					implementationBlockingCount: triage.implementationBlockingCount,
					evidenceBlockingCount: triage.evidenceBlockingCount,
					externalValidationBlockingCount: triage.externalValidationBlockingCount,
					summary: review.summary,
					targetIds,
					targetFiles,
					changedFiles,
					blockerSignatures: triage.blockerSignatures,
					triageDecision: triage.nextState,
				};
				state = await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					updatedAt: new Date().toISOString(),
					lastTriageDecision: triage.nextState,
					lastTransitionReason: triage.reason,
					iterations: [...state.iterations, iterationRecord],
				});

				if (triage.nextState === "awaiting-external-validation") {
					const handoff = renderExternalValidationHandoff(loaded.contract, review);
					await fs.writeFile(artifactPaths.externalValidationPath, handoff, "utf8");
					await applyImplementLoopState({ ...ctx, pi }, {
						...state,
						active: false,
						status: "awaiting-external-validation",
						updatedAt: new Date().toISOString(),
						stopReason: "manual-validation-required",
						lastTransitionReason: triage.reason,
					});
					notify(ctx, `implement-plan-loop is awaiting external validation: ${triage.reason}`, "warning");
					return;
				}

				if (iteration === IMPLEMENT_LOOP_MAX_ITERATIONS || triage.nextState === "failed") {
					await applyImplementLoopState({ ...ctx, pi }, {
						...state,
						active: false,
						status: "failed",
						updatedAt: new Date().toISOString(),
						stopReason: iteration === IMPLEMENT_LOOP_MAX_ITERATIONS ? "safety-cap-unresolved" : "triage-failed",
						lastTransitionReason: triage.reason,
					});
					notify(ctx, `implement-plan-loop stopped: ${triage.reason}`, "warning");
					return;
				}

				previousReview = review;
				previousReviewSummary = review.summary;
				previousChangedFiles = changedFiles;
				previousDiffPreview = diffPreview;
				previousImplementationHandoff = triage.nextState === "repairing"
					? renderFixHandoff(loaded.contract, review, { resolutionType: "implementation" })
					: undefined;
				repoContext = await collectRepoContext(
					loaded.repoRoot,
					loaded.contract,
					triage.nextState === "repairing"
						? `${previousImplementationHandoff ?? ""}\n\n${implementationSummary}`
						: `${review.summary}\n\n${renderReviewMarkdown(review)}`,
				);
				nextAction = triage.nextState === "gathering-evidence" ? "gathering-evidence" : "repairing";
			}
		},
	});

	pi.registerCommand("implement-plan-loop-status", {
		description: "Show current implement-plan-loop status",
		handler: async (_args, ctx) => {
			const state = getImplementLoopState(ctx) ?? loadPersistedImplementLoopState(ctx);
			if (!state?.active && state?.status !== "completed" && state?.status !== "failed" && state?.status !== "awaiting-external-validation" && state?.status !== "cancelled") {
				notify(ctx, "No active implement-plan-loop session.", "warning");
				return;
			}
			if (typeof pi.sendMessage === "function") {
				pi.sendMessage({ customType: "implement-plan-loop-status", content: buildStatusBody(state!), display: true }, { triggerTurn: false });
			}
			notify(ctx, "Implementation loop status shown.", "info");
		},
	});

	pi.registerCommand("end-implement-plan-loop", {
		description: "End the current implement-plan-loop session state",
		handler: async (_args, ctx) => {
			const state = getImplementLoopState(ctx) ?? loadPersistedImplementLoopState(ctx);
			if (state) {
				await applyImplementLoopState({ ...ctx, pi }, {
					...state,
					active: false,
					status: "cancelled",
					updatedAt: new Date().toISOString(),
					stopReason: "user-cancelled",
					lastTransitionReason: "Loop ended explicitly by the user.",
				});
			} else {
				await clearImplementLoopState({ ...ctx, pi });
			}
			notify(ctx, "implement-plan-loop ended.", "info");
		},
	});
}
