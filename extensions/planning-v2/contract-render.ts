import { renderRawPlanMarkdown } from "./raw-artifact.ts";
import type { ExecutionContract } from "./contract-schema.ts";

export function renderMarkdownFromExecutionContract(contract: ExecutionContract, title?: string): string {
	return renderRawPlanMarkdown({
		title: title || contract.goal || "Feature plan",
		requestedFeature: contract.goal,
		sections: [
			contract.requirements.length > 0 ? {
				heading: "Requirements",
				items: contract.requirements.map((item) => item.text),
			} : undefined,
			contract.checks.length > 0 ? {
				heading: "Checks",
				items: contract.checks.map((item) => item.text),
			} : undefined,
			contract.ambiguities.length > 0 ? {
				heading: "Ambiguities",
				items: contract.ambiguities.map((item) => `${item.text}${item.blocksExecution ? " (blocking)" : ""}`),
			} : undefined,
			contract.evidence.length > 0 ? {
				heading: "Evidence",
				items: contract.evidence.map((item) => `${item.path}${item.reason ? ` — ${item.reason}` : ""}`),
			} : undefined,
			contract.outOfScope.length > 0 ? {
				heading: "Out of scope",
				items: contract.outOfScope,
			} : undefined,
		].filter(Boolean) as Array<{ heading: string; items?: string[]; body?: string }>,
	});
}
