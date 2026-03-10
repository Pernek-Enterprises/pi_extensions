All open questions are resolved. The plan is complete — here's the finalized version:

---

# Plan: Inline Git Commands Extension

## Requested feature

A pi extension providing individual slash commands for common git operations — switching branches, getting latest main, committing, viewing status/diff, and managing PRs — all from within a pi session.

## Existing codebase context

- `extensions/worktree.ts` establishes the pattern: individual `pi.registerCommand()` calls, shell via `pi.exec("bash", ["-lc", cmd])`, user feedback via `ctx.ui?.notify()`, confirmation via `ctx.ui.confirm()`, selection via `ctx.ui.select()`
- PR creation logic already exists in `handleWorktreePr()` (uses `gh pr create`, `gh pr view`) — the new extension needs a simpler, non-worktree-aware version
- Package uses `"type": "module"` with peer deps on `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`

## Problem statement

Basic git operations require dropping to a shell or using `!git ...`. Dedicated slash commands with interactive UX (branch picker, dirty-tree prompts, notification feedback) make these operations faster and less error-prone.

## Scope

- `/git-status` — show `git status --short`, notify result
- `/git-diff` — show truncated diff (staged + unstaged); optional path argument
- `/git-checkout <branch>` — switch branch; interactive picker via `ctx.ui.select()` when no argument given; prompt to stash on dirty tree
- `/git-create-branch <slug>` — create and checkout new branch
- `/git-remote-main` — `git checkout main && git pull origin main`; prompt to stash on dirty tree
- `/git-commit <message>` — stage all + commit; if no message argument, prompt via `ctx.ui.input()`
- `/git-pr` — create PR via `gh pr create` against main; detect existing PR and update instead
- `/git-pr-update` — push current branch, update existing PR (or notify if none exists)

## Out of scope

- Worktree integration (handled by `extensions/worktree.ts`)
- Rebase / merge conflict resolution
- Git log browsing
- Multi-remote support (assumes `origin`)
- Stash management beyond auto-stash-before-checkout

## Clarified decisions

- **Individual commands**, not a single `/git` dispatcher — matches worktree extension pattern and allows multi-step orchestration per command
- **Interactive branch picker** when `/git-checkout` is called without arguments — uses `ctx.ui.select()` with output of `git branch -a`, strips `remotes/origin/` prefixes for display
- **Dirty working tree** on checkout/remote-main: prompt user via `ctx.ui.confirm()`, auto-stash if confirmed, auto-unstash after checkout
- **`/git-remote-main`** does exactly `checkout main && pull origin main` — no worktree metadata interaction
- **PR commands** use `gh` CLI — `ensureGhAuthenticated()` check before PR operations; always target `main` as base branch
- **Commit** stages all changes (`git add -A`) before committing — matches the worktree extension's commit behavior
- **Duplicate utilities** (`trimOutput`, `shQuote`, `detectRepoRoot`, `ensureGhAuthenticated`) — inline in the new file, no shared module
- **Diff truncation** — truncate large diff output in notifications

## Assumptions

- `origin` is the single relevant remote
- `main` is the default branch name
- `gh` CLI is available and authenticated for PR commands
- Notify-level feedback is sufficient for command results

## Acceptance criteria

- Each command runs from a pi session without dropping to shell
- `/git-checkout` without arguments shows an interactive branch picker
- `/git-checkout` and `/git-remote-main` prompt the user when working tree is dirty, stash automatically if confirmed
- `/git-commit` without a message argument prompts for one interactively
- `/git-pr` creates a new PR or detects an existing one; `/git-pr-update` pushes and reports the PR URL
- All commands notify success/failure via `ctx.ui.notify()`
- Extension loads via the existing `"pi": { "extensions": ["./extensions"] }` discovery

## Edge cases

- `/git-checkout` on a remote-only branch (auto-track via `git checkout <branch>`)
- `/git-remote-main` when already on main (skip checkout, just pull)
- `/git-commit` with no changes (notify "nothing to commit")
- `/git-pr` when on main (refuse with helpful message)
- `/git-pr` when branch has no upstream (push with `-u origin <branch>` first)
- Stash pop conflict after checkout (notify error, leave stash intact)

## Recommended Split

1. **Slice 1 — Navigation**: `/git-status`, `/git-checkout` (with picker + stash prompt), `/git-create-branch`, `/git-remote-main`
2. **Slice 2 — Changes**: `/git-diff`, `/git-commit`
3. **Slice 3 — PR workflow**: `/git-pr`, `/git-pr-update`
