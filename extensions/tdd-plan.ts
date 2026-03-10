import { promises as fs } from "node:fs";
import path from "node:path";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

type TestFramework = "vitest" | "jest" | "unknown";
type LoopMode = "ask-each-round" | "auto-fix";
type LoopStatus = "idle" | "generating" | "assessing" | "awaiting-user" | "promoting" | "completed" | "cancelled" | "failed";
type LoopStopReason = "no-findings-remaining" | "no-blocking-findings" | "user-accepted-current-output" | "safety-cap-reached" | "cancelled" | "generation-failed" | "assessment-failed";
type AssessmentIsolationMode = "isolated-single-turn";
type FindingCategory = "superficial-source-tests" | "missing-major-plan-coverage" | "non-executable-or-unrealistic" | "insufficient-behavioral-assertions" | "ambiguity" | "other";
type FindingSeverity = "low" | "medium" | "high";

type Requirement = {
	text: string;
	heading?: string;
};

type BehavioralTarget = {
	text: string;
	heading?: string;
	source: "goal" | "acceptance" | "decision" | "scope" | "edge-case" | "other";
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

type AssessorFinding = {
	category: FindingCategory;
	severity: FindingSeverity;
	title: string;
	details: string;
	fix: string;
	requirement?: string;
	evidence?: string[];
};

type AssessmentResult = {
	verdict: "pass" | "fail";
	summary: string;
	findings: AssessorFinding[];
	strengths?: string[];
};

type LoopIterationRecord = {
	iteration: number;
	stagedOutputPath: string;
	coveragePath: string;
	findingsPath: string;
	findingsSummaryPath?: string;
	generatorMetadataPath: string;
	coveredRequirements: string[];
	ambiguousRequirements: string[];
	findingCategories: FindingCategory[];
	verdict: "pass" | "fail";
	summary: string;
	continueDecision: "continue" | "accept" | "stop";
};

type TddLoopState = {
	active: boolean;
	repoRoot: string;
	planPath: string;
	slug: string;
	loopMode: LoopMode;
	status: LoopStatus;
	iteration: number;
	maxIterations: number;
	startedAt: string;
	updatedAt: string;
	finalOutputPath?: string;
	stagedOutputPath?: string;
	stopReason?: LoopStopReason;
	lastSummary?: string;
	lastFindings?: AssessorFinding[];
	assessmentIsolationMode?: AssessmentIsolationMode;
	assessmentSessionId?: string;
	assessmentOriginId?: string;
	iterations: LoopIterationRecord[];
};

type TddPlanParsedArgs = {
	planInput: string;
	runTests: boolean;
	loopMode?: LoopMode;
};

type GenerationOptions = {
	iteration?: number;
	priorTestCode?: string;
	assessment?: AssessmentResult;
};

const SYSTEM_PROMPT = `You generate TypeScript acceptance tests from markdown implementation plans.

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
- Treat the markdown plan as a planning artifact, not as the system under test.
- NEVER write tests that assert on the plan file itself, markdown headings, wording, checklist items, section presence, phrase matching, or any other documentation content.
- The tests must validate the intended product or system behavior that the plan describes: the requested feature, acceptance criteria, clarified decisions, scope, edge cases, rollout constraints, and observable outcomes.
- Use the repository context and existing examples to match local conventions closely.
- Prefer Vitest when framework says vitest. Prefer Jest when framework says jest.
- The file must be valid TypeScript.
- The tests must be RED first: they should fail until the real feature is actually implemented.
- Do not use placeholder TODO comments as the primary failure mode; use executable expectations that fail until implementation exists, or explicit throw errors if the app wiring is impossible to infer.
- For each testable behavioral requirement, create at least one named test whose title includes the requirement text or a close paraphrase.
- Include a top comment saying the file was generated from a markdown plan.
- Reuse local test idioms, imports, setup style, and folder conventions when examples are provided.
- Favor the strongest realistic acceptance criteria you can infer from the plan goal and repository context.
- If a requirement is vague, still create the best failing behavioral acceptance test you can, and list it in ambiguousRequirements.
- When prior assessment findings are provided, treat them as a mandatory fix queue: address each finding explicitly, remove the cited bad patterns, and strengthen the exact missing behaviors called out by the reviewer.
- Rewrite freely when needed. Do not preserve broken structure just because it existed in the previous iteration.
- Use notes to briefly record how you resolved the prior findings or which ambiguity still blocks stronger tests.
- Return raw JSON only. No markdown fences.`;

const ASSESSOR_SYSTEM_PROMPT = `You are an independent reviewer of generated TypeScript tests created from a markdown implementation plan.

Return strict JSON with this shape:
{
  "verdict": "pass" | "fail",
  "summary": "short summary",
  "findings": [
    {
      "category": "superficial-source-tests" | "missing-major-plan-coverage" | "non-executable-or-unrealistic" | "insufficient-behavioral-assertions" | "ambiguity" | "other",
      "severity": "low" | "medium" | "high",
      "title": "short title",
      "details": "what is wrong and why",
      "fix": "concrete change to make in the next round",
      "requirement": "optional impacted requirement",
      "evidence": ["optional evidence line or clue"]
    }
  ],
  "strengths": ["optional strengths"]
}

Rules:
- Review the generated tests, the plan, repository context, and generator metadata together.
- Behave like a code reviewer: identify discrete, actionable findings that another round can fix.
- Only return verdict="pass" when you would be comfortable stopping the loop now.
- If verdict="fail", findings must contain at least one actionable item. Keep the list short and high-signal (ideally 1-5 findings).
- Each finding should explain impact, include concrete evidence from the generated tests when possible, and give an imperative fix instruction.
- Fail the suite when it contains superficial source scanning tests, file-content assertions, regex checks against source/markdown, missing major behavioral coverage, unrealistic/non-executable harness assumptions, or weak assertions that do not prove behavior.
- Prefer the strongest realistic behavioral tests supported by the repository evidence; do not require full E2E coverage when the repo does not support it.
- If the plan is vague, report ambiguity as a finding instead of passing the suite.
- Return raw JSON only. No markdown fences.`;

const MAX_PLAN_CHARS = 24_000;
const MAX_REQUIREMENTS_IN_PROMPT = 80;
const SECTION_SUMMARY_MAX_CHARS = 1_200;
const LOOP_MAX_ITERATIONS = 4;
const TDD_LOOP_STATE_TYPE = "tdd-plan-loop-session";
const TDD_LOOP_WIDGET_ID = "tdd-plan-loop";

let activeLoopState: TddLoopState | undefined;
let lastPersistedLoopStateJson: string | undefined;

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

function classifyBehavioralHeading(heading?: string): BehavioralTarget["source"] | null {
	if (!heading) return null;
	const normalized = heading.toLowerCase();
	if (/existing codebase context|implementation|approach|design|architecture|open questions|assumptions|test ideas?|qa|validation|recommended split/.test(normalized)) {
		return null;
	}
	if (/acceptance|success criteria|definition of done/.test(normalized)) return "acceptance";
	if (/requested feature|problem statement|user story|goal|objective/.test(normalized)) return "goal";
	if (/edge cases?|failure|errors?|risks?|constraints?|non-goals?/.test(normalized)) return "edge-case";
	if (/scope|api changes|data model changes|security|permissions|performance|rollout|migration|observability/.test(normalized)) return "scope";
	if (/clarified decisions?|behavior|expected|outcomes?|requirements?/.test(normalized)) return "decision";
	return "other";
}

function collectBehavioralTargets(markdown: string, requirements: Requirement[]): BehavioralTarget[] {
	const sections = splitMarkdownSections(markdown);
	const targets: BehavioralTarget[] = [];
	const seen = new Set<string>();

	const pushTarget = (text: string, heading: string | undefined, source: BehavioralTarget["source"]) => {
		const normalizedText = text.replace(/\s+/g, " ").trim();
		if (!normalizedText) return;
		const key = `${heading ?? ""}::${normalizedText.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		targets.push({ text: normalizedText, heading, source });
	};

	for (const section of sections) {
		const source = classifyBehavioralHeading(section.heading);
		if (!source) continue;
		const lines = section.content.split(/\r?\n/);
		let capturedStructured = false;
		for (const rawLine of lines) {
			const line = rawLine.trim();
			const bulletMatch = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/);
			const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
			const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
			if (headingMatch) continue;
			const item = bulletMatch?.[1] ?? numberedMatch?.[1];
			if (!item) continue;
			capturedStructured = true;
			pushTarget(item, section.heading, source);
		}
		if (!capturedStructured && source !== "other") {
			const paragraph = lines
				.map((line) => line.trim())
				.filter((line) => line && !/^#{1,6}\s+/.test(line))
				.join(" ")
				.trim();
			if (paragraph) pushTarget(paragraph, section.heading, source);
		}
	}

	for (const req of requirements) {
		const source = classifyBehavioralHeading(req.heading);
		if (!source) continue;
		pushTarget(req.text, req.heading, source);
	}

	if (targets.length > 0) return targets;
	return requirements.map((req) => ({
		text: req.text,
		heading: req.heading,
		source: classifyBehavioralHeading(req.heading) ?? "other",
	}));
}

function buildPromptRequirements(requirements: Requirement[], behavioralTargets: BehavioralTarget[]): PromptRequirements {
	const promptItems = behavioralTargets.length > 0
		? behavioralTargets.map((target) => ({ text: target.text, heading: target.heading, weight: getSectionPriority(target.heading) + (target.source === "acceptance" ? 3 : target.source === "goal" ? 2 : target.source === "edge-case" ? 2 : 0) }))
		: requirements.map((req) => ({ text: req.text, heading: req.heading, weight: getSectionPriority(req.heading) }));

	if (promptItems.length <= MAX_REQUIREMENTS_IN_PROMPT) {
		return {
			text: promptItems.map((req, i) => `- ${i + 1}. ${req.heading ? `[${req.heading}] ` : ""}${req.text}`).join("\n"),
			omittedCount: 0,
		};
	}

	const ranked = promptItems.map((req, index) => {
		const tailBonus = index >= Math.floor(promptItems.length * 0.75) ? 2 : index >= Math.floor(promptItems.length * 0.5) ? 1 : 0;
		return { req, index, score: req.weight * 10 + tailBonus };
	});

	const selectedIndexes = new Set(
		ranked
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, MAX_REQUIREMENTS_IN_PROMPT)
			.map((item) => item.index),
	);

	const selected = promptItems
		.map((req, index) => ({ req, index }))
		.filter((item) => selectedIndexes.has(item.index));

	return {
		text: selected.map((item) => `- ${item.index + 1}. ${item.req.heading ? `[${item.req.heading}] ` : ""}${item.req.text}`).join("\n"),
		omittedCount: promptItems.length - selected.length,
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

function buildRepoSummary(framework: TestFramework, repoContext: RepoContext): string {
	return JSON.stringify(
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
}

function formatAssessmentFinding(finding: AssessorFinding, index: number): string {
	return [
		`${index + 1}. [${finding.category}/${finding.severity}] ${finding.title}`,
		`   Why this matters: ${finding.details}`,
		`   Required fix: ${finding.fix}`,
		finding.requirement ? `   Requirement: ${finding.requirement}` : undefined,
		finding.evidence?.length ? `   Evidence: ${finding.evidence.join(" | ")}` : undefined,
	].filter(Boolean).join("\n");
}

function buildAssessmentFeedbackPrompt(assessment: AssessmentResult, priorTestCode?: string): string {
	const findings = assessment.findings.length > 0
		? assessment.findings.map((finding, index) => formatAssessmentFinding(finding, index)).join("\n\n")
		: "- No actionable findings were returned.";
	const fixQueue = assessment.findings.length > 0
		? assessment.findings.map((finding, index) => `- Fix ${index + 1}: ${finding.fix}`).join("\n")
		: "- No fix queue provided.";

	return [
		"Previous round review (treat this as a mandatory fix queue):",
		`Overall verdict: ${assessment.verdict === "pass" ? "correct" : "needs attention"}`,
		`Summary: ${assessment.summary}`,
		"",
		"Findings:",
		findings,
		"",
		"Fix queue:",
		fixQueue,
		"",
		"Revision instructions:",
		"- Address every finding directly.",
		"- Remove any cited superficial assertions, unrealistic harness assumptions, or missing coverage gaps.",
		"- Rewrite the test file freely if that is the simplest way to close the findings.",
		priorTestCode ? `\nPrevious staged test file to improve (do not preserve bad patterns blindly):\n\n${priorTestCode}` : undefined,
	].filter(Boolean).join("\n");
}

function renderAssessmentSummary(assessment: AssessmentResult): string {
	const findings = assessment.findings.length > 0
		? assessment.findings.map((finding, index) => `- ${index + 1}. ${finding.title} (${finding.category}/${finding.severity})`).join("\n")
		: "- No actionable findings.";
	const strengths = assessment.strengths?.length
		? assessment.strengths.map((item) => `- ${item}`).join("\n")
		: "- None recorded.";
	const fixQueue = assessment.findings.length > 0
		? assessment.findings.map((finding, index) => `- ${index + 1}. ${finding.fix}`).join("\n")
		: "- No fixes required.";
	return [
		`Verdict: ${assessment.verdict === "pass" ? "correct" : "needs attention"}`,
		`Summary: ${assessment.summary}`,
		"",
		"Findings:",
		findings,
		"",
		"Strengths:",
		strengths,
		"",
		"Fix queue:",
		fixQueue,
	].join("\n");
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
	options: GenerationOptions = {},
): Promise<GeneratedSpec | null> {
	if (!ctx.model) return null;
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;

	const behavioralTargets = collectBehavioralTargets(planText, requirements);
	const promptRequirements = buildPromptRequirements(requirements, behavioralTargets);
	const promptPlan = buildPromptPlan(planText);

	const exampleText = repoContext.testFileExamples.length
		? repoContext.testFileExamples
				.map((example, index) => `### Example ${index + 1}: ${example.path}\n${example.preview}`)
				.join("\n\n")
		: "(No existing test examples found)";

	const repoSummary = buildRepoSummary(framework, repoContext);

	const behavioralSummary = behavioralTargets.length > 0
		? behavioralTargets
			.map((target, index) => `- ${index + 1}. ${target.heading ? `[${target.heading}] ` : ""}${target.text}`)
			.join("\n")
		: "(none extracted; infer the intended feature behavior from the full markdown)";

	const improvementContext = options.assessment
		? `\n\n${buildAssessmentFeedbackPrompt(options.assessment, options.priorTestCode)}`
		: "";

	const userPrompt = `Framework: ${framework === "unknown" ? "Prefer Vitest but mirror local conventions" : framework}
Suggested output path: ${outputPath}
Plan path: ${planPath}
Iteration: ${options.iteration ?? 1}

Repository context:
${repoSummary}

Existing test examples:
${exampleText}

Behavioral targets inferred from the plan goal (these are the system behaviors to test, not markdown assertions):
${behavioralSummary}

Prioritized behavioral requirements for test generation:
${promptRequirements.text || "(none extracted; infer from full markdown)"}
${promptRequirements.omittedCount > 0 ? `\n(${promptRequirements.omittedCount} behavioral requirements omitted after prioritizing acceptance criteria, edge cases, and goal-defining sections)` : ""}

Important constraint:
Do not test the plan file, markdown headings, documentation wording, or phrase presence. Test only the real feature behavior the plan is trying to achieve.${improvementContext}

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

function normalizeAssessment(result: AssessmentResult | null): AssessmentResult {
	if (!result) {
		return {
			verdict: "fail",
			summary: "Assessment response was invalid JSON.",
			findings: [{
				category: "other",
				severity: "high",
				title: "Invalid assessor response",
				details: "The assessment pass did not return valid structured JSON.",
				fix: "Re-run assessment with strict JSON output and concrete findings.",
			}],
			strengths: [],
		};
	}
	const findings = Array.isArray(result.findings)
		? result.findings
			.map((finding) => ({
				category: finding.category ?? "other",
				severity: finding.severity ?? "medium",
				title: finding.title ?? "Finding",
				details: finding.details ?? "Details missing.",
				fix: finding.fix ?? "Improve the generated tests.",
				requirement: finding.requirement,
				evidence: Array.isArray(finding.evidence) ? finding.evidence.map(String) : undefined,
			}))
			.filter((finding) => finding.title && finding.details)
		: [];
	if (result.verdict === "fail" && findings.length === 0) {
		findings.push({
			category: "other",
			severity: "high",
			title: "Assessment returned fail without actionable findings",
			details: "The reviewer said the suite still needs attention but did not provide any concrete defects to fix.",
			fix: "Re-review the generated tests and return at least one discrete actionable finding with evidence and a concrete fix.",
		});
	}
	return {
		verdict: result.verdict === "pass" && findings.length === 0 ? "pass" : findings.length > 0 ? "fail" : result.verdict,
		summary: result.summary || (findings.length === 0 ? "No issues found." : "Issues found."),
		findings,
		strengths: Array.isArray(result.strengths) ? result.strengths.map(String) : [],
	};
}

function hasBlockingFindings(assessment: AssessmentResult): boolean {
	return assessment.findings.some((f) => f.severity === "high");
}

function detectSuperficialPatterns(testCode: string): AssessorFinding[] {
	const findings: AssessorFinding[] = [];
	const normalized = testCode.toLowerCase();
	const add = (title: string, details: string, fix: string, evidence: string[]) => {
		findings.push({
			category: "superficial-source-tests",
			severity: "high",
			title,
			details,
			fix,
			evidence,
		});
	};

	if (/readfile|readfilesync|fs\./i.test(testCode) && /plan/i.test(testCode)) {
		add(
			"Reads plan/documentation files inside tests",
			"The generated tests appear to inspect plan or documentation content instead of exercising product behavior.",
			"Replace plan/documentation file assertions with executable behavioral checks against the real system surface.",
			[testCode.match(/.{0,40}(?:readfile|readfilesync|fs\.).{0,80}/i)?.[0] ?? "fs usage detected"],
		);
	}
	const markdownAssertionPattern = /(?:toContain|toMatch|match)\((?:.|\n){0,120}(?:##\s|markdown|plan file|acceptance criteria|open questions)/i;
	if (markdownAssertionPattern.test(testCode)) {
		add(
			"Asserts on markdown/source text",
			"The generated tests appear to assert on markdown headings, wording, or source text patterns rather than system behavior.",
			"Assert on runtime behavior, API responses, rendered UI, commands, or observable outputs instead of text content.",
			[testCode.match(/.{0,30}(?:toContain|toMatch|match)\((?:.|\n){0,120}/i)?.[0] ?? "string/regex assertion against documentation detected"],
		);
	}
	if (/expect\s*\(\s*(?:source|filecontent|markdown)\b/i.test(normalized)) {
		add(
			"Uses source-content expectations",
			"The generated tests directly inspect source or markdown strings.",
			"Refactor the tests to execute the feature behavior through supported seams in the repository.",
			[testCode.match(/.{0,30}expect\s*\(\s*(?:source|fileContent|markdown).{0,80}/i)?.[0] ?? "source-content expectation detected"],
		);
	}
	return findings;
}

function tokenizeRequirementText(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 4)
		.map((token) => token.endsWith("s") ? token.slice(0, -1) : token);
}

function requirementCoverageMatches(requirement: string, coveredRequirement: string): boolean {
	const normalizedRequirement = requirement.toLowerCase().trim();
	const normalizedCovered = coveredRequirement.toLowerCase().trim();
	if (!normalizedRequirement || !normalizedCovered) return false;
	if (normalizedCovered.includes(normalizedRequirement) || normalizedRequirement.includes(normalizedCovered)) return true;

	const requirementTokens = uniq(tokenizeRequirementText(requirement));
	const coveredTokens = new Set(tokenizeRequirementText(coveredRequirement));
	if (requirementTokens.length === 0 || coveredTokens.size === 0) return false;

	const overlap = requirementTokens.filter((token) => coveredTokens.has(token));
	const overlapRatio = overlap.length / requirementTokens.length;
	return overlap.length >= 2 && overlapRatio >= 0.5;
}

function detectCoverageGaps(requirements: Requirement[], coveredRequirements: string[]): AssessorFinding[] {
	const important = requirements.filter((req) => {
		const heading = req.heading?.toLowerCase() ?? "";
		return /acceptance|requested feature|problem statement|scope|clarified decisions|edge cases|performance|rollout|observability|security/.test(heading);
	});
	const missing = important.filter((req) => !coveredRequirements.some((covered) => requirementCoverageMatches(req.text, covered)));
	if (missing.length === 0) return [];
	return missing.slice(0, 4).map((req) => ({
		category: "missing-major-plan-coverage",
		severity: "medium",
		title: "Missing major behavioral requirement",
		details: `No generated coverage entry clearly maps to: ${req.text}`,
		fix: "Add an explicit behavioral test for this requirement or explain why it cannot be tested realistically.",
		requirement: req.text,
		evidence: req.heading ? [`section: ${req.heading}`] : undefined,
	}));
}

async function assessGeneratedSpec(
	ctx: ExtensionContext,
	framework: TestFramework,
	planPath: string,
	planText: string,
	requirements: Requirement[],
	repoContext: RepoContext,
	generated: GeneratedSpec,
	stagedOutputPath: string,
	signal?: AbortSignal,
): Promise<AssessmentResult | null> {
	if (!ctx.model) return null;
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;

	const promptPlan = buildPromptPlan(planText);
	const repoSummary = buildRepoSummary(framework, repoContext);
	const userPrompt = `Review this generated test suite independently.

Plan path: ${planPath}
Staged output path: ${stagedOutputPath}

Repository context:
${repoSummary}

Generator metadata:
${JSON.stringify({
	framework: generated.framework,
	outputPath: generated.outputPath,
	coveredRequirements: generated.coveredRequirements,
	ambiguousRequirements: generated.ambiguousRequirements ?? [],
	notes: generated.notes ?? [],
}, null, 2)}

Full generated tests:

${generated.testCode}

Prioritized plan requirements:
${requirements.map((req, index) => `- ${index + 1}. ${req.heading ? `[${req.heading}] ` : ""}${req.text}`).join("\n") || "(none extracted)"}

Condensed plan:

${promptPlan.text}
${promptPlan.truncated ? `\n\n[plan condensed for prompt size; omitted ${promptPlan.omittedSectionCount} lower-priority section(s)]` : ""}`;

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userPrompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model as Model<Api>,
		{ systemPrompt: ASSESSOR_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey, signal },
	);

	if (response.stopReason === "aborted" || response.stopReason === "error") return null;
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const parsed = normalizeAssessment(parseJson<AssessmentResult>(text));

	const heuristicFindings = [
		...detectSuperficialPatterns(generated.testCode),
		...detectCoverageGaps(requirements, generated.coveredRequirements),
	];
	if (heuristicFindings.length === 0) return parsed;

	const merged = [...parsed.findings];
	for (const heuristic of heuristicFindings) {
		const duplicate = merged.some((finding) => finding.category === heuristic.category && finding.title === heuristic.title && finding.requirement === heuristic.requirement);
		if (!duplicate) merged.push(heuristic);
	}
	return {
		verdict: merged.length === 0 ? "pass" : "fail",
		summary: merged.length === 0 ? parsed.summary : parsed.summary || `Found ${merged.length} issue(s).`,
		findings: merged,
		strengths: parsed.strengths ?? [],
	};
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

function buildLoopArtifactsBaseDir(rootDir: string, planPath: string): string {
	return path.join(rootDir, ".pi", "generated-tdd", slugify(path.basename(planPath)));
}

function buildLoopIterationPaths(rootDir: string, planPath: string, repoContext: RepoContext, iteration: number): {
	baseDir: string;
	stagedOutputPath: string;
	coveragePath: string;
	findingsPath: string;
	findingsSummaryPath: string;
	generatorMetadataPath: string;
} {
	const baseDir = buildLoopArtifactsBaseDir(rootDir, planPath);
	const finalPath = buildDiscoveryAwareOutputPath(rootDir, planPath, repoContext);
	const ext = path.extname(finalPath);
	const baseName = path.basename(finalPath, ext);
	return {
		baseDir,
		stagedOutputPath: path.join(baseDir, `${baseName}.iteration-${iteration}${ext}`),
		coveragePath: path.join(baseDir, `iteration-${iteration}.coverage.json`),
		findingsPath: path.join(baseDir, `iteration-${iteration}.findings.json`),
		findingsSummaryPath: path.join(baseDir, `iteration-${iteration}.findings.md`),
		generatorMetadataPath: path.join(baseDir, `iteration-${iteration}.generator.json`),
	};
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

function getStateContainer(ctx: any): Record<string, any> {
	if (!ctx.state) ctx.state = {};
	return ctx.state;
}

function getCurrentLeafId(ctx: any): string | undefined {
	return ctx?.sessionManager?.getLeafId?.() ?? ctx?.sessionManager?.getLeafEntry?.()?.id ?? ctx?.currentLeafId;
}

function getSessionEntries(ctx: any): any[] {
	return ctx?.sessionManager?.getEntries?.() ?? [];
}

function getCustomEntryData(entry: any): any | undefined {
	if (!entry || entry.type !== "custom") return undefined;
	if (Object.prototype.hasOwnProperty.call(entry, "data")) return entry.data;
	if (Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
}

function appendCustomEntry(target: any, customType: string, data: unknown): any {
	const appendEntry = target?.appendEntry;
	if (typeof appendEntry !== "function") return undefined;
	if (appendEntry.length >= 2) {
		return appendEntry(customType, data);
	}
	return appendEntry({ type: "custom", customType, data });
}

function getLoopState(ctx: any): TddLoopState | undefined {
	const container = getStateContainer(ctx);
	if (Object.prototype.hasOwnProperty.call(container, "tddPlanLoop")) return container.tddPlanLoop;
	return undefined;
}

function loadPersistedLoopState(ctx: any): TddLoopState | undefined {
	const entries = getSessionEntries(ctx);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry?.customType !== TDD_LOOP_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data || data.active === false) return undefined;
		activeLoopState = data as TddLoopState;
		lastPersistedLoopStateJson = JSON.stringify(activeLoopState);
		getStateContainer(ctx).tddPlanLoop = activeLoopState;
		return activeLoopState;
	}
	return undefined;
}

async function applyLoopState(ctx: any, state: TddLoopState): Promise<TddLoopState> {
	activeLoopState = state;
	getStateContainer(ctx).tddPlanLoop = state;
	const json = JSON.stringify(state);
	if (json !== lastPersistedLoopStateJson) {
		appendCustomEntry(ctx.pi ?? ctx, TDD_LOOP_STATE_TYPE, state);
		lastPersistedLoopStateJson = json;
	}
	return state;
}

async function clearLoopState(ctx: any): Promise<void> {
	activeLoopState = undefined;
	delete getStateContainer(ctx).tddPlanLoop;
	const clearedJson = JSON.stringify({ active: false });
	if (clearedJson !== lastPersistedLoopStateJson) {
		appendCustomEntry(ctx.pi ?? ctx, TDD_LOOP_STATE_TYPE, { active: false });
		lastPersistedLoopStateJson = clearedJson;
	}
}

async function setLoopWidget(ctx: any, state?: TddLoopState): Promise<void> {
	if (!ctx?.ui) return;
	if (!state?.active) {
		if (typeof ctx.ui.clearWidget === "function") {
			ctx.ui.clearWidget(TDD_LOOP_WIDGET_ID);
			return;
		}
		if (typeof ctx.ui.setWidget === "function") {
			if (ctx.ui.setWidget.length >= 2) ctx.ui.setWidget(TDD_LOOP_WIDGET_ID, undefined);
			else ctx.ui.setWidget(undefined);
		}
		return;
	}
	const lines = [
		`TDD loop active (${state.iteration}/${state.maxIterations})`,
		`${state.loopMode} · ${state.status}`,
		state.lastSummary ? state.lastSummary.slice(0, 100) : `plan: ${state.slug}`,
	];
	if (typeof ctx.ui.setWidget === "function") {
		if (ctx.ui.setWidget.length >= 2) ctx.ui.setWidget(TDD_LOOP_WIDGET_ID, lines);
		else ctx.ui.setWidget(lines.join("\n"));
	}
}

async function restoreLoopStateOnEvent(ctx: any): Promise<TddLoopState | undefined> {
	const state = getLoopState(ctx) ?? loadPersistedLoopState(ctx);
	if (state?.active) {
		await setLoopWidget(ctx, state);
		return state;
	}
	await setLoopWidget(ctx, undefined);
	return undefined;
}

async function startAssessmentIsolationBranch(ctx: any): Promise<{ originId?: string; sessionId?: string }> {
	if (typeof ctx.navigateTree !== "function") return {};
	const originId = getCurrentLeafId(ctx);
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	const firstUserMessage = entries.find((entry: any) => entry.type === "message" && entry.message?.role === "user");
	const targetId = firstUserMessage?.id ?? originId;
	if (!targetId) return { originId };
	const result = await ctx.navigateTree(targetId, { summarize: false, label: "tdd-plan-assessment" });
	if (result?.cancelled) return { originId };
	if (typeof ctx?.ui?.setEditorText === "function") ctx.ui.setEditorText("");
	return { originId, sessionId: getCurrentLeafId(ctx) };
}

async function returnFromAssessmentIsolationBranch(ctx: any, originId?: string): Promise<void> {
	if (!originId || typeof ctx.navigateTree !== "function") return;
	await ctx.navigateTree(originId, { summarize: false });
}

function parseTddPlanArgs(rawArgs: string): TddPlanParsedArgs {
	let value = rawArgs.trim();
	const takeFlag = (flag: string) => {
		const before = value;
		value = value.replace(new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`, "g"), " ").trim();
		return before !== value;
	};
	const runTests = takeFlag("--run");
	const loopAuto = takeFlag("--loop-auto");
	const loopAsk = takeFlag("--loop-ask");
	const loop = takeFlag("--loop");
	const loopMode = loopAuto ? "auto-fix" : (loopAsk || loop ? "ask-each-round" : undefined);
	return {
		planInput: value.trim(),
		runTests,
		loopMode,
	};
}

