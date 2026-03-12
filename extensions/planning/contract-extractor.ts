import { complete, type Api, type Model, type UserMessage } from "../lib/pi-ai-compat.ts";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExecutionContract } from "./contract-schema.ts";
import { validateExecutionContract } from "./contract-validator.ts";

const EXTRACTION_SYSTEM_PROMPT = `You extract a thin execution contract from a raw planning artifact.

Return strict JSON with this shape:
{
  "artifactType": "execution-contract",
  "version": 1,
  "generatedAt": "...",
  "source": {
    "rawArtifactPath": "...",
    "rawArtifactKind": "markdown" | "json" | "hybrid"
  },
  "goal": "...",
  "requirements": [
    {
      "id": "REQ-1",
      "text": "...",
      "kind": "behavioral" | "operational",
      "priority": "primary" | "secondary",
      "source": "..."
    }
  ],
  "checks": [
    {
      "id": "CHK-1",
      "text": "...",
      "kind": "test" | "verification",
      "source": "..."
    }
  ],
  "ambiguities": [
    {
      "id": "AMB-1",
      "text": "...",
      "blocksExecution": true,
      "source": "..."
    }
  ],
  "evidence": [
    {
      "path": "...",
      "reason": "..."
    }
  ],
  "outOfScope": ["..."],
  "status": "draft" | "blocked" | "ready",
  "contractIssues": ["..."],
  "advisoryNotes": ["..."]
}

Rules:
- Interpret semantically; do not rely on exact field names in the raw artifact.
- If the raw artifact is a bug/regression report, infer executable requirements/checks from the symptom + restore intent when they are clear.
- If the raw artifact is design-led, infer concrete UI/behavior requirements where they are clearly implied.
- Use contractIssues only for readiness-blocking deficiencies in the contract itself, such as missing goal, missing executable requirements/checks, or unresolved missing clarification that prevents downstream execution.
- Put non-blocking caveats, deployment notes, environment access limits, timestamp normalization notes, and other advisory observations into advisoryNotes, not contractIssues.
- Mark status as blocked only when missing information truly prevents useful downstream work.
- Prefer a usable ready contract over draft when the intended behavior is sufficiently clear.
- Return raw JSON only. No markdown fences.`;

function stripCodeFences(text: string): string {
	const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	return match ? match[1].trim() : text.trim();
}

function parseJson<T>(text: string): T | null {
	try {
		return JSON.parse(stripCodeFences(text)) as T;
	} catch {
		return null;
	}
}

export async function extractExecutionContract(ctx: ExtensionContext, input: {
	rawArtifactPath: string;
	rawArtifactKind: "markdown" | "json" | "hybrid";
	rawArtifactText: string;
	repoContextSummary?: string;
	relevantFiles?: Array<{ path: string; reason?: string }>;
	signal?: AbortSignal;
}): Promise<ExecutionContract | null> {
	if (!ctx.model) throw new Error("No active model selected");
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) throw new Error("Authenticate the active model first");

	const files = (input.relevantFiles ?? []).map((file) => `- ${file.path}${file.reason ? ` — ${file.reason}` : ""}`).join("\n");
	const prompt = [
		`Raw artifact path: ${input.rawArtifactPath}`,
		`Raw artifact kind: ${input.rawArtifactKind}`,
		input.repoContextSummary ? `Repo context:\n${input.repoContextSummary}` : undefined,
		files ? `Relevant files:\n${files}` : undefined,
		`Raw artifact:\n\n${input.rawArtifactText}`,
	].filter(Boolean).join("\n\n");

	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model as Model<Api>,
		{ systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [message] },
		{ apiKey, signal: input.signal },
	);
	if (response.stopReason === "aborted" || response.stopReason === "error") return null;
	const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
	const parsed = parseJson<ExecutionContract>(text);
	if (!parsed) return null;
	return validateExecutionContract(parsed);
}
