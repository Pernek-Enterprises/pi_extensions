export type ImplementPlanLoopStatus =
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

export type ImplementPlanLoopNextState =
	| "repairing"
	| "gathering-evidence"
	| "awaiting-external-validation"
	| "completed"
	| "failed";

export type ImplementPlanLoopIteration = {
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
	triageDecision?: ImplementPlanLoopNextState;
};

export type ImplementPlanLoopState = {
	active: boolean;
	repoRoot: string;
	contractPath: string;
	slug: string;
	status: ImplementPlanLoopStatus;
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
	lastTriageDecision?: ImplementPlanLoopNextState;
	lastTransitionReason?: string;
	changedFiles: string[];
	iterations: ImplementPlanLoopIteration[];
};

const IMPLEMENT_LOOP_STATE_TYPE = "implement-plan-loop-session";

function appendCustomEntry(target: any, customType: string, data: unknown) {
	const appendEntry = target?.appendEntry;
	if (typeof appendEntry !== "function") return;
	if (appendEntry.length >= 2) return appendEntry(customType, data);
	return appendEntry({ type: "custom", customType, data });
}

function getCustomEntryData(entry: any): any | undefined {
	if (!entry) return undefined;
	if (entry.type === "custom" && Object.prototype.hasOwnProperty.call(entry, "data")) return entry.data;
	if (entry.type === IMPLEMENT_LOOP_STATE_TYPE && Object.prototype.hasOwnProperty.call(entry, "value")) return entry.value;
	return undefined;
}

export function getImplementLoopState(ctx: any): ImplementPlanLoopState | undefined {
	return ctx?.state?.implementPlanLoop;
}

function setImplementLoopState(ctx: any, state: ImplementPlanLoopState | undefined): void {
	if (!ctx.state) ctx.state = {};
	ctx.state.implementPlanLoop = state;
}

export function loadPersistedImplementLoopState(ctx: any): ImplementPlanLoopState | undefined {
	const entries = ctx?.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!(entry?.type === "custom" && entry?.customType === IMPLEMENT_LOOP_STATE_TYPE) && entry?.type !== IMPLEMENT_LOOP_STATE_TYPE) continue;
		const data = getCustomEntryData(entry);
		if (!data) return undefined;
		if (data.active === false && !data.status) return undefined;
		setImplementLoopState(ctx, data as ImplementPlanLoopState);
		return data as ImplementPlanLoopState;
	}
	return undefined;
}

export async function applyImplementLoopState(ctx: any, state: ImplementPlanLoopState): Promise<ImplementPlanLoopState> {
	setImplementLoopState(ctx, state);
	appendCustomEntry(ctx.pi ?? ctx, IMPLEMENT_LOOP_STATE_TYPE, state);
	return state;
}

export async function clearImplementLoopState(ctx: any): Promise<void> {
	setImplementLoopState(ctx, undefined);
	appendCustomEntry(ctx.pi ?? ctx, IMPLEMENT_LOOP_STATE_TYPE, { active: false });
}
