# Plan: Currently when creating a PR with /worktree-pr the pr description is horrible. I want it to rather have the agent have a look at all the files in the diff and describe better what we are doing with the PR.

## Requested feature
currently when creating a PR with /worktree-pr the pr description is horrible. I want it to rather have the agent have a look at all the files in the diff and describe better what we are doing with the PR.

## Existing codebase context
- Repo root: /Users/stefanpernek/parallel/.worktrees/pi_extensions/better-pr-description-for-worktrees
- package.json: found
- Source directories: LICENSE, README.md, __tests__, docs, extensions, package.json
- Scripts: (none detected)
- Relevant files:
  - __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts: matches currently
  - extensions/worktree.ts: matches worktree

## Problem statement
Add Currently when creating a PR with /worktree-pr the pr description is horrible. I want it to rather have the agent have a look at all the files in the diff and describe better what we are doing with the PR. in a way that fits the existing repository structure and conventions.

## Scope
- Review and update __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts
- Review and update extensions/worktree.ts

## Out of scope
- Unconfirmed product changes beyond the requested feature

## Clarified decisions
- (none)

## Assumptions
- Reuse existing project conventions unless clarified otherwise.

## Open questions
- (none)

## Acceptance criteria
- The feature behavior is documented in repo-grounded terms.
- The plan cites affected modules or explicitly notes when no prior module exists.
- Acceptance criteria cover the primary user-visible flow and at least one edge case.

## Edge cases
- No obvious existing module is found for the request.
- Critical behavior remains ambiguous and needs clarification before implementation.
