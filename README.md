# pi_extensions

A public home for pi extensions and experiments by Pernek Enterprises.

## Included extensions

### `extensions/worktree.ts`
Managed git worktree workflow for pi.

Commands:
- `/worktree-start <slug>` — create a managed worktree from `main`, create a `worktree/<slug>` branch, persist metadata, and hand off into the new checkout.
- `/worktree-pr` — from inside a managed worktree, generate commit/PR text, commit if needed, push, and open or reuse a GitHub PR.
- `/worktree-cleanup` — safely remove a managed worktree after changes are committed/pushed, persist cleanup metadata, and return to the main checkout.

Notable behavior:
- Stores managed worktree metadata under `.pi/worktrees/`.
- Mirrors metadata/history to the shared checkout root so `start`, `pr`, and `cleanup` keep working across main and linked worktrees.
- Records failures and lifecycle history for managed worktrees.

### `extensions/plan.ts`
Interactive planning workflow inside pi. Produces a structured raw plan and extracts an execution contract.

Commands:
- `/plan <feature brief|url>` — start a planning session from a feature brief, or auto-switch to link-based planning when the argument is a URL.
- `/plan-from-scratch <feature brief>` — start a planning session from a plain-language brief.
- `/plan-from-file <path>` — start a planning session grounded in an existing local file.
- `/plan-from-link <url>` — start a planning session grounded in an external link such as a GitHub issue.
- `/plan-save [path]` — save the current plan markdown and extract an execution contract. If `path` exists, it is read as the plan source; otherwise, an active in-memory draft is saved to that path first.
- `/plan-answer` — provide answers to open planning questions (supports TUI and inline input).
- `/plan-status` — show the current planning session status.
- `/plan-next` — show the saved execution contract path for the next implementation step.
- `/end-planning` — end the active planning session.

Notable behavior:
- Persists planning session state across session navigation.
- Extracts repo context and relevant files automatically.
- Uses mode-specific planning prompts for scratch briefs, local files, and external links.
- Derives smarter plan/contract filenames from source context (for example, file paths and GitHub issue numbers/titles).
- Keeps a canonical raw plan draft under `.pi/plans/` and saves execution contracts as `.plan.contract.json` siblings.
- Syncs markdown plans produced in chat back to the canonical draft path so `/plan-save` and `/implement-plan-loop` stay aligned.

### `extensions/planning/`
Shared modules for the planning workflow:
- `contract-extractor.ts` — AI-powered extraction of execution contracts from raw plan artifacts.
- `contract-render.ts` — renders execution contracts back to markdown.
- `contract-schema.ts` — TypeScript types for the execution contract format.
- `contract-validator.ts` — normalizes and validates execution contracts.
- `question-loop.ts` — extracts, merges, and formats open planning questions.
- `question-ui.ts` — TUI component for answering planning questions interactively.
- `raw-artifact.ts` — utilities for building raw plan paths and rendering plan markdown.

### `extensions/implement-plan-loop.ts`
Automated implementation/review loop driven by a ready execution contract.

Commands:
- `/implement-plan-loop <plan.contract.json>` — start an implementation loop against a ready execution contract.
- `/implement-plan-loop-status` — show the current loop status (iteration, review summary, triage decisions).
- `/end-implement-plan-loop` — end the current implementation loop session.

Notable behavior:
- Runs an implement → review → triage state machine with up to 8 iterations.
- Uses a separate model call for contract-aware implementation review.
- Triages blocking findings into implementation repairs, evidence gathering, or external validation handoffs.
- Stores iteration artifacts (summaries, reviews, diffs, triage decisions) under `.pi/generated-implementation/`.

### `extensions/implement/`
Shared modules for the implementation loop:
- `contract-input.ts` — loads and validates execution contracts for the implementation loop.
- `loop-artifacts.ts` — builds artifact paths for each iteration.
- `loop-state.ts` — state management (persist, load, clear) for the implementation loop.
- `prompts.ts` — prompt builders for implementation, review, fix handoff, and evidence bundles.

## Usage

### Load as a pi package
This repository exposes all extensions in `./extensions` via `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

For local development, either:
- load this repository as a pi package, or
- copy/symlink individual files from `extensions/` into your pi extensions directory.

## Repository layout

- `extensions/worktree.ts` — managed worktree lifecycle commands
- `extensions/plan.ts` — interactive planning workflow
- `extensions/planning/` — shared planning modules (contract extraction, validation, question loop, TUI)
- `extensions/implement-plan-loop.ts` — automated implementation/review loop
- `extensions/implement/` — shared implementation loop modules (contract input, artifacts, state, prompts)

## License

MIT