async function chooseLoopModeAtStart(ctx: ExtensionContext, directLoopCommand: boolean): Promise<LoopMode | "single-pass" | null> {
	if (!ctx.hasUI || typeof ctx.ui.select !== "function") return directLoopCommand ? "ask-each-round" : "single-pass";
	const choice = await ctx.ui.select(
		directLoopCommand ? "Loop behavior" : "Choose TDD generation mode",
		directLoopCommand
			? ["Loop: ask after each round", "Loop: auto-fix until clean"]
			: ["Single pass", "Loop: ask after each round", "Loop: auto-fix until clean"],
	);
	if (!choice) return null;
	if (choice === "Single pass") return "single-pass";
	return choice.includes("auto-fix") ? "auto-fix" : "ask-each-round";
}

async function maybeConfirmOverwrite(ctx: ExtensionContext, outputPath: string): Promise<boolean> {
	if (!(await exists(outputPath)) || !ctx.hasUI) return true;
	const overwrite = await ctx.ui.confirm("Overwrite generated test file?", outputPath);
	return Boolean(overwrite);
}

async function runGeneratedTests(pi: ExtensionAPI, rootDir: string, outputPath: string, generatedFramework: TestFramework, detectedFramework: TestFramework): Promise<void> {
	let command: string | null = null;
	if (generatedFramework === "vitest" || detectedFramework === "vitest") {
		command = `npx vitest run ${JSON.stringify(path.relative(rootDir, outputPath))}`;
	} else if (generatedFramework === "jest" || detectedFramework === "jest") {
		command = `npx jest ${JSON.stringify(path.relative(rootDir, outputPath))}`;
	}
	if (!command) return;
	await pi.exec("bash", ["-lc", `cd ${JSON.stringify(rootDir)} && ${command}`]);
}

