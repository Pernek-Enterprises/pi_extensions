# Plan: Extensions

## Recommended Split
- Slice 1: deliver the smallest end-to-end version of the feature for a single primary user flow.
- Slice 2: add the next user-visible capability or supporting variant on top of slice 1.

## Requested feature
Currently worktree cleanup needs the exact worktree slug to cleanup the worktree. I want to add the option that one can simply send /worktree-cleanup and then as a followup can select which worktrees should be cleaned up. (With a pi inline thingy where once can select options and send it back). (We have that for example in the /ss command found in ~/.pi/agent/extensions

## Existing codebase context
- Repo root: /Users/stefanpernek/parallel/.worktrees/pi_extensions/improve-worktree-cleanup
- package.json: found
- Source directories: LICENSE, README.md, __tests__, docs, extensions, package.json
- Scripts: (none detected)
- Relevant files:
  - __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts: matches currently, extensions, extension
  - __tests__/extensions/tdd-plan.test.ts: matches extensions, extension
  - extensions/worktree.ts: matches worktree, extensions, extension
  - __tests__/extensions/plan-feature-spec.plan.test.ts: matches extensions, extension
  - __tests__/extensions/tdd-plan-loop.test.ts: matches extensions, extension
  - extensions/tdd-plan.ts: matches extensions, extension
  - extensions/plan-feature.ts: matches extensions, extension

## Problem statement
Add Extensions in a way that fits the existing repository structure and conventions.

## Scope
- Review and update __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts
- Review and update __tests__/extensions/tdd-plan.test.ts
- Review and update extensions/worktree.ts
- Review and update __tests__/extensions/plan-feature-spec.plan.test.ts

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
