import { promises as fs } from "node:fs";
import path from "node:path";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type TestFramework = "vitest" | "jest" | "unknown";

type Requirement = {
	text: string;
	heading?: string;
};

type RepoContext = {
	framework: TestFramework;
	packageJsonPath?: string;
	testFileExamples: Array<{ path: string; preview: string }>;
	testDirectories: string[];
	testNamingPatterns: string[];
	sourceDirectories: string[];
	hasTestingLibrary: boolean;
	hasPlaywright: boolean;
	hasNodeEnvironment: boolean;
	hasReact: boolean;
	scripts: Record<string, string>;
};

type GeneratedSpec = {
	framework: TestFramework;
	outputPath?: string;
	testCode: string;
	coveredRequirements: string[];
	ambiguousRequirements?: string[];
	notes?: string[];
};

const SYSTEM_PROMPT = `You generate TypeScript test files from markdown implementation plans.

Return strict JSON with this shape:
{
  "framework": "vitest" | "jest",
  "outputPath": "tests/generated/some-name.plan.spec.ts",
  "testCode": "...",
  "coveredRequirements": ["..."],
  "ambiguousRequirements": ["..."],
  "notes": ["..."]
}

Rules:
- Generate ONLY tests, never implementation code.
- Use the repository context and existing examples to match local conventions closely.
- Prefer Vitest when framework says vitest. Prefer Jest when framework says jest.
- The file must be valid TypeScript.
- The tests must be RED first: they should fail until the plan is actually implemented.
- Do not use placeholder TODO comments as the primary failure mode; use executable expectations that fail until implementation exists, or explicit throw errors if the app wiring is impossible to infer.
- For each testable requirement, create at least one named test whose title includes the requirement text or a close paraphrase.
- Include a top comment saying the file was generated from a markdown plan.
- Reuse local test idioms, imports, setup style, and folder conventions when examples are provided.
- Favor the strongest realistic acceptance criteria you can infer from the plan and repository context.
- If a requirement is vague, still create the best failing acceptance test you can, and list it in ambiguousRequirements.
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

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function findUp(startDir: string, fileName: string): Promise<string | null> {
	let dir = path.resolve(startDir);
	while (true) {
		const candidate = path.join(dir, fileName);
		if (await exists(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function loadPackageJson(cwd: string): Promise<{ path: string; data: Record<string, any> } | null> {
	const packageJsonPath = await findUp(cwd, "package.json");
	if (!packageJsonPath) return null;
	try {
		const raw = await fs.readFile(packageJsonPath, "utf8");
		return { path: packageJsonPath, data: JSON.parse(raw) };
	} catch {
		return null;
	}
}

function detectFramework(pkg: Record<string, any> | null): TestFramework {
	if (!pkg) return "unknown";
	const deps = {
		...(pkg.dependencies ?? {}),
		...(pkg.devDependencies ?? {}),
	};
	if (deps.vitest) return "vitest";
	if (deps.jest || deps["ts-jest"] || deps["@types/jest"]) return "jest";
	return "unknown";
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/\.md$/i, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "plan";
}

function extractRequirements(markdown: string): Requirement[] {
	const lines = markdown.split(/\r?\n/);
	const requirements: Requirement[] = [];
	let inCode = false;
	let currentHeading: string | undefined;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (inCode || !line) continue;

		const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
		if (headingMatch) {
			currentHeading = headingMatch[1].trim();
			continue;
		}

		const bulletMatch = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/);
		if (bulletMatch) {
			requirements.push({ text: bulletMatch[1].trim(), heading: currentHeading });
			continue;
		}

		const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
		if (numberedMatch) {
			requirements.push({ text: numberedMatch[1].trim(), heading: currentHeading });
		}
	}

	return requirements;
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
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
			} else {
				out.push(full);
			}
		}
	}
	await walk(rootDir, 0);
	return out;
}

function uniq<T>(items: T[]): T[] {
	return [...new Set(items)];
}

async function inspectRepo(rootDir: string, pkg: Record<string, any> | null, framework: TestFramework): Promise<RepoContext> {
	const files = await listFiles(rootDir, 4);
	const rel = (p: string) => path.relative(rootDir, p);
	const testFiles = files.filter((file) => /\.(spec|test)\.(ts|tsx)$/.test(file));
	const examples = await Promise.all(
		testFiles.slice(0, 6).map(async (file) => {
			const content = await fs.readFile(file, "utf8").catch(() => "");
			return {
				path: rel(file),
				preview: content.split(/\r?\n/).slice(0, 40).join("\n"),
			};
		}),
	);

	const namingPatterns = uniq(
		testFiles.map((file) => {
			const name = path.basename(file);
			if (name.endsWith(".spec.tsx")) return ".spec.tsx";
			if (name.endsWith(".test.tsx")) return ".test.tsx";
			if (name.endsWith(".spec.ts")) return ".spec.ts";
			return ".test.ts";
		}),
	);

	const testDirs = uniq(testFiles.map((file) => path.dirname(rel(file)))).slice(0, 12);
	const sourceDirs = uniq(
		files
			.filter((file) => /\.(ts|tsx)$/.test(file) && !/\.(spec|test)\.(ts|tsx)$/.test(file))
			.map((file) => rel(file).split(path.sep)[0])
			.filter(Boolean),
	).slice(0, 12);

	const deps = {
		...(pkg?.dependencies ?? {}),
		...(pkg?.devDependencies ?? {}),
	};

	return {
		framework,
		packageJsonPath: pkg ? "package.json" : undefined,
		testFileExamples: examples,
		testDirectories: testDirs,
		testNamingPatterns: namingPatterns,
		sourceDirectories: sourceDirs,
		hasTestingLibrary: Boolean(deps["@testing-library/react"] || deps["@testing-library/jest-dom"]),
		hasPlaywright: Boolean(deps["playwright"] || deps["@playwright/test"]),
		hasNodeEnvironment: Boolean(deps["supertest"] || deps["express"] || deps["fastify"] || deps["hono"]),
		hasReact: Boolean(deps.react),
		scripts: pkg?.scripts ?? {},
	};
}

async function generateWithModel(
	ctx: ExtensionContext,
	framework: TestFramework,
	planPath: string,
	planText: string,
	requirements: Requirement[],
	outputPath: string,
	repoContext: RepoContext,
): Promise<GeneratedSpec | null> {
	if (!ctx.model) return null;
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;

	const requirementLines = requirements
		.map((req, i) => `- ${i + 1}. ${req.heading ? `[${req.heading}] ` : ""}${req.text}`)
		.join("\n");

	const exampleText = repoContext.testFileExamples.length
		? repoContext.testFileExamples
				.map((example, index) => `### Example ${index + 1}: ${example.path}\n${example.preview}`)
				.join("\n\n")
		: "(No existing test examples found)";

	const repoSummary = JSON.stringify(
		{
			framework,
			testDirectories: repoContext.testDirectories,
			testNamingPatterns: repoContext.testNamingPatterns,
			sourceDirectories: repoContext.sourceDirectories,
			hasTestingLibrary: repoContext.hasTestingLibrary,
			hasPlaywright: repoContext.hasPlaywright,
			hasNodeEnvironment: repoContext.hasNodeEnvironment,
			hasReact: repoContext.hasReact,
			scripts: repoContext.scripts,
		},
		null,
		2,
	);

	const userPrompt = `Framework: ${framework === "unknown" ? "Prefer Vitest but mirror local conventions" : framework}
Suggested output path: ${outputPath}
Plan path: ${planPath}

Repository context:
${repoSummary}

Existing test examples:
${exampleText}

Extracted requirements:
${requirementLines || "(none extracted; infer from full markdown)"}

Full markdown plan:

${planText}`;

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userPrompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model as Model<Api>,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey },
	);

	if (response.stopReason === "aborted" || response.stopReason === "error") return null;
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const parsed = parseJson<GeneratedSpec>(text);
	if (!parsed?.testCode) return null;
	return parsed;
}

