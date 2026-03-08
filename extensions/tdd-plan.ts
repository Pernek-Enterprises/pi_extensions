import { promises as fs } from "node:fs";
import path from "node:path";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

type TestFramework = "vitest" | "jest" | "unknown";

type Requirement = {
	text: string;
	heading?: string;
};

type MarkdownSection = {
	index: number;
	heading?: string;
	content: string;
	priority: number;
};

type PromptRequirements = {
	text: string;
	omittedCount: number;
};

type PromptPlan = {
	text: string;
	truncated: boolean;
	omittedSectionCount: number;
};

type RepoContext = {
	framework: TestFramework;
	packageJsonPath?: string;
	testFileExamples: Array<{ path: string; preview: string }>;
	testDirectories: string[];
	testNamingPatterns: string[];
	testConfigDirectories: string[];
	testConfigPatterns: string[];
	testScriptDirectories: string[];
	testScriptPatterns: string[];
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

const MAX_PLAN_CHARS = 24_000;
const MAX_REQUIREMENTS_IN_PROMPT = 80;
const SECTION_SUMMARY_MAX_CHARS = 1_200;

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

	const testScripts = getTestScriptEntries(pkg.scripts).map(([, script]) => script).join("\n");
	if (/\bvitest\b/.test(testScripts)) return "vitest";
	if (/\bjest\b/.test(testScripts)) return "jest";
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

function getSectionPriority(heading?: string): number {
	if (!heading) return 0;
	const normalized = heading.toLowerCase();
	if (/acceptance|success criteria|definition of done/.test(normalized)) return 6;
	if (/edge cases?|failure|errors?|risks?|constraints?|non-goals?/.test(normalized)) return 5;
	if (/tests?|test cases?|scenarios?|validation|qa/.test(normalized)) return 4;
	if (/requirements?|behavior|expected|outcomes?/.test(normalized)) return 3;
	if (/implementation|approach|design|architecture/.test(normalized)) return 1;
	return 2;
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

function splitMarkdownSections(markdown: string): MarkdownSection[] {
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
			current = { heading: headingMatch[1].trim(), lines: [line] };
			continue;
		}
		current.lines.push(line);
	}
	pushCurrent();

	if (sections.length <= 1) {
		const paragraphs = markdown
			.split(/\n\s*\n+/)
			.map((chunk) => chunk.trim())
			.filter(Boolean)
			.map((content) => ({ heading: undefined, lines: content.split(/\r?\n/) }));
		if (paragraphs.length > 1) {
			return paragraphs.map((section, index) => ({
				index,
				heading: section.heading,
				content: section.lines.join("\n").trim(),
				priority: getSectionPriority(section.heading),
			}));
		}
	}

	return sections.map((section, index) => ({
		index,
		heading: section.heading,
		content: section.lines.join("\n").trim(),
		priority: getSectionPriority(section.heading),
	}));
}

function buildPromptRequirements(requirements: Requirement[]): PromptRequirements {
	if (requirements.length <= MAX_REQUIREMENTS_IN_PROMPT) {
		return {
			text: requirements.map((req, i) => `- ${i + 1}. ${req.heading ? `[${req.heading}] ` : ""}${req.text}`).join("\n"),
			omittedCount: 0,
		};
	}

	const ranked = requirements.map((req, index) => {
		const headingPriority = getSectionPriority(req.heading);
		const tailBonus = index >= Math.floor(requirements.length * 0.75) ? 2 : index >= Math.floor(requirements.length * 0.5) ? 1 : 0;
		return { req, index, score: headingPriority * 10 + tailBonus };
	});

	const selectedIndexes = new Set(
		ranked
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, MAX_REQUIREMENTS_IN_PROMPT)
			.map((item) => item.index),
	);

	const selected = requirements
		.map((req, index) => ({ req, index }))
		.filter((item) => selectedIndexes.has(item.index));

	return {
		text: selected.map((item) => `- ${item.index + 1}. ${item.req.heading ? `[${item.req.heading}] ` : ""}${item.req.text}`).join("\n"),
		omittedCount: requirements.length - selected.length,
	};
}

function summarizeSection(section: MarkdownSection, maxChars: number): string {
	const lines = section.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (section.content.length <= maxChars) return section.content;

	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		const addition = `${line}\n`;
		if (used + addition.length > maxChars) break;
		out.push(line);
		used += addition.length;
	}

	const summary = out.join("\n").trim();
	if (!summary) return `${section.heading ? `## ${section.heading}\n` : ""}[section summary omitted due to size]`;
	return `${summary}\n\n[section summarized; omitted ${section.content.length - summary.length} characters]`;
}

