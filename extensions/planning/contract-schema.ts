export type ExecutionContractStatus = "draft" | "blocked" | "ready";

export type ExecutionContractRequirement = {
	id: string;
	text: string;
	kind: "behavioral" | "operational";
	priority: "primary" | "secondary";
	source?: string;
};

export type ExecutionContractCheck = {
	id: string;
	text: string;
	kind: "test" | "verification";
	source?: string;
};

export type ExecutionContractAmbiguity = {
	id: string;
	text: string;
	blocksExecution: boolean;
	source?: string;
};

export type ExecutionContract = {
	artifactType: "execution-contract";
	version: 1;
	generatedAt: string;
	source: {
		rawArtifactPath: string;
		rawArtifactKind: "markdown" | "json" | "hybrid";
	};
	goal: string;
	requirements: ExecutionContractRequirement[];
	checks: ExecutionContractCheck[];
	ambiguities: ExecutionContractAmbiguity[];
	evidence: Array<{ path: string; reason?: string }>;
	outOfScope: string[];
	status: ExecutionContractStatus;
	contractIssues: string[];
	advisoryNotes: string[];
};
