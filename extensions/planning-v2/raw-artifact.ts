import path from "node:path";

export function buildRawPlanPath(slug: string): string {
	return path.join(".pi", "plans", `${slug}.plan.md`);
}

export function buildExecutionContractPath(planPath: string): string {
	if (planPath.endsWith(".plan.contract.json")) return planPath;
	if (planPath.endsWith(".plan.md")) return planPath.replace(/\.plan\.md$/i, ".plan.contract.json");
	if (planPath.endsWith(".md")) return planPath.replace(/\.md$/i, ".plan.contract.json");
	return `${planPath}.plan.contract.json`;
}

export function renderRawPlanMarkdown(input: {
	title: string;
	requestedFeature: string;
	repoContextSummary?: string;
	sections?: Array<{ heading: string; items?: string[]; body?: string }>;
}): string {
	const blocks = [
		`# Plan: ${input.title}`,
		"",
		`## Requested feature\n${input.requestedFeature}`,
		input.repoContextSummary ? `## Existing codebase context\n${input.repoContextSummary}` : "",
		...(input.sections ?? []).map((section) => {
			const items = (section.items ?? []).filter(Boolean);
			if (items.length > 0) return `## ${section.heading}\n${items.map((item) => `- ${item}`).join("\n")}`;
			if (section.body?.trim()) return `## ${section.heading}\n${section.body.trim()}`;
			return "";
		}),
	].filter(Boolean);
	return blocks.join("\n\n").trim() + "\n";
}
