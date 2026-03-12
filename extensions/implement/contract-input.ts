import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecutionContract } from "../planning/contract-schema.ts";
import { validateExecutionContract } from "../planning/contract-validator.ts";

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function detectRepoRoot(start: string): Promise<string> {
	let current = path.resolve(start);
	while (true) {
		if (await exists(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(start);
		current = parent;
	}
}

function parseJson<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export async function loadReadyImplementationContract(cwd: string, inputPath: string): Promise<{
	repoRoot: string;
	absolutePath: string;
	relativePath: string;
	contract: ExecutionContract;
}> {
	const absolutePath = path.resolve(cwd, inputPath);
	if (!(await exists(absolutePath))) throw new Error(`Execution contract not found: ${absolutePath}`);
	if (!/\.plan\.contract\.json$/i.test(absolutePath)) throw new Error("implement-plan-loop currently accepts only .plan.contract.json input.");
	const raw = await fs.readFile(absolutePath, "utf8");
	const parsed = parseJson<ExecutionContract>(raw);
	if (!parsed) throw new Error(`Invalid execution contract JSON: ${absolutePath}`);
	const contract = validateExecutionContract(parsed);
	if (contract.status === "blocked") throw new Error("Execution contract is blocked. Resolve blocking ambiguities before running /implement-plan-loop.");
	if (contract.status !== "ready") throw new Error(`Execution contract is not ready: ${contract.contractIssues.join(" ")}`.trim());
	const repoRoot = await detectRepoRoot(path.dirname(absolutePath));
	return {
		repoRoot,
		absolutePath,
		relativePath: path.relative(repoRoot, absolutePath),
		contract,
	};
}
