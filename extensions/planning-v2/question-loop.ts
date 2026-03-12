export type PlanningV2Question = {
	id: string;
	question: string;
	answer?: string;
	status: "open" | "answered" | "skipped";
};

export function extractOpenQuestionsFromRawPlan(markdown: string): PlanningV2Question[] {
	const lines = markdown.split(/\r?\n/);
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+Open questions\s*$/i.test(lines[i].trim())) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return [];
	const results: PlanningV2Question[] = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		if (/^##\s+/.test(line)) break;
		const bullet = line.match(/^[-*+]\s+(.+)$/)?.[1] ?? line.match(/^\d+[.)]\s+(.+)$/)?.[1];
		if (!bullet) continue;
		if (/^\(none\)$/i.test(bullet.trim())) return [];
		results.push({ id: `q-${results.length + 1}`, question: bullet.trim(), status: "open" });
	}
	return results;
}

export function mergeQuestions(previous: PlanningV2Question[], next: PlanningV2Question[]): PlanningV2Question[] {
	const byQuestion = new Map(previous.map((item) => [item.question.trim().toLowerCase(), item]));
	return next.map((item, index) => {
		const existing = byQuestion.get(item.question.trim().toLowerCase());
		return {
			id: existing?.id ?? item.id ?? `q-${index + 1}`,
			question: item.question,
			answer: existing?.answer,
			status: existing?.answer?.trim() ? "answered" : existing?.status === "skipped" ? "skipped" : "open",
		};
	});
}

export function formatQuestionsForFollowup(questions: PlanningV2Question[]): string {
	return questions.filter((q) => q.status === "open").map((q, i) => `${i + 1}. ${q.question}`).join("\n");
}

export function formatAnsweredQuestions(questions: PlanningV2Question[]): string {
	return questions
		.filter((q) => q.answer?.trim())
		.map((q) => `Q: ${q.question}\nA: ${q.answer?.trim()}`)
		.join("\n\n");
}