async function ensureDir(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function pickDefaultOutputPath(rootDir: string, planPath: string, repoContext: RepoContext, suggested?: string): string {
	if (suggested) return path.resolve(rootDir, suggested);
	const slug = slugify(path.basename(planPath));
	const preferredDir =
		repoContext.testDirectories.find((dir) => dir === "tests" || dir.startsWith("tests/")) ??
		repoContext.testDirectories[0] ??
		"tests/generated";
	const preferredPattern =
		repoContext.testNamingPatterns.find((pattern) => pattern === ".spec.ts" || pattern === ".test.ts") ??
		(repoContext.framework === "jest" ? ".test.ts" : ".spec.ts");
	return path.join(rootDir, preferredDir, `${slug}.plan${preferredPattern}`);
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await ensureDir(filePath);
	await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export default function tddPlanExtension(pi: ExtensionAPI) {
	pi.registerCommand("tdd-plan", {
		description: "Generate TypeScript TDD tests from a markdown plan file",
		handler: async (args, ctx) => {
			let rawArgs = (args ?? "").trim();
			if (!rawArgs && ctx.hasUI) {
				const input = await ctx.ui.input("Markdown plan path", "specs/feature.md");
				if (!input?.trim()) {
					ctx.ui.notify("tdd-plan cancelled", "info");
					return;
				}
				rawArgs = input.trim();
			}

			if (!rawArgs) {
				ctx.ui.notify("Usage: /tdd-plan <plan.md> [--run]", "warning");
				return;
			}

			const runTests = rawArgs.includes("--run");
			const cleaned = rawArgs.replace(/\s--run\b|^--run\b/g, "").trim();
			const planPath = path.resolve(ctx.cwd, cleaned);

			if (!(await exists(planPath))) {
				ctx.ui.notify(`Plan file not found: ${planPath}`, "error");
				return;
			}

			const planText = await fs.readFile(planPath, "utf8");
			const requirements = extractRequirements(planText);
			if (requirements.length === 0) {
				ctx.ui.notify("No bullet/numbered requirements found. Refine the plan so tests can map to concrete criteria.", "warning");
			}

			const pkg = await loadPackageJson(ctx.cwd);
			const rootDir = pkg ? path.dirname(pkg.path) : ctx.cwd;
			const framework = detectFramework(pkg?.data ?? null);
			const repoContext = await inspectRepo(rootDir, pkg?.data ?? null, framework);
			const suggestedOutput = path.join("tests", "generated", `${slugify(path.basename(planPath))}.plan.spec.ts`);

			if (!ctx.model) {
				ctx.ui.notify("No active model selected. Select a model first, then run /tdd-plan again.", "error");
				return;
			}

			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			if (!apiKey) {
				ctx.ui.notify("The active model has no API key/session available. Authenticate first, then run /tdd-plan again.", "error");
				return;
			}

			const generated = await generateWithModel(
				ctx,
				framework,
				path.relative(rootDir, planPath),
				planText,
				requirements,
				suggestedOutput,
				repoContext,
			);
			if (!generated) {
				ctx.ui.notify("AI test generation failed. Try again with the active model, or switch models and retry.", "error");
				return;
			}

			const outputPath = pickDefaultOutputPath(rootDir, planPath, repoContext, generated.outputPath || suggestedOutput);
			const coveragePath = path.join(rootDir, ".pi", "generated-tdd", `${slugify(path.basename(planPath))}.coverage.json`);
			const ambiguousPath = path.join(rootDir, ".pi", "generated-tdd", `${slugify(path.basename(planPath))}.ambiguous.md`);

			if (await exists(outputPath) && ctx.hasUI) {
				const overwrite = await ctx.ui.confirm("Overwrite generated test file?", outputPath);
				if (!overwrite) {
					ctx.ui.notify("tdd-plan cancelled", "info");
					return;
				}
			}

			await ensureDir(outputPath);
			await fs.writeFile(outputPath, generated.testCode.endsWith("\n") ? generated.testCode : generated.testCode + "\n", "utf8");
			await writeJson(coveragePath, {
				planPath: path.relative(rootDir, planPath),
				framework: generated.framework,
				outputPath: path.relative(rootDir, outputPath),
				repoContext: {
					testDirectories: repoContext.testDirectories,
					testNamingPatterns: repoContext.testNamingPatterns,
					sourceDirectories: repoContext.sourceDirectories,
					hasTestingLibrary: repoContext.hasTestingLibrary,
					hasPlaywright: repoContext.hasPlaywright,
					hasNodeEnvironment: repoContext.hasNodeEnvironment,
					hasReact: repoContext.hasReact,
				},
				requirements: requirements.map((r) => ({ text: r.text, heading: r.heading ?? null })),
				coveredRequirements: generated.coveredRequirements,
				ambiguousRequirements: generated.ambiguousRequirements ?? [],
				notes: generated.notes ?? [],
				generatedAt: new Date().toISOString(),
			});

			const ambiguous = generated.ambiguousRequirements ?? [];
			if (ambiguous.length > 0) {
				await ensureDir(ambiguousPath);
				const body =
					`# Ambiguous requirements\n\nGenerated from: ${path.relative(rootDir, planPath)}\n\n` +
					ambiguous.map((item) => `- ${item}`).join("\n") +
					"\n";
				await fs.writeFile(ambiguousPath, body, "utf8");
			}

			if (runTests) {
				let command: string | null = null;
				if (generated.framework === "vitest" || framework === "vitest") {
					command = `npx vitest run ${JSON.stringify(path.relative(rootDir, outputPath))}`;
				} else if (generated.framework === "jest" || framework === "jest") {
					command = `npx jest ${JSON.stringify(path.relative(rootDir, outputPath))}`;
				}
				if (command) {
					const result = await pi.exec("bash", ["-lc", `cd ${JSON.stringify(rootDir)} && ${command}`]);
					if (result.code === 0) ctx.ui.notify("Generated tests already pass", "success");
					else ctx.ui.notify("Generated tests executed", "info");
				}
			}

			ctx.ui.notify(`Generated TDD tests: ${path.relative(rootDir, outputPath)}`, "success");
			if (repoContext.testFileExamples.length > 0) {
				ctx.ui.notify(`Matched local test conventions from ${repoContext.testFileExamples.length} example file(s)`, "info");
			}
			if (ambiguous.length > 0) {
				ctx.ui.notify(`Ambiguous requirements flagged: ${ambiguous.length}`, "warning");
			}
		},
	});
}
