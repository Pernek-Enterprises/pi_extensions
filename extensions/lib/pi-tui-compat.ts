type RuntimeModule = {
	Editor?: typeof Editor;
	Key?: typeof Key;
	matchesKey?: typeof matchesKey;
	Text?: typeof Text;
	truncateToWidth?: typeof truncateToWidth;
	visibleWidth?: typeof visibleWidth;
	wrapTextWithAnsi?: typeof wrapTextWithAnsi;
};

export type TUI = {
	requestRender: (force?: boolean) => void;
};

export type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	getCursorPosition?(): { x: number; y: number };
	invalidate?(): void;
};

export type EditorTheme = {
	borderColor?: (value: string) => string;
	selectList?: {
		selectedBg?: (value: string) => string;
		matchHighlight?: (value: string) => string;
		itemSecondary?: (value: string) => string;
	};
};

const ansiPattern = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
	return value.replace(ansiPattern, "");
}

function fallbackVisibleWidth(value: string): number {
	return stripAnsi(value).length;
}

function fallbackTruncateToWidth(value: string, width: number): string {
	if (width <= 0) return "";
	const plain = stripAnsi(value);
	return plain.length <= width ? value : plain.slice(0, width);
}

function fallbackWrapTextWithAnsi(value: string, width: number): string[] {
	const plain = stripAnsi(value);
	if (!plain) return [""];
	if (width <= 1) return [plain];
	const words = plain.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [plain];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (next.length > width && current) {
			lines.push(current);
			current = word;
		} else if (word.length > width) {
			if (current) lines.push(current);
			for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
			current = "";
		} else {
			current = next;
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [plain];
}

class FallbackText {
	private readonly value: string;

	constructor(value: string) {
		this.value = value;
	}

	render(): string[] {
		return [this.value];
	}
}

class FallbackEditor {
	disableSubmit = false;
	onChange?: () => void;
	private text = "";

	constructor(_tui: TUI, _theme?: EditorTheme) {}

	setText(value: string) {
		this.text = value;
	}

	getText(): string {
		return this.text;
	}

	handleInput(data: string) {
		if (data === "\u007f") this.text = this.text.slice(0, -1);
		else if (data === "\r" || data === "\n") this.text += "\n";
		else if (data.length === 1) this.text += data;
		this.onChange?.();
	}

	render(width: number): string[] {
		const text = this.text || "";
		const wrapped = fallbackWrapTextWithAnsi(text, Math.max(1, width));
		return wrapped.length > 0 ? wrapped : [""];
	}

	getCursorPosition() {
		const lines = this.text.split("\n");
		const lastLine = lines[lines.length - 1] ?? "";
		return { x: lastLine.length, y: lines.length - 1 };
	}
}

const fallbackKey = {
	enter: "enter",
	escape: "escape",
	tab: "tab",
	up: "up",
	down: "down",
	ctrl(key: string) {
		return `ctrl+${key}`;
	},
	shift(key: string) {
		return `shift+${key}`;
	},
};

function normalizeKey(value: string): string {
	if (value === "\r" || value === "\n") return "enter";
	if (value === "\u001b") return "escape";
	if (value === "\t") return "tab";
	return value.toLowerCase();
}

function fallbackMatchesKey(data: string, key: string): boolean {
	return normalizeKey(data) === normalizeKey(key);
}

const runtime: RuntimeModule = await import("@mariozechner/pi-tui").catch(() => ({}));

export const visibleWidth = runtime.visibleWidth ?? fallbackVisibleWidth;
export const truncateToWidth = runtime.truncateToWidth ?? fallbackTruncateToWidth;
export const wrapTextWithAnsi = runtime.wrapTextWithAnsi ?? fallbackWrapTextWithAnsi;
export const matchesKey = runtime.matchesKey ?? fallbackMatchesKey;
export const Key = runtime.Key ?? fallbackKey;
export const Text = (runtime.Text ?? FallbackText) as typeof FallbackText;
export const Editor = (runtime.Editor ?? FallbackEditor) as typeof FallbackEditor;