async function prepareGenerationContext(ctx: ExtensionContext, planInput: string): Promise<{
	planPath: string;
	planText: string;
	requirements: Requirement[];
	pkg: { path: string; data: Record<string, any> } | null;
	rootDir: string;
	framework: TestFramework;
	repoContext: RepoContext;
	suggestedOutput: string;
}> {
	const planPath = path.resolve(ctx.cwd, planInput);
	if (!(await exists(planPath))) throw new Error(`Plan file not found: ${planPath}`);

	const planText = await fs.readFile(planPath, "utf8");
	const requirements = extractRequirements(planText);
	const pkg = await loadPackageJson(ctx.cwd);
	const rootDir = pkg ? path.dirname(pkg.path) : ctx.cwd;
	const framework = detectFramework(pkg?.data ?? null);
	const repoScan = await runWithLoader(ctx, "Inspecting repository for local test conventions...", async () =>
		inspectRepo(rootDir, pkg?.data ?? null, framework),
	);
	if (repoScan.cancelled) throw new Error("cancelled");
	if (repoScan.error || !repoScan.result) throw new Error("Failed to inspect repository context for tdd-plan.");
	const repoContext = repoScan.result;
	const suggestedOutput = buildDiscoveryAwareOutputPath(rootDir, planPath, repoContext);

	return {
		planPath,
		planText,
		requirements,
		pkg,
		rootDir,
		framework,
		repoContext,
		suggestedOutput,
	};
}

