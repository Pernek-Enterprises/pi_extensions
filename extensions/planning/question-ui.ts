import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../lib/pi-tui-compat.ts";
import type { PlanningQuestion } from "./question-loop.ts";

export class PlanningQnAComponent implements Component {
	private questions: PlanningQuestion[];
	private answers: string[];
	private currentIndex = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (value: string | null) => void;
	private confirming = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: PlanningQuestion[], tui: TUI, onDone: (value: string | null) => void) {
		this.questions = questions;
		this.answers = questions.map((q) => q.answer ?? "");
		this.tui = tui;
		this.onDone = onDone;
		const theme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};
		this.editor = new Editor(tui, theme);
		this.editor.disableSubmit = true;
		this.editor.setText(this.answers[0] || "");
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer() {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private goTo(index: number) {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private buildResult(): string {
		this.saveCurrentAnswer();
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			parts.push(`Q: ${this.questions[i].question}`);
			parts.push(`A: ${(this.answers[i] || "(no answer)").trim() || "(no answer)"}`);
			parts.push("");
		}
		return parts.join("\n").trim();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.confirming) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.onDone(this.buildResult());
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.confirming = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.goTo(Math.min(this.currentIndex + 1, this.questions.length - 1));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.goTo(Math.max(this.currentIndex - 1, 0));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) && this.editor.getText().includes("\n")) {
			this.editor.handleInput(data);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.goTo(this.currentIndex + 1);
				this.tui.requestRender();
			} else {
				this.confirming = true;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const q = this.questions[this.currentIndex];
		const lines: string[] = [];
		lines.push(this.bold(`Answer planning questions ${this.currentIndex + 1}/${this.questions.length}`));
		lines.push("");
		const questionLines = wrapTextWithAnsi(this.yellow(q.question), Math.max(20, width - 4));
		lines.push(...questionLines);
		lines.push("");
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (i === this.currentIndex ? this.editor.getText() : this.answers[i] || "").trim().length > 0;
			const prefix = i === this.currentIndex ? this.cyan("›") : " ";
			const label = `${prefix} ${i + 1}. ${truncateToWidth(this.questions[i].question, Math.max(10, width - 12))}`;
			lines.push(answered ? this.green(label) : label);
		}
		lines.push("");
		lines.push(this.gray("Answer:"));
		const editorLines = this.editor.render(Math.max(20, width - 2));
		for (const line of editorLines) lines.push(line);
		lines.push("");
		if (this.confirming) {
			lines.push(this.bold("Submit answers?"));
			lines.push(this.gray("Enter/Y = submit · Esc/N = continue editing"));
		} else {
			lines.push(this.gray("Enter = next/confirm · Tab/Shift+Tab = navigate · Esc = cancel"));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	getCursorPosition() {
		return this.editor.getCursorPosition();
	}
}
