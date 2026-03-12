import type { ExecutionContract } from "../planning/contract-schema.ts";

export type ReviewResolutionType = "implementation" | "evidence" | "external-validation";

export type ImplementationReviewFinding = {
	category: "coverage" | "repo-mismatch" | "runtime-behavior" | "config-gap" | "regression-risk" | "other";
	disposition: "blocking" | "advisory";
	resolutionType: ReviewResolutionType;
	title: string;
	details: string;
	suggestedFix: string;
	targetIds: string[];
	targetFiles: string[];
	confidence?: "high" | "medium" | "low";
};

export type ImplementationReviewResult = {
	verdict: "pass" | "fail";
	summary: string;
	satisfiedRequirementIds: string[];
	partialRequirementIds: string[];
	unsatisfiedRequirementIds: string[];
	supportedCheckIds: string[];
	unsupportedCheckIds: string[];
	findings: ImplementationReviewFinding[];
	strengths?: string[];
};

function renderContract(contract: ExecutionContract): string {
	return JSON.stringify(contract, null, 2);
}

function extractBalancedJson(text: string): string | null {
	const start = text.search(/[\[{]/);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") depth++;
		if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

export function parseJson<T>(text: string): T | null {
	const candidates = [
		text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
		text.trim(),
		extractBalancedJson(text),
	].filter((value): value is string => Boolean(value && value.trim()));
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as T;
		} catch {
			continue;
		}
	}
	return null;
}

export function buildImplementationPrompt(input: {
	contract: ExecutionContract;
	repoContext: string;
	fixHandoff?: string;
	previousSummary?: string;
	changedFiles?: string[];
}): string {
	return [
		"You are implementing a ready execution contract directly in the repository.",
		"Make real repository changes. Do not fabricate substitute implementations in summaries or tests.",
		"Use the contract and repo evidence as the source of truth.",
		"Prefer minimal, high-leverage changes that satisfy primary requirements first.",
		"If this is a repair pass, preserve already-good changes and focus on the current implementation blockers.",
		"After making changes, end your response with a concise `## Implementation summary` section containing:",
		"- changed files",
		"- key contract ids addressed",
		"- remaining risks or caveats",
		"",
		"Execution contract:",
		renderContract(input.contract),
		input.repoContext ? `Repo context:\n${input.repoContext}` : "",
		input.previousSummary ? `Previous implementation/review summary:\n${input.previousSummary}` : "",
		input.changedFiles?.length ? `Previously changed files:\n- ${input.changedFiles.join("\n- ")}` : "",
		input.fixHandoff ? `Current implementation fix handoff:\n\n${input.fixHandoff}` : "",
	].filter(Boolean).join("\n\n");
}

export function buildReviewSystemPrompt(): string {
	return [
		"You review repository implementation against an execution contract.",
		"Return strict JSON only.",
		"Review against the contract first, not general style preferences.",
		"Use blocker findings only for gaps that should keep the implementation loop going.",
		"Merge overlapping issues and return at most 3 blocking findings.",
		"Every finding must include a resolutionType:",
		"- implementation: repository behavior/config/code must change",
		"- evidence: the implementation may already be correct, but the supplied repo evidence is insufficient to verify it",
		"- external-validation: local repo state may be sufficient, but deployed/runtime/platform validation is still required",
		"Use evidence when the blocker is really about missing proof, missing file visibility, unsupported checks caused by incomplete evidence, or not being able to verify the current repo state from the material provided.",
		"Use external-validation only when the remaining uncertainty truly depends on deployment/runtime/platform behavior rather than more repo inspection.",
		"Do not reward fabricated stand-ins or fake implementations that do not change real repository behavior.",
		"JSON shape:",
		"{",
		'  "verdict": "pass" | "fail",',
		'  "summary": "...",',
		'  "satisfiedRequirementIds": ["REQ-1"],',
		'  "partialRequirementIds": ["REQ-2"],',
		'  "unsatisfiedRequirementIds": ["REQ-3"],',
		'  "supportedCheckIds": ["CHK-1"],',
		'  "unsupportedCheckIds": ["CHK-2"],',
		'  "findings": [{',
		'    "category": "coverage" | "repo-mismatch" | "runtime-behavior" | "config-gap" | "regression-risk" | "other",',
		'    "disposition": "blocking" | "advisory",',
		'    "resolutionType": "implementation" | "evidence" | "external-validation",',
		'    "title": "...",',
		'    "details": "...",',
		'    "suggestedFix": "...",',
		'    "targetIds": ["REQ-3", "CHK-2"],',
		'    "targetFiles": ["src/App.tsx"],',
		'    "confidence": "high" | "medium" | "low"',
		"  }],",
		'  "strengths": ["..."]',
		"}",
	].join("\n");
}

export function buildReviewUserPrompt(input: {
	contract: ExecutionContract;
	repoContext: string;
	implementationSummary: string;
	changedFiles: string[];
	changedFilePreviews: Array<{ path: string; preview: string }>;
	diffPreview?: string;
	evidenceBundle?: string;
	reviewMode?: "implementation-review" | "evidence-rereview";
}): string {
	return [
		input.reviewMode === "evidence-rereview"
			? "This is an evidence re-review. Prefer evaluating the existing repository implementation against the newly supplied evidence. Do not introduce unrelated new blocker families unless the evidence directly reveals them."
			: "Review whether the implementation now satisfies the contract.",
		"Execution contract:",
		renderContract(input.contract),
		input.repoContext ? `Repo context:\n${input.repoContext}` : "",
		`Implementation summary:\n${input.implementationSummary}`,
		input.changedFiles.length > 0 ? `Changed files:\n- ${input.changedFiles.join("\n- ")}` : "Changed files:\n- (none detected)",
		input.changedFilePreviews.length > 0
			? `Changed file previews:\n${input.changedFilePreviews.map((item) => `--- FILE: ${item.path} ---\n${item.preview}`).join("\n\n")}`
			: "",
		input.diffPreview ? `Diff preview:\n${input.diffPreview}` : "",
		input.evidenceBundle ? `Evidence bundle:\n${input.evidenceBundle}` : "",
	].filter(Boolean).join("\n\n");
}

export function renderReviewMarkdown(review: ImplementationReviewResult): string {
	const findings = review.findings.length > 0
		? review.findings.map((finding, index) => [
			`## Finding ${index + 1}: ${finding.title}`,
			`- disposition: ${finding.disposition}`,
			`- resolution type: ${finding.resolutionType}`,
			`- category: ${finding.category}`,
			finding.confidence ? `- confidence: ${finding.confidence}` : undefined,
			finding.targetIds.length > 0 ? `- target ids: ${finding.targetIds.join(", ")}` : undefined,
			finding.targetFiles.length > 0 ? `- target files: ${finding.targetFiles.join(", ")}` : undefined,
			`- details: ${finding.details}`,
			`- suggested fix: ${finding.suggestedFix}`,
		].filter(Boolean).join("\n")).join("\n\n")
		: "No findings.";
	return [
		`# Implementation review`,
		"",
		`Verdict: ${review.verdict}`,
		`Summary: ${review.summary}`,
		"",
		`Satisfied requirements: ${review.satisfiedRequirementIds.join(", ") || "(none)"}`,
		`Partial requirements: ${review.partialRequirementIds.join(", ") || "(none)"}`,
		`Unsatisfied requirements: ${review.unsatisfiedRequirementIds.join(", ") || "(none)"}`,
		`Supported checks: ${review.supportedCheckIds.join(", ") || "(none)"}`,
		`Unsupported checks: ${review.unsupportedCheckIds.join(", ") || "(none)"}`,
		"",
		findings,
	].join("\n").trim() + "\n";
}

export function renderFixHandoff(
	contract: ExecutionContract,
	review: ImplementationReviewResult,
	options?: { resolutionType?: ReviewResolutionType },
): string {
	const findings = review.findings.filter(
		(finding) => finding.disposition === "blocking" && (!options?.resolutionType || finding.resolutionType === options.resolutionType),
	);
	return [
		`# Implement loop fix handoff`,
		"",
		`Goal: ${contract.goal}`,
		`Summary: ${review.summary}`,
		options?.resolutionType ? `Resolution type focus: ${options.resolutionType}` : undefined,
		"",
		...(findings.length > 0
			? findings.map((finding, index) => [
				`## Blocker ${index + 1}: ${finding.title}`,
				`- resolution type: ${finding.resolutionType}`,
				finding.targetIds.length > 0 ? `- target ids: ${finding.targetIds.join(", ")}` : undefined,
				finding.targetFiles.length > 0 ? `- target files: ${finding.targetFiles.join(", ")}` : undefined,
				`- details: ${finding.details}`,
				`- suggested fix: ${finding.suggestedFix}`,
			].filter(Boolean).join("\n"))
			: ["No blocking findings."])
	].filter(Boolean).join("\n").trim() + "\n";
}