async function assertModelReady(ctx: ExtensionContext): Promise<void> {
	if (!ctx.model) throw new Error("No active model selected. Select a model first, then run /tdd-plan again.");
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) throw new Error("The active model has no API key/session available. Authenticate first, then run /tdd-plan again.");
}

async function generateSinglePass(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: Awaited<ReturnType<typeof prepareGenerationContext>>,
	runTests: boolean,
): Promise<void> {
	const { planPath, planText, requirements, rootDir, framework, repoContext, suggestedOutput } = prepared;
	const generation = await runWithLoader(ctx, `Generating TDD tests using ${ctx.model?.id ?? "model"}...`, (signal) =>
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
	if (generation.error || !generation.result) {
		notify(ctx, "AI test generation failed. Try again with the active model, or switch models and retry.", "error");
		return;
	}
	const generated = generation.result;
	const outputPath = pickDefaultOutputPath(rootDir, planPath, repoContext, generated.outputPath || suggestedOutput);
	const coveragePath = path.join(rootDir, ".pi", "generated-tdd", `${slugify(path.basename(planPath))}.coverage.json`);
	const ambiguousPath = path.join(rootDir, ".pi", "generated-tdd", `${slugify(path.basename(planPath))}.ambiguous.md`);

	if (!(await maybeConfirmOverwrite(ctx, outputPath))) {
		notify(ctx, "tdd-plan cancelled", "info");
		return;
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

	if (runTests) await runGeneratedTests(pi, rootDir, outputPath, generated.framework, framework);

	notify(ctx, `Generated TDD tests: ${path.relative(rootDir, outputPath)}`, "info");
	if (repoContext.testFileExamples.length > 0) {
		notify(ctx, `Matched local test conventions from ${repoContext.testFileExamples.length} example file(s)`, "info");
	}
	if (ambiguous.length > 0) notify(ctx, `Ambiguous requirements flagged: ${ambiguous.length}`, "warning");
}

async function runTddPlanLoop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: Awaited<ReturnType<typeof prepareGenerationContext>>,
	loopMode: LoopMode,
	runTests: boolean,
): Promise<void> {
	const { planPath, planText, requirements, rootDir, framework, repoContext, suggestedOutput } = prepared;
	const slug = slugify(path.basename(planPath));
	const finalOutputPath = pickDefaultOutputPath(rootDir, planPath, repoContext, suggestedOutput);
	const coveragePath = path.join(rootDir, ".pi", "generated-tdd", `${slug}.coverage.json`);
	const ambiguousPath = path.join(rootDir, ".pi", "generated-tdd", `${slug}.ambiguous.md`);
	const loopSummaryPath = path.join(buildLoopArtifactsBaseDir(rootDir, planPath), "loop-summary.json");

	if (!(await maybeConfirmOverwrite(ctx, finalOutputPath))) {
		notify(ctx, "tdd-plan loop cancelled", "info");
		return;
	}

	let state: TddLoopState = {
		active: true,
		repoRoot: rootDir,
		planPath: path.relative(rootDir, planPath),
		slug,
		loopMode,
		status: "generating",
		iteration: 0,
		maxIterations: LOOP_MAX_ITERATIONS,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		finalOutputPath: path.relative(rootDir, finalOutputPath),
		assessmentIsolationMode: "isolated-single-turn",
		iterations: [],
	};
	await applyLoopState({ ...ctx, pi }, state);
	await setLoopWidget(ctx, state);

	let previousTestCode: string | undefined;
	let previousAssessment: AssessmentResult | undefined;
	let accepted: { generated: GeneratedSpec; stagedOutputPath: string } | undefined;

	for (let iteration = 1; iteration <= LOOP_MAX_ITERATIONS; iteration++) {
		state = await applyLoopState({ ...ctx, pi }, {
			...state,
			status: "generating",
			iteration,
			updatedAt: new Date().toISOString(),
		});
		await setLoopWidget(ctx, state);

		const iterationPaths = buildLoopIterationPaths(rootDir, planPath, repoContext, iteration);
		const generation = await runWithLoader(ctx, `Generating behavioral tests (round ${iteration}/${LOOP_MAX_ITERATIONS})...`, (signal) =>
			generateWithModel(
				ctx,
				framework,
				path.relative(rootDir, planPath),
				planText,
				requirements,
				finalOutputPath,
				repoContext,
				signal,
				{ iteration, priorTestCode: previousTestCode, assessment: previousAssessment },
			),
		);
		if (generation.cancelled) {
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				status: "cancelled",
				stopReason: "cancelled",
				lastSummary: "Loop cancelled during generation.",
				updatedAt: new Date().toISOString(),
			});
			await writeJson(loopSummaryPath, state);
			await clearLoopState({ ...ctx, pi });
			await setLoopWidget(ctx, undefined);
			notify(ctx, "tdd-plan loop cancelled", "info");
			return;
		}
		if (generation.error || !generation.result) {
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				status: "failed",
				stopReason: "generation-failed",
				lastSummary: "Generation failed.",
				updatedAt: new Date().toISOString(),
			});
			await writeJson(loopSummaryPath, state);
			await clearLoopState({ ...ctx, pi });
			await setLoopWidget(ctx, undefined);
			notify(ctx, "AI test generation failed during loop mode.", "error");
			return;
		}
		const generated = generation.result;
		await ensureDir(iterationPaths.stagedOutputPath);
		await fs.writeFile(iterationPaths.stagedOutputPath, generated.testCode.endsWith("\n") ? generated.testCode : generated.testCode + "\n", "utf8");
		await writeJson(iterationPaths.generatorMetadataPath, {
			planPath: path.relative(rootDir, planPath),
			stagedOutputPath: path.relative(rootDir, iterationPaths.stagedOutputPath),
			framework: generated.framework,
			coveredRequirements: generated.coveredRequirements,
			ambiguousRequirements: generated.ambiguousRequirements ?? [],
			notes: generated.notes ?? [],
			generatedAt: new Date().toISOString(),
		});
		await writeJson(iterationPaths.coveragePath, {
			planPath: path.relative(rootDir, planPath),
			framework: generated.framework,
			outputPath: path.relative(rootDir, iterationPaths.stagedOutputPath),
			requirements: requirements.map((r) => ({ text: r.text, heading: r.heading ?? null })),
			coveredRequirements: generated.coveredRequirements,
			ambiguousRequirements: generated.ambiguousRequirements ?? [],
			notes: generated.notes ?? [],
			generatedAt: new Date().toISOString(),
		});

		state = await applyLoopState({ ...ctx, pi }, {
			...state,
			status: "assessing",
			stagedOutputPath: path.relative(rootDir, iterationPaths.stagedOutputPath),
			updatedAt: new Date().toISOString(),
		});
		await setLoopWidget(ctx, state);

		let assessmentOriginId: string | undefined;
		let assessmentSessionId: string | undefined;
		if (typeof ctx.navigateTree === "function") {
			try {
				const isolation = await startAssessmentIsolationBranch(ctx);
				assessmentOriginId = isolation.originId;
				assessmentSessionId = isolation.sessionId;
			} catch {
				assessmentOriginId = undefined;
				assessmentSessionId = undefined;
			}
		}
		state = await applyLoopState({ ...ctx, pi }, {
			...state,
			assessmentOriginId,
			assessmentSessionId,
			updatedAt: new Date().toISOString(),
		});
		const assessmentRun = await runWithLoader(ctx, `Assessing generated tests independently (round ${iteration}/${LOOP_MAX_ITERATIONS})...`, (signal) =>
			assessGeneratedSpec(
				ctx,
				framework,
				path.relative(rootDir, planPath),
				planText,
				requirements,
				repoContext,
				generated,
				path.relative(rootDir, iterationPaths.stagedOutputPath),
				signal,
			),
		);
		if (assessmentOriginId) {
			await returnFromAssessmentIsolationBranch(ctx, assessmentOriginId);
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				assessmentOriginId: undefined,
				assessmentSessionId: undefined,
				updatedAt: new Date().toISOString(),
			});
		}
		if (assessmentRun.cancelled) {
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				status: "cancelled",
				stopReason: "cancelled",
				lastSummary: "Loop cancelled during assessment.",
				updatedAt: new Date().toISOString(),
			});
			await writeJson(loopSummaryPath, state);
			await clearLoopState({ ...ctx, pi });
			await setLoopWidget(ctx, undefined);
			notify(ctx, "tdd-plan loop cancelled", "info");
			return;
		}
		const assessment = assessmentRun.result ? normalizeAssessment(assessmentRun.result) : normalizeAssessment(null);
		if (assessmentRun.error) {
			assessment.findings.push({
				category: "other",
				severity: "high",
				title: "Assessment execution failed",
				details: "The assessment step threw an error.",
				fix: "Re-run the assessment step with the same inputs and return strict JSON.",
			});
			assessment.verdict = "fail";
		}
		await writeJson(iterationPaths.findingsPath, assessment);
		await ensureDir(iterationPaths.findingsSummaryPath);
		await fs.writeFile(iterationPaths.findingsSummaryPath, renderAssessmentSummary(assessment) + "\n", "utf8");

		const iterationRecord: LoopIterationRecord = {
			iteration,
			stagedOutputPath: path.relative(rootDir, iterationPaths.stagedOutputPath),
			coveragePath: path.relative(rootDir, iterationPaths.coveragePath),
			findingsPath: path.relative(rootDir, iterationPaths.findingsPath),
			findingsSummaryPath: path.relative(rootDir, iterationPaths.findingsSummaryPath),
			generatorMetadataPath: path.relative(rootDir, iterationPaths.generatorMetadataPath),
			coveredRequirements: generated.coveredRequirements,
			ambiguousRequirements: generated.ambiguousRequirements ?? [],
			findingCategories: uniq(assessment.findings.map((finding) => finding.category)),
			verdict: assessment.verdict,
			summary: assessment.summary,
			continueDecision: "continue",
		};
		state = await applyLoopState({ ...ctx, pi }, {
			...state,
			status: assessment.verdict === "pass" ? "promoting" : loopMode === "ask-each-round" ? "awaiting-user" : "assessing",
			lastSummary: assessment.summary,
			lastFindings: assessment.findings,
			iterations: [...state.iterations, iterationRecord],
			updatedAt: new Date().toISOString(),
		});
		await setLoopWidget(ctx, state);

		previousTestCode = generated.testCode;
		previousAssessment = assessment;

		if (assessment.findings.length === 0) {
			accepted = { generated, stagedOutputPath: iterationPaths.stagedOutputPath };
			state.iterations[state.iterations.length - 1].continueDecision = "accept";
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				status: "promoting",
				stopReason: "no-findings-remaining",
				lastSummary: assessment.summary || "No remaining findings.",
				updatedAt: new Date().toISOString(),
			});
			break;
		}

		if (!hasBlockingFindings(assessment)) {
			notify(ctx, `TDD loop: no blocking findings remain after round ${iteration}, accepting staged tests.`, "info");
			accepted = { generated, stagedOutputPath: iterationPaths.stagedOutputPath };
			state.iterations[state.iterations.length - 1].continueDecision = "accept";
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				status: "promoting",
				stopReason: "no-blocking-findings",
				lastSummary: assessment.summary || "No blocking findings remaining.",
				updatedAt: new Date().toISOString(),
			});
			break;
		}

		notify(ctx, `TDD loop round ${iteration}: ${assessment.findings.length} finding(s)`, "warning");
		if (assessment.findings.length > 0) {
			const topFindings = assessment.findings
				.slice(0, 3)
				.map((finding, index) => `${index + 1}. ${finding.title} — ${finding.fix}`)
				.join("\n");
			notify(ctx, topFindings, "warning");
		}
		if (loopMode === "ask-each-round" && ctx.hasUI && typeof ctx.ui.select === "function") {
			const choice = await ctx.ui.select("Current generated tests still have findings:", ["Continue fixing", "Accept current staged tests", "Cancel loop"]);
			if (!choice || choice === "Cancel loop") {
				state.iterations[state.iterations.length - 1].continueDecision = "stop";
				state = await applyLoopState({ ...ctx, pi }, {
					...state,
					status: "cancelled",
					stopReason: "cancelled",
					updatedAt: new Date().toISOString(),
				});
				await writeJson(loopSummaryPath, state);
				await clearLoopState({ ...ctx, pi });
				await setLoopWidget(ctx, undefined);
				notify(ctx, "tdd-plan loop cancelled", "info");
				return;
			}
			if (choice === "Accept current staged tests") {
				accepted = { generated, stagedOutputPath: iterationPaths.stagedOutputPath };
				state.iterations[state.iterations.length - 1].continueDecision = "accept";
				state = await applyLoopState({ ...ctx, pi }, {
					...state,
					status: "promoting",
					stopReason: "user-accepted-current-output",
					updatedAt: new Date().toISOString(),
				});
				break;
			}
		}

		if (iteration === LOOP_MAX_ITERATIONS) {
			accepted = { generated, stagedOutputPath: iterationPaths.stagedOutputPath };
			state.iterations[state.iterations.length - 1].continueDecision = "stop";
			state = await applyLoopState({ ...ctx, pi }, {
				...state,
				status: "promoting",
				stopReason: "safety-cap-reached",
				updatedAt: new Date().toISOString(),
			});
			break;
		}
	}

	if (!accepted) {
		state = await applyLoopState({ ...ctx, pi }, {
			...state,
			status: "failed",
			stopReason: state.stopReason ?? "assessment-failed",
			updatedAt: new Date().toISOString(),
		});
		await writeJson(loopSummaryPath, state);
		await clearLoopState({ ...ctx, pi });
		await setLoopWidget(ctx, undefined);
		notify(ctx, "tdd-plan loop failed to produce an accepted staged result.", "error");
		return;
	}

	await ensureDir(finalOutputPath);
	const finalCode = accepted.generated.testCode.endsWith("\n") ? accepted.generated.testCode : accepted.generated.testCode + "\n";
	await fs.writeFile(finalOutputPath, finalCode, "utf8");
	await writeJson(coveragePath, {
		planPath: path.relative(rootDir, planPath),
		framework: accepted.generated.framework,
		outputPath: path.relative(rootDir, finalOutputPath),
		requirements: requirements.map((r) => ({ text: r.text, heading: r.heading ?? null })),
		coveredRequirements: accepted.generated.coveredRequirements,
		ambiguousRequirements: accepted.generated.ambiguousRequirements ?? [],
		notes: accepted.generated.notes ?? [],
		loopMode,
		iterations: state.iterations,
		finalStopReason: state.stopReason,
		promotedFrom: path.relative(rootDir, accepted.stagedOutputPath),
		generatedAt: new Date().toISOString(),
	});

	const ambiguous = accepted.generated.ambiguousRequirements ?? [];
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

	if (runTests) await runGeneratedTests(pi, rootDir, finalOutputPath, accepted.generated.framework, framework);

	state = await applyLoopState({ ...ctx, pi }, {
		...state,
		active: false,
		status: "completed",
		finalOutputPath: path.relative(rootDir, finalOutputPath),
		updatedAt: new Date().toISOString(),
	});
	await writeJson(loopSummaryPath, state);
	await clearLoopState({ ...ctx, pi });
	await setLoopWidget(ctx, undefined);

	notify(ctx, `Generated TDD tests: ${path.relative(rootDir, finalOutputPath)}`, "info");
	notify(ctx, `Loop stop reason: ${state.stopReason ?? "completed"}`, state.stopReason === "no-findings-remaining" || state.stopReason === "no-blocking-findings" ? "info" : "warning");
	if (state.lastFindings?.length) notify(ctx, `Final round findings preserved: ${state.lastFindings.length}`, "warning");
}

