export type ImplementPlanLoopV2Status =
	| "preflight"
	| "implementing"
	| "reviewing"
	| "triaging-findings"
	| "gathering-evidence"
	| "repairing"
	| "awaiting-external-validation"
	| "completed"
	| "failed"
	| "cancelled";

export type ImplementPlanLoopV2NextState =
	| "repairing"
	| "gathering-evidence"
	| "awaiting-external-validation"
	| "completed"
	| "failed";

export type ImplementPlanLoopV2Iteration = {
	iteration: number;
	mode: "implementing" | "repairing" | "gathering-evidence";
	implementationSummaryPath?: string;
	reviewJsonPath: string;
	reviewMarkdownPath: string;
	triageJsonPath?: string;
	evidenceBundlePath?: string;
	externalValidationPath?: string;
	fixHandoffPath?: string;
	changedFilesPath: string;
	diffPath: string;
	blockingCount: number;
	advisoryCount: number;
	implementationBlockingCount: number;
	evidenceBlockingCount: number;
	externalValidationBlockingCount: number;
	summary: string;
	targetIds: string[];
	targetFiles: string[];
	changedFiles: string[];
	blockerSignatures: string[];
	triageDecision?: ImplementPlanLoopV2NextState;
};

export type ImplementPlanLoopV2State = {
	active: boolean;
	repoRoot: string;
	contractPath: string;
	slug: string;
	status: ImplementPlanLoopV2Status;
	iteration: number;
	maxIterations: number;
	startedAt: string;
	updatedAt: string;
	stopReason?: string;
	lastReviewSummary?: string;
	lastImplementationSummary?: string;
	lastEvidenceSummary?: string;
	lastBlockingCount?: number;
	lastAdvisoryCount?: number;
	lastTriageDecision?: ImplementPlanLoopV2NextState;
	lastTransitionReason?: string;
	changedFiles: string[];
	iterations: ImplementPlanLoopV2Iteration[];
};

const IMPLEMENT_LOOP_V2_STATE_TYPE = "implement-plan-loop-v2-session";

function appendCustomEntry(target: any, customType: string, data: unknown) {
	const appendEntry = target?.appendEntry;
	if (typeof appendEntry !== "function") return;
	if (appendEntry.length >= 2) return appendEntry(customType, data);
	return appendEntry({ type: "custom", customType, data });
}

function getCustomEntryData(entry: any): any | undefined {
	if (!entry) return undefined;
	if (entry.type === "custom" && Object.prototype.hasOwnProperty.call(entry, "data")) return entry.data;
	if (entry.type === IMPLEMENT_LOOP_V2_STATE_TYPE && Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
}

export function getImplementLoopV2State(ctx: any): ImplementPlanLoopV2State | undefined {
	return ctx?.state?.implementPlanLoopV2;
}

function setImplementLoopV2State(ctx: any, state: ImplementPlanLoopV2State | undefined): void {
	if (!ctx.state) ctx.state = {};
	ctx.state.implementPlanLoopV2 = state;
}

export function loadPersistedImplementLoopV2State(ctx: any): ImplementPlanLoopV2State | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!(entry?.type === "custom" && entry?.customType === IMPLEMENT_LOOP_V2_STATE_TYPE) && entry?.type !== IMPLEMENT_LOOP_V2_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data) return undefined;
		if (data.active === false && !data.status) return undefined;
		setImplementLoopV2State(ctx, data as ImplementPlanLoopV2State);
		return data as ImplementPlanLoopV2State;
	}
	return undefined;
}

export async function applyImplementLoopV2State(ctx: any, state: ImplementPlanLoopV2State): Promise<ImplementPlanLoopV2State> {
	setImplementLoopV2State(ctx, state);
	appendCustomEntry(ctx.pi ?? ctx, IMPLEMENT_LOOP_V2_STATE_TYPE, state);
	return state;
}

export async function clearImplementLoopV2State(ctx: any): Promise<void> {
	setImplementLoopV2State(ctx, undefined);
	appendCustomEntry(ctx.pi ?? ctx, IMPLEMENT_LOOP_V2_STATE_TYPE, { active: false });
}
