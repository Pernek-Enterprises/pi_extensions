import type { ExecutionContract } from "./contract-schema.ts";

const BLOCKING_ISSUE_PATTERNS = [
	/goal is missing\.?/i,
	/source raw artifact path is missing\.?/i,
	/no executable requirements or checks were compiled\.?/i,
	/not enough information/i,
	/insufficient information/i,
	/missing (required )?(clarification|information)/i,
	/cannot determine/i,
	/cannot infer/i,
	/unclear intended behavior/i,
];

function isBlockingContractIssue(issue: string): boolean {
	return BLOCKING_ISSUE_PATTERNS.some((pattern) => pattern.test(issue));
}

export function normalizeExecutionContract(contract: Partial<ExecutionContract> | null | undefined): ExecutionContract {
	return {
		artifactType: "execution-contract",
		version: 1,
		generatedAt: typeof contract?.generatedAt === "string" && contract.generatedAt.trim() ? contract.generatedAt : new Date().toISOString(),
		source: {
			rawArtifactPath: typeof contract?.source?.rawArtifactPath === "string" ? contract.source.rawArtifactPath : "",
			rawArtifactKind: contract?.source?.rawArtifactKind === "json" || contract?.source?.rawArtifactKind === "hybrid" ? contract.source.rawArtifactKind : "markdown",
		},
		goal: typeof contract?.goal === "string" ? contract.goal.trim() : "",
		requirements: Array.isArray(contract?.requirements) ? contract.requirements.filter((item) => typeof item?.text === "string" && item.text.trim()).map((item, index) => ({
			id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `REQ-${index + 1}`,
			text: item.text.trim(),
			kind: item.kind === "operational" ? "operational" : "behavioral",
			priority: item.priority === "secondary" ? "secondary" : "primary",
			source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : undefined,
		})) : [],
		checks: Array.isArray(contract?.checks) ? contract.checks.filter((item) => typeof item?.text === "string" && item.text.trim()).map((item, index) => ({
			id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `CHK-${index + 1}`,
			text: item.text.trim(),
			kind: item.kind === "verification" ? "verification" : "test",
			source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : undefined,
		})) : [],
		ambiguities: Array.isArray(contract?.ambiguities) ? contract.ambiguities.filter((item) => typeof item?.text === "string" && item.text.trim()).map((item, index) => ({
			id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `AMB-${index + 1}`,
			text: item.text.trim(),
			blocksExecution: item.blocksExecution === true,
			source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : undefined,
		})) : [],
		evidence: Array.isArray(contract?.evidence) ? contract.evidence.filter((item) => typeof item?.path === "string" && item.path.trim()).map((item) => ({
			path: item.path.trim(),
			reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : undefined,
		})) : [],
		outOfScope: Array.isArray(contract?.outOfScope) ? contract.outOfScope.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [],
		status: contract?.status === "blocked" || contract?.status === "ready" ? contract.status : "draft",
		contractIssues: Array.isArray(contract?.contractIssues) ? contract.contractIssues.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [],
		advisoryNotes: Array.isArray(contract?.advisoryNotes) ? contract.advisoryNotes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [],
	};
}

export function validateExecutionContract(contract: ExecutionContract): ExecutionContract {
	const normalized = normalizeExecutionContract(contract);
	const blockingIssues = normalized.contractIssues.filter(isBlockingContractIssue);
	const advisoryNotes = [
		...normalized.advisoryNotes,
		...normalized.contractIssues.filter((issue) => !isBlockingContractIssue(issue)),
	];
	if (!normalized.goal) blockingIssues.push("Goal is missing.");
	if (!normalized.source.rawArtifactPath) blockingIssues.push("Source raw artifact path is missing.");
	if (normalized.requirements.length === 0 && normalized.checks.length === 0) blockingIssues.push("No executable requirements or checks were compiled.");
	const hasBlockingAmbiguity = normalized.ambiguities.some((item) => item.blocksExecution);
	const status = hasBlockingAmbiguity ? "blocked" : blockingIssues.length === 0 ? "ready" : "draft";
	return {
		...normalized,
		status,
		contractIssues: [...new Set(blockingIssues)],
		advisoryNotes: [...new Set(advisoryNotes)],
	};
}
