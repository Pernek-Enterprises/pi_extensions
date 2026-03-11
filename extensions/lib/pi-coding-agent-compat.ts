class FallbackBorderedLoader {
	signal: AbortSignal;
	onAbort?: () => void;
	private readonly controller: AbortController;
	private readonly message: string;

	constructor(_tui: unknown, _theme: unknown, message: string) {
		this.controller = new AbortController();
		this.signal = this.controller.signal;
		this.message = message;
	}

	render(): string[] {
		return [this.message];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const normalized = (data ?? "").toLowerCase();
		if (normalized === "\u001b" || normalized === "escape" || normalized === "ctrl+c") {
			this.controller.abort();
			this.onAbort?.();
		}
	}
}

const runtime = await import("@mariozechner/pi-coding-agent").catch(() => null);

export const BorderedLoader = (runtime?.BorderedLoader ?? FallbackBorderedLoader) as typeof FallbackBorderedLoader;