function buildPromptPlan(markdown: string): PromptPlan {
	if (markdown.length <= MAX_PLAN_CHARS) {
		return { text: markdown, truncated: false, omittedSectionCount: 0 };
	}

	const sections = splitMarkdownSections(markdown);
	if (sections.length === 0) {
		const pseudoSection: MarkdownSection = { index: 0, content: markdown, priority: 0 };
		return { text: summarizeSection(pseudoSection, MAX_PLAN_CHARS), truncated: true, omittedSectionCount: 0 };
	}

	const selected = new Map<number, string>();
	let remaining = MAX_PLAN_CHARS;
	const separatorCost = (currentCount: number) => (currentCount > 0 ? 2 : 0);
	const tryInclude = (section: MarkdownSection, text: string) => {
		if (selected.has(section.index)) return false;
		const cost = text.length + separatorCost(selected.size);
		if (cost > remaining) return false;
		selected.set(section.index, text);
		remaining -= cost;
		return true;
	};

	const leadBudget = Math.min(4_000, Math.max(1_000, Math.floor(MAX_PLAN_CHARS * 0.2)));
	tryInclude(sections[0], summarizeSection(sections[0], leadBudget));

	for (const section of [...sections.slice(1)].sort((a, b) => b.priority - a.priority || a.index - b.index)) {
		if (remaining <= 200) break;
		tryInclude(section, summarizeSection(section, Math.min(SECTION_SUMMARY_MAX_CHARS, remaining)));
	}

	for (const section of [...sections].sort((a, b) => b.priority - a.priority || a.index - b.index)) {
		const current = selected.get(section.index);
		if (!current || current === section.content) continue;
		const extraCost = section.content.length - current.length;
		if (extraCost <= remaining) {
			selected.set(section.index, section.content);
			remaining -= extraCost;
		}
	}

	const selectedSections = sections.filter((section) => selected.has(section.index));
	const text = selectedSections.map((section) => selected.get(section.index)!).join("\n\n");
	return {
		text,
		truncated: true,
		omittedSectionCount: sections.length - selectedSections.length,
	};
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

function getConfigTestEntries(files: string[]): string[] {
	return files.filter((file) => {
		const name = path.basename(file);
		return /^(?:vitest|vite|jest|playwright|mocha)(?:\.workspace)?\.config\.(?:[cm]?[jt]s|mjs|cjs|mts|cts)$/.test(name);
	});
}

function inferTestDirectoriesFromText(texts: string[]): string[] {
	const dirs: string[] = [];
	for (const text of texts) {
		for (const match of text.matchAll(/(?:^|[\s"'`[(,])((?:__tests__|tests|test|src)(?:\/[A-Za-z0-9._*:-]+)*)?(?=\/|$|[\s"'`),\]])/g)) {
			let candidate = match[1]?.replace(/\/$/, "") ?? "";
			candidate = candidate.replace(/\/\*\*?(?:\/.*)?$/, "");
			if (!candidate) continue;
			if (/[{*]/.test(path.basename(candidate))) {
				dirs.push(path.dirname(candidate));
			} else if (/\.(?:[cm]?[jt]sx?|mjs|cjs|mts|cts)$/.test(candidate)) {
				dirs.push(path.dirname(candidate));
			} else {
				dirs.push(candidate);
			}
		}
	}
	return uniq(dirs.filter((dir) => dir && dir !== "."));
}

function inferTestPatternsFromText(texts: string[]): string[] {
	const patterns: string[] = [];
	for (const text of texts) {
		for (const match of text.matchAll(/\.(spec|specs|test|tests)\.(tsx?|jsx?|mjs|cjs|mts|cts|js)/g)) {
			patterns.push(`.${match[1]}.${match[2]}`);
		}
		if (/\bnode\s+--test\b/.test(text)) patterns.push(".test.ts");
	}
	return uniq(patterns);
}

function getTestScriptEntries(scripts: Record<string, string> | undefined): Array<[string, string]> {
	return Object.entries(scripts ?? {}).filter(([name]) => name === "test" || name.startsWith("test:"));
}

function inferScriptTestDirectories(scriptEntries: Array<[string, string]>): string[] {
	return inferTestDirectoriesFromText(scriptEntries.map(([, script]) => script));
}

function inferScriptTestPatterns(scriptEntries: Array<[string, string]>): string[] {
	return inferTestPatternsFromText(scriptEntries.map(([, script]) => script));
}

async function inspectRepo(rootDir: string, pkg: Record<string, any> | null, framework: TestFramework): Promise<RepoContext> {
	const files = await listFiles(rootDir, 4);
	const rel = (p: string) => path.relative(rootDir, p);
	const testFiles = files.filter((file) => /\.(spec|specs|test|tests)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file));
	const examples = await Promise.all(
		testFiles.slice(0, 6).map(async (file) => {
			const content = await fs.readFile(file, "utf8").catch(() => "");
			return {
				path: rel(file),
				preview: content.split(/\r?\n/).slice(0, 40).join("\n"),
			};
		}),
	);

	const supportedPatterns = [
		".tests.mjs",
		".test.mjs",
		".tests.cjs",
		".test.cjs",
		".tests.js",
		".test.js",
		".tests.jsx",
		".test.jsx",
		".tests.tsx",
		".test.tsx",
		".spec.tsx",
		".tests.ts",
		".test.ts",
		".spec.ts",
		".tests.js",
		".test.js",
		".spec.js",
		".tests.mts",
		".test.mts",
		".spec.mts",
		".tests.cts",
		".test.cts",
		".spec.cts",
	];
	const namingPatterns = uniq(
		testFiles.map((file) => {
			const name = path.basename(file);
			return supportedPatterns.find((pattern) => name.endsWith(pattern)) ?? ".test.ts";
		}),
	);

	const testDirs = uniq(testFiles.map((file) => path.dirname(rel(file)))).slice(0, 12);
	const sourceDirs = uniq(
		files
			.filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file) && !/\.(spec|specs|test|tests)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file))
			.map((file) => rel(file).split(path.sep)[0])
			.filter(Boolean),
	).slice(0, 12);

	const deps = {
		...(pkg?.dependencies ?? {}),
		...(pkg?.devDependencies ?? {}),
	};
	const configFiles = getConfigTestEntries(files);
	const configContents = await Promise.all(configFiles.map((file) => fs.readFile(file, "utf8").catch(() => "")));
	const configTestDirectories = inferTestDirectoriesFromText(configContents);
	const configTestPatterns = inferTestPatternsFromText(configContents);
	const scriptEntries = getTestScriptEntries(pkg?.scripts);
	const scriptTestDirectories = inferScriptTestDirectories(scriptEntries);
	const scriptTestPatterns = inferScriptTestPatterns(scriptEntries);

	return {
		framework,
		packageJsonPath: pkg ? "package.json" : undefined,
		testFileExamples: examples,
		testDirectories: testDirs,
		testNamingPatterns: namingPatterns,
		testConfigDirectories: configTestDirectories,
		testConfigPatterns: configTestPatterns,
		testScriptDirectories: scriptTestDirectories,
		testScriptPatterns: scriptTestPatterns,
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
	signal?: AbortSignal,
): Promise<GeneratedSpec | null> {
	if (!ctx.model) return null;
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;

	const promptRequirements = buildPromptRequirements(requirements);
	const promptPlan = buildPromptPlan(planText);

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
			testConfigDirectories: repoContext.testConfigDirectories,
			testConfigPatterns: repoContext.testConfigPatterns,
			testScriptDirectories: repoContext.testScriptDirectories,
			testScriptPatterns: repoContext.testScriptPatterns,
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
${promptRequirements.text || "(none extracted; infer from full markdown)"}
${promptRequirements.omittedCount > 0 ? `\n(${promptRequirements.omittedCount} extracted requirements omitted after prioritizing acceptance criteria, edge cases, and later sections)` : ""}

Full markdown plan:

${promptPlan.text}
${promptPlan.truncated ? `\n\n[plan condensed for prompt size; omitted ${promptPlan.omittedSectionCount} lower-priority section(s)]` : ""}`;

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userPrompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model as Model<Api>,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, signal },
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

function isGenericSuggestedOutput(suggested?: string): boolean {
	if (!suggested) return true;
	const normalized = suggested.replace(/\\/g, "/");
	return /(^|\/)tests\/generated(?:\/|$)/.test(normalized);
}

function isPathInsideRoot(rootDir: string, filePath: string): boolean {
	const relative = path.relative(rootDir, filePath);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeSuggestedOutputPath(rootDir: string, suggested?: string): string | null {
	if (!suggested?.trim()) return null;
	const resolved = path.resolve(rootDir, suggested.trim());
	if (!isPathInsideRoot(rootDir, resolved)) return null;
	if (!/\.(?:[cm]?[jt]sx?|mjs|cjs|mts|cts)$/i.test(resolved)) return null;
	return resolved;
}

function choosePreferredTestPattern(repoContext: RepoContext): string {
	const preferredConfigPattern = repoContext.testConfigPatterns[0];
	if (preferredConfigPattern) return preferredConfigPattern;
	const preferredScriptPattern = repoContext.testScriptPatterns[0];
	if (preferredScriptPattern) return preferredScriptPattern;
	const preferredNamedPattern = repoContext.testNamingPatterns[0];
	if (preferredNamedPattern) return preferredNamedPattern;
	return repoContext.framework === "jest" ? ".test.ts" : ".spec.ts";
}

function choosePreferredTestDirectory(repoContext: RepoContext): string {
	const candidates = [
		...repoContext.testConfigDirectories,
		...repoContext.testScriptDirectories,
		...repoContext.testDirectories,
	];

	for (const dir of candidates) {
		if (dir === "__tests__" || dir.endsWith("/__tests__")) return dir;
	}
	for (const dir of candidates) {
		if (dir === "tests" || dir.startsWith("tests/")) return dir;
	}
	for (const dir of candidates) {
		if (dir === "test" || dir.startsWith("test/")) return dir;
	}
	for (const dir of candidates) {
		if (dir === "src" || dir.startsWith("src/")) return dir;
	}
	if (repoContext.hasReact && repoContext.sourceDirectories.includes("src")) return "src";
	return repoContext.testConfigDirectories[0] ?? repoContext.testScriptDirectories[0] ?? repoContext.testDirectories[0] ?? "tests";
}

function buildDiscoveryAwareOutputPath(rootDir: string, planPath: string, repoContext: RepoContext): string {
	const slug = slugify(path.basename(planPath));
	const preferredDir = choosePreferredTestDirectory(repoContext);
	const preferredPattern = choosePreferredTestPattern(repoContext);
	return path.join(rootDir, preferredDir, `${slug}.plan${preferredPattern}`);
}

function pickDefaultOutputPath(rootDir: string, planPath: string, repoContext: RepoContext, suggested?: string): string {
	const normalizedSuggested = normalizeSuggestedOutputPath(rootDir, suggested);
	if (normalizedSuggested && !isGenericSuggestedOutput(normalizedSuggested)) return normalizedSuggested;
	return buildDiscoveryAwareOutputPath(rootDir, planPath, repoContext);
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await ensureDir(filePath);
	await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI && typeof ctx.ui.notify === "function") ctx.ui.notify(message, level);
}

async function runWithLoader<T>(
	ctx: ExtensionContext,
	message: string,
	work: (signal?: AbortSignal) => Promise<T>,
): Promise<{ cancelled: boolean; result?: T; error?: unknown }> {
	if (!ctx.hasUI) {
		try {
			return { cancelled: false, result: await work() };
		} catch (error) {
			return { cancelled: false, error };
		}
	}

	const result = await ctx.ui.custom<{ cancelled: boolean; result?: T; error?: unknown }>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, message);
		let settled = false;
		const finish = (value: { cancelled: boolean; result?: T; error?: unknown }) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		loader.onAbort = () => finish({ cancelled: true });

		work(loader.signal)
			.then((value) => finish({ cancelled: false, result: value }))
			.catch((error) => {
				if (loader.signal.aborted) finish({ cancelled: true });
				else finish({ cancelled: false, error });
			});

		return loader;
	});

	return result ?? { cancelled: true };
}

export const __testables = {
	detectFramework,
	getConfigTestEntries,
	inferTestDirectoriesFromText,
	inferTestPatternsFromText,
	inferScriptTestDirectories,
	inferScriptTestPatterns,
	isGenericSuggestedOutput,
	normalizeSuggestedOutputPath,
	choosePreferredTestPattern,
	choosePreferredTestDirectory,
	buildDiscoveryAwareOutputPath,
	pickDefaultOutputPath,
};

export default function tddPlanExtension(pi: ExtensionAPI) {
	pi.registerCommand("tdd-plan", {
		description: "Generate TypeScript TDD tests from a markdown plan file",
		handler: async (args, ctx) => {
			let rawArgs = (args ?? "").trim();
			if (!rawArgs && ctx.hasUI) {
				const input = await ctx.ui.input("Markdown plan path", "specs/feature.md");
				if (!input?.trim()) {
					notify(ctx, "tdd-plan cancelled", "info");
					return;
				}
				rawArgs = input.trim();
			}

			if (!rawArgs) {
				notify(ctx, "Usage: /tdd-plan <plan.md> [--run]", "warning");
				return;
			}

			const runTests = rawArgs.includes("--run");
			const cleaned = rawArgs.replace(/\s--run\b|^--run\b/g, "").trim();
			const planPath = path.resolve(ctx.cwd, cleaned);

			if (!(await exists(planPath))) {
				notify(ctx, `Plan file not found: ${planPath}`, "error");
				return;
			}

			const planText = await fs.readFile(planPath, "utf8");
			const requirements = extractRequirements(planText);
			if (requirements.length === 0) {
				notify(ctx, "No bullet/numbered requirements found. Refine the plan so tests can map to concrete criteria.", "warning");
			}

			const pkg = await loadPackageJson(ctx.cwd);
			const rootDir = pkg ? path.dirname(pkg.path) : ctx.cwd;
			const framework = detectFramework(pkg?.data ?? null);
			const repoScan = await runWithLoader(ctx, "Inspecting repository for local test conventions...", async () =>
				inspectRepo(rootDir, pkg?.data ?? null, framework),
			);
			if (repoScan.cancelled) {
				notify(ctx, "tdd-plan cancelled", "info");
				return;
			}
			if (repoScan.error || !repoScan.result) {
				notify(ctx, "Failed to inspect repository context for tdd-plan.", "error");
				return;
			}
			const repoContext = repoScan.result;
			const suggestedOutput = buildDiscoveryAwareOutputPath(rootDir, planPath, repoContext);

			if (!ctx.model) {
				notify(ctx, "No active model selected. Select a model first, then run /tdd-plan again.", "error");
				return;
			}

			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			if (!apiKey) {
				notify(ctx, "The active model has no API key/session available. Authenticate first, then run /tdd-plan again.", "error");
				return;
			}

			if (planText.length > MAX_PLAN_CHARS) {
				notify(ctx, 
					`Plan is large (${planText.length.toLocaleString()} chars). Sending a section-aware condensed version to the model to avoid stalls.`,
					"warning",
				);
			}

			const generation = await runWithLoader(ctx, `Generating TDD tests using ${ctx.model.id}...`, (signal) =>
				generateWithModel(
					ctx,
					framework,
					path.relative(rootDir, planPath),
					planText,
					requirements,
					suggestedOutput,
					repoContext,
					signal,
				),
			);
			if (generation.cancelled) {
				notify(ctx, "tdd-plan cancelled", "info");
				return;
			}
			if (generation.error) {
				notify(ctx, "AI test generation failed. Try again with the active model, or switch models and retry.", "error");
				return;
			}
			const generated = generation.result;
			if (!generated) {
				notify(ctx, "AI test generation failed. Try again with the active model, or switch models and retry.", "error");
				return;
			}

			const outputPath = pickDefaultOutputPath(rootDir, planPath, repoContext, generated.outputPath || suggestedOutput);
			const coveragePath = path.join(rootDir, ".pi", "generated-tdd", `${slugify(path.basename(planPath))}.coverage.json`);
			const ambiguousPath = path.join(rootDir, ".pi", "generated-tdd", `${slugify(path.basename(planPath))}.ambiguous.md`);

			if (await exists(outputPath) && ctx.hasUI) {
				const overwrite = await ctx.ui.confirm("Overwrite generated test file?", outputPath);
				if (!overwrite) {
					notify(ctx, "tdd-plan cancelled", "info");
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
					testConfigDirectories: repoContext.testConfigDirectories,
					testConfigPatterns: repoContext.testConfigPatterns,
					testScriptDirectories: repoContext.testScriptDirectories,
					testScriptPatterns: repoContext.testScriptPatterns,
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
			} else if (await exists(ambiguousPath)) {
				await fs.rm(ambiguousPath, { force: true });
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
					if (result.code === 0) notify(ctx, "Generated tests already pass", "info");
					else notify(ctx, "Generated tests executed", "info");
				}
			}

			notify(ctx, `Generated TDD tests: ${path.relative(rootDir, outputPath)}`, "info");
			if (repoContext.testFileExamples.length > 0) {
				notify(ctx, `Matched local test conventions from ${repoContext.testFileExamples.length} example file(s)`, "info");
			}
			if (ambiguous.length > 0) {
				notify(ctx, `Ambiguous requirements flagged: ${ambiguous.length}`, "warning");
			}
		},
	});
}