export const __testables = {
	systemPrompt: SYSTEM_PROMPT,
	assessorSystemPrompt: ASSESSOR_SYSTEM_PROMPT,
	formatAssessmentFinding,
	buildAssessmentFeedbackPrompt,
	renderAssessmentSummary,
	normalizeAssessment,
	hasBlockingFindings,
	detectFramework,
	getConfigTestEntries,
	inferTestDirectoriesFromText,
	inferTestPatternsFromText,
	inferScriptTestDirectories,
	inferScriptTestPatterns,
	classifyBehavioralHeading,
	collectBehavioralTargets,
	isGenericSuggestedOutput,
	normalizeSuggestedOutputPath,
	choosePreferredTestPattern,
	choosePreferredTestDirectory,
	buildDiscoveryAwareOutputPath,
	pickDefaultOutputPath,
	parseTddPlanArgs,
	detectSuperficialPatterns,
	tokenizeRequirementText,
	requirementCoverageMatches,
	detectCoverageGaps,
	buildLoopIterationPaths,
	getLoopState,
	loadPersistedLoopState,
	applyLoopState,
	clearLoopState,
	setLoopWidget,
	restoreLoopStateOnEvent,
	startAssessmentIsolationBranch,
	returnFromAssessmentIsolationBranch,
	LOOP_MAX_ITERATIONS,
};

