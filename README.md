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

### `extensions/plan-feature.ts`
Interactive feature-planning workflow inside pi.

Commands:
- `/plan <feature brief or plan path>` — start planning mode, collect repo context, and begin an isolated planning session.
- `/plan-status` — show the current planning session status.
- `/plan-done` — ask the planner to finalize the current draft.
- `/plan-save [path]` — save the current plan markdown.
- `/plan-tests` — show the next `/tdd-plan` command for the saved plan.
- `/end-planning` — return from planning mode to the original session position.

Notable behavior:
- Persists planning session state across session navigation.
- Extracts repo context and relevant files automatically.
- Supports interactive clarification questions in the TUI.
- Saves plans under `.pi/plans/` by default.

### `extensions/tdd-plan.ts`
Generate TypeScript test files from a markdown plan, using repo-aware AI generation and an assessment loop.

Highlights:
- Reads markdown plans and extracts behavioral requirements.
- Detects local test conventions to choose better output paths and naming.
- Runs a generator + assessor loop to improve produced tests.
- Stores iteration artifacts under `.pi/generated-tdd/`.

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
- `extensions/plan-feature.ts` — interactive planning workflow
- `extensions/tdd-plan.ts` — markdown-plan-to-tests generation
- `docs/plan-feature-spec.md` — planning workflow notes/spec

## License

MIT
