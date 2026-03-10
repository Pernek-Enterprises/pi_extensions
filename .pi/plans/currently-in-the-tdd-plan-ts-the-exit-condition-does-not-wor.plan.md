# Plan: Currently in the tdd-plan.ts the exit condition does not work well, we always hit the safety-cap. Please have a look at ~/.pi/agent/extensions/review.ts -> This also has a do -> review loop that exits much better than our loop! I want similar behaviour where if the tests are somewhat good (no critical problems) we should exit that loop so we can start with execution! Please analyze the differences of our implementation and that one and plan what we need to change to fix it!

## Recommended Split
- Slice 1: deliver the smallest end-to-end version of the feature for a single primary user flow.
- Slice 2: add the next user-visible capability or supporting variant on top of slice 1.

## Requested feature
Currently in the tdd-plan.ts the exit condition does not work well, we always hit the safety-cap. Please have a look at ~/.pi/agent/extensions/review.ts -> This also has a do -> review loop that exits much better than our loop! I want similar behaviour where if the tests are somewhat good (no critical problems) we should exit that loop so we can start with execution! Please analyze the differences of our implementation and that one and plan what we need to change to fix it!

## Existing codebase context
- Repo root: /Users/stefanpernek/parallel/.worktrees/pi_extensions/improve-tdd-loop-exit
- package.json: found
- Source directories: LICENSE, README.md, __tests__, docs, extensions, package.json
- Scripts: (none detected)
- Relevant files:
  - __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts: matches currently, plan, not, work, extensions, extension, tests, test
  - __tests__/extensions/tdd-plan-loop.test.ts: matches tdd, plan, extensions, extension, loop, tests, test
  - __tests__/extensions/tdd-plan.test.ts: matches tdd, plan, extensions, extension, tests, test
  - __tests__/extensions/plan-feature-spec.plan.test.ts: matches plan, extensions, extension, tests, test
  - extensions/tdd-plan.ts: matches tdd, plan, extensions, extension
  - docs/plan-feature-spec.md: matches plan
  - extensions/plan-feature.ts: matches plan, extensions, extension
  - extensions/worktree.ts: matches work, extensions, extension

## Problem statement
Add Currently in the tdd-plan.ts the exit condition does not work well, we always hit the safety-cap. Please have a look at ~/.pi/agent/extensions/review.ts -> This also has a do -> review loop that exits much better than our loop! I want similar behaviour where if the tests are somewhat good (no critical problems) we should exit that loop so we can start with execution! Please analyze the differences of our implementation and that one and plan what we need to change to fix it! in a way that fits the existing repository structure and conventions.

## Scope
- Review and update __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts
- Review and update __tests__/extensions/tdd-plan-loop.test.ts
- Review and update __tests__/extensions/tdd-plan.test.ts
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