export default function tddPlanExtension(pi: ExtensionAPI) {
	pi.on?.("session_start", async (_event, ctx) => {
		await restoreLoopStateOnEvent(ctx);
	});
	pi.on?.("session_switch", async (_event, ctx) => {
		await restoreLoopStateOnEvent(ctx);
	});
	pi.on?.("session_tree", async (_event, ctx) => {
		await restoreLoopStateOnEvent(ctx);
	});

	const runCommand = async (args: string | undefined, ctx: ExtensionContext, directLoopCommand: boolean) => {
		let rawArgs = (args ?? "").trim();
		if (!rawArgs && ctx.hasUI) {
			const input = await ctx.ui.input("Markdown plan path", "specs/feature.md");
			if (!input?.trim()) {
				notify(ctx, directLoopCommand ? "tdd-plan-loop cancelled" : "tdd-plan cancelled", "info");
				return;
			}
			rawArgs = input.trim();
		}

		const parsedArgs = parseTddPlanArgs(rawArgs);
		if (!parsedArgs.planInput) {
			notify(ctx, `Usage: /${directLoopCommand ? "tdd-plan-loop" : "tdd-plan"} <plan.md> [--run]`, "warning");
			return;
		}

		let loopMode = parsedArgs.loopMode;
		if (directLoopCommand && !loopMode) {
			const selected = await chooseLoopModeAtStart(ctx, true);
			if (!selected) {
				notify(ctx, "tdd-plan-loop cancelled", "info");
				return;
			}
			loopMode = selected === "single-pass" ? "ask-each-round" : selected;
		}
		if (!directLoopCommand && !loopMode) {
			const selected = await chooseLoopModeAtStart(ctx, false);
			if (!selected) {
				notify(ctx, "tdd-plan cancelled", "info");
				return;
			}
			if (selected !== "single-pass") loopMode = selected;
		}

		let prepared: Awaited<ReturnType<typeof prepareGenerationContext>>;
		try {
			prepared = await prepareGenerationContext(ctx, parsedArgs.planInput);
		} catch (error) {
			if ((error as Error).message === "cancelled") {
				notify(ctx, directLoopCommand ? "tdd-plan-loop cancelled" : "tdd-plan cancelled", "info");
				return;
			}
			notify(ctx, (error as Error).message, /not found/i.test((error as Error).message) ? "error" : "warning");
			return;
		}

		if (prepared.requirements.length === 0) {
			notify(ctx, "No bullet/numbered requirements found. Refine the plan so tests can map to concrete criteria.", "warning");
		}

		try {
			await assertModelReady(ctx);
		} catch (error) {
			notify(ctx, (error as Error).message, "error");
			return;
		}

		if (prepared.planText.length > MAX_PLAN_CHARS) {
			notify(
				ctx,
				`Plan is large (${prepared.planText.length.toLocaleString()} chars). Sending a section-aware condensed version to the model to avoid stalls.`,
				"warning",
			);
		}

		if (loopMode) {
			await runTddPlanLoop(pi, ctx, prepared, loopMode, parsedArgs.runTests);
			return;
		}

		await generateSinglePass(pi, ctx, prepared, parsedArgs.runTests);
	};

	pi.registerCommand("tdd-plan", {
		description: "Generate TypeScript TDD tests from a markdown plan file",
		handler: async (args, ctx) => {
			await runCommand(args, ctx, false);
		},
	});

	pi.registerCommand("tdd-plan-loop", {
		description: "Generate TypeScript TDD tests from a markdown plan file using an iterative review loop",
		handler: async (args, ctx) => {
			await runCommand(args, ctx, true);
		},
	});

	pi.registerCommand("tdd-plan-status", {
		description: "Show current tdd-plan loop status",
		handler: async (_args, ctx) => {
			const state = getLoopState(ctx) ?? loadPersistedLoopState(ctx);
			if (!state?.active) {
				notify(ctx, "No active tdd-plan loop.", "warning");
				return;
			}
			const body = [
				`# TDD plan loop status`,
				"",
				`- plan path: ${state.planPath}`,
				`- loop mode: ${state.loopMode}`,
				`- status: ${state.status}`,
				`- iteration: ${state.iteration}/${state.maxIterations}`,
				`- final output path: ${state.finalOutputPath ?? "(pending)"}`,
				`- staged output path: ${state.stagedOutputPath ?? "(none yet)"}`,
				`- assessment isolation: ${state.assessmentIsolationMode ?? "none"}`,
				`- assessment session id: ${state.assessmentSessionId ?? "(none)"}`,
				`- stop reason: ${state.stopReason ?? "(not stopped)"}`,
				`- last summary: ${state.lastSummary ?? "(none)"}`,
				`- iterations recorded: ${state.iterations.length}`,
			].join("\n");
			if (typeof pi.sendMessage === "function") {
				pi.sendMessage({ customType: "tdd-plan-status", content: body, display: true }, { triggerTurn: false });
			}
			notify(ctx, "TDD plan loop status shown.", "info");
		},
	});
}
