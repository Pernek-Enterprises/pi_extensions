import path from "node:path";

export function slugFromContractPath(contractPath: string): string {
	const base = path.basename(contractPath).replace(/\.plan\.contract\.json$/i, "");
	return base.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "contract";
}

export function buildImplementationLoopArtifactPaths(repoRoot: string, contractRelativePath: string, iteration: number): {
	directory: string;
	implementationSummaryPath: string;
	reviewJsonPath: string;
	reviewMarkdownPath: string;
	triageJsonPath: string;
	evidenceBundlePath: string;
	externalValidationPath: string;
	fixHandoffPath: string;
	changedFilesPath: string;
	diffPath: string;
	finalSummaryPath: string;
} {
	const slug = slugFromContractPath(contractRelativePath);
	const directory = path.join(repoRoot, ".pi", "generated-implementation", slug);
	return {
		directory,
		implementationSummaryPath: path.join(directory, `iteration-${iteration}.implementation-summary.md`),
		reviewJsonPath: path.join(directory, `iteration-${iteration}.review.json`),
		reviewMarkdownPath: path.join(directory, `iteration-${iteration}.review.md`),
		triageJsonPath: path.join(directory, `iteration-${iteration}.triage.json`),
		evidenceBundlePath: path.join(directory, `iteration-${iteration}.evidence-bundle.json`),
		externalValidationPath: path.join(directory, `iteration-${iteration}.external-validation.md`),
		fixHandoffPath: path.join(directory, `iteration-${iteration}.fix-handoff.md`),
		changedFilesPath: path.join(directory, `iteration-${iteration}.changed-files.json`),
		diffPath: path.join(directory, `iteration-${iteration}.diff.patch`),
		finalSummaryPath: path.join(directory, `final.summary.md`),
	};
}
