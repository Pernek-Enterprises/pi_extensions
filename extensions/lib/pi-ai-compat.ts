export type Api = unknown;
export type Model<TApi = Api> = { id?: string } & Record<string, unknown> & { __api?: TApi };
export type UserMessage = {
	role: string;
	content: Array<{ type: string; text: string }>;
	timestamp?: number;
};

type CompleteResponse = {
	content: Array<{ type: string; text: string }>;
	stopReason?: string;
};

type CompleteFn = (
	model: unknown,
	input: { systemPrompt?: string; messages: UserMessage[] },
	options?: { apiKey?: string; signal?: AbortSignal },
) => Promise<CompleteResponse>;

let runtimeCompletePromise: Promise<CompleteFn | null> | undefined;

async function loadComplete(): Promise<CompleteFn | null> {
	if (!runtimeCompletePromise) {
		runtimeCompletePromise = import("@mariozechner/pi-ai")
			.then((module) => module.complete as CompleteFn)
			.catch(() => null);
	}
	return await runtimeCompletePromise;
}

export async function complete(
	model: unknown,
	input: { systemPrompt?: string; messages: UserMessage[] },
	options?: { apiKey?: string; signal?: AbortSignal },
): Promise<CompleteResponse> {
	const runtimeComplete = await loadComplete();
	if (!runtimeComplete) {
		throw new Error("@mariozechner/pi-ai is required to run model-backed planning commands in this environment.");
	}
	return await runtimeComplete(model, input, options);
}
