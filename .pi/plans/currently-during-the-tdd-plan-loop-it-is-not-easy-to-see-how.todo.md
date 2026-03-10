# TODO: Implement blocker-driven `/tdd-plan-loop` and upstream `/plan` cleanup

Source plan: `.pi/plans/currently-during-the-tdd-plan-loop-it-is-not-easy-to-see-how.plan.md`

## Implementation order
1. Ship **Slice 1** first: tighten `/tdd-plan-loop` blocker handling, visibility, and promotion rules.
2. Then ship **Slice 2**: stop `/plan` from generating meta/process bullets that poison downstream TDD.
3. Finish with docs, regression tests, and a manual smoke pass over saved artifacts.

---

## Slice 1 — `/tdd-plan-loop` blocker visibility + promotion policy

### 1) Baseline the current behavior and align on the blocker model
- [ ] Read `extensions/tdd-plan.ts` end-to-end around:
  - `hasBlockingFindings()`
  - `buildAssessmentFeedbackPrompt()`
  - `renderAssessmentSummary()`
  - `runTddPlanLoop()`
  - `buildLoopIterationPaths()`
  - `setLoopWidget()` / status rendering
- [ ] Read `~/.pi/agent/extensions/review.ts` and copy the **mental model**, not the implementation:
  - blocker classification
  - stop conditions
  - dedicated fix prompt structure
  - visible blocker presentation
- [ ] Review existing artifacts under `.pi/generated-tdd/**` to confirm the noisy failure modes called out in the plan:
  - `(none)`
  - documentation/process bullets
  - out-of-scope/meta-only coverage findings
  - promotion after severe executability/grounding issues
- [ ] Decide the final blocker presentation format:
  - derived `P0/P1/P2/P3` band
  - blocker/non-blocker badge
  - or both
- [ ] Keep the structured JSON source of truth as category + severity, and derive review-style labels from that.

### 2) Introduce explicit blocker classification helpers in `extensions/tdd-plan.ts`
- [ ] Add a helper that classifies each finding as either:
  - blocking
  - non-blocking
- [ ] Encode the blocker policy from the plan:
  - block on any `high`
  - block on `medium` + `non-executable-or-unrealistic`
  - block on `medium` + `ambiguity` when it prevents repo-grounded tests
  - block on `medium` + `missing-major-plan-coverage` when it affects the primary flow / key edge case
  - do **not** block on low findings
  - do **not** block on medium findings that are only meta/doc/out-of-scope/optional polish
- [ ] Add a helper to derive a priority band for display/logging, e.g.:
  - `P0/P1/P2` for blockers
  - `P3` for advisory findings
- [ ] Add a helper to summarize blocker state for a whole assessment:
  - total finding count
  - blocking count
  - counts by severity
  - counts by category
  - highest blocker band
  - top blocker titles/tags
- [ ] Replace the current `hasBlockingFindings()` implementation so it delegates to the richer blocker-policy helper.
- [ ] Keep the helper names exportable through `__testables` so loop policy is unit-testable.

### 3) Make review output visibly blocker-driven
- [ ] Upgrade `renderAssessmentSummary()` so the markdown summary clearly shows:
  - verdict
  - blocker count
  - advisory count
  - counts by severity
  - highest blocker band
  - top blocker titles/categories
  - fix queue
- [ ] Upgrade `buildAssessmentFeedbackPrompt()` so it becomes a stronger review-style handoff:
  - call out blockers first
  - separate blockers from non-blockers
  - explain why each blocker matters
  - give imperative fix instructions
  - restate repo-grounding constraints
  - explicitly say not to preserve broken patterns from the prior round
- [ ] Add a dedicated per-round fix handoff artifact, e.g. one of:
  - `iteration-N.fix-handoff.md`
  - or `iteration-N.fix-prompt.md`
- [ ] Extend `buildLoopIterationPaths()` to include the new handoff artifact path.
- [ ] Persist the review-style fix handoff for every failing round, not just the raw findings JSON.
- [ ] Ensure the staged fix handoff is human-readable enough to inspect without reading raw JSON.

### 4) Tighten loop decisioning and stop conditions in `runTddPlanLoop()`
- [ ] Keep the existing happy path where zero findings promotes immediately.
- [ ] Change auto-promotion so it no longer means “no high findings”; it must mean “no blocker-class findings remain”.
- [ ] Prevent promotion when the assessor still returned `verdict: "fail"` **and** blocker-class findings remain.
- [ ] Decide and codify whether `verdict: "pass"` with advisory-only findings should promote automatically; document the rule in code comments/tests.
- [ ] Stop treating safety-cap output as implicitly good:
  - if blockers remain at the cap, mark the result unresolved
  - only promote from safety cap when the human explicitly overrides
- [ ] Preserve interactive acceptance, but reframe it as an explicit override:
  - rename UI copy conceptually to `Accept despite blockers`
  - only show that wording when blockers are present
- [ ] Ensure ask-each-round mode shows blocker context before the choice is made.
- [ ] Ensure auto-fix mode stops only when blocker-class findings are gone.
- [ ] Make the final stop reason distinguish between:
  - clean promotion
  - promotion with no blockers but advisory findings
  - human override with blockers
  - unresolved safety cap
  - cancelled / generation failure / assessment failure

### 5) Expand loop state + artifact logging for auditability
- [ ] Extend `LoopIterationRecord` and/or `TddLoopState` with explicit review metadata:
  - blocker count
  - advisory count
  - counts by severity
  - counts by category
  - highest blocker band
  - promotion reason
  - human override: yes/no
  - promoted with blockers: yes/no
  - unresolved at safety cap: yes/no
- [ ] Persist the new metadata in:
  - per-iteration summaries
  - `loop-summary.json`
  - the final coverage JSON written to `.pi/generated-tdd/...`
- [ ] Make the loop-summary schema easy to inspect after the fact.
- [ ] Confirm artifacts make it obvious why a weak result was promoted or not promoted.

### 6) Improve widget / notification / prompt copy
- [ ] Update the loop widget so it shows more than generic status:
  - current round
  - mode
  - blocker presence/count
  - highest blocker band
  - short last summary
- [ ] Update warning notifications to show the top blocker titles, not just raw counts.
- [ ] Update ask-each-round prompt text to explicitly distinguish:
  - continue fixing
  - accept despite blockers
  - cancel loop
- [ ] Make success notifications mention whether the promotion was:
  - clean
  - advisory-only
  - override-driven

### 7) Add/adjust tests for Slice 1
- [ ] Update `__tests__/extensions/tdd-plan-loop.test.ts` to cover blocker classification:
  - high severity always blocks
  - medium `non-executable-or-unrealistic` blocks
  - medium `ambiguity` blocks when grounding is impossible
  - medium `missing-major-plan-coverage` blocks for primary flow
  - medium meta/out-of-scope/doc-only findings do not block
  - low findings do not block
- [ ] Add tests for blocker summary rendering:
  - summary includes blocker counts/bands
  - fix queue puts blockers first
- [ ] Add tests for the new fix handoff artifact path from `buildLoopIterationPaths()`.
- [ ] Add tests for stop-reason behavior:
  - no findings remaining
  - no blockers remaining
  - user override with blockers
  - unresolved safety cap
- [ ] Add tests that guard against silent promotion when `verdict: "fail"` still has blockers.
- [ ] Add tests for final artifact metadata fields in the persisted loop summary / coverage payload.

---

## Slice 2 — `/plan` output cleanup so meta bullets stop poisoning TDD

### 8) Remove synthetic meta/process bullets from behavioral plan sections
- [ ] Read `extensions/plan-feature.ts` around:
  - `buildPlanningSystemPrompt()`
  - `renderPlanMarkdown()`
  - `synthesizePlanFromState()`
- [ ] Stop auto-populating `Acceptance criteria` with generic planning-quality bullets like:
  - “documented in repo-grounded terms”
  - “plan cites affected modules”
  - “covers primary flow and edge case”
- [ ] Stop auto-populating `Edge cases` with generic planning-process bullets like:
  - “no obvious module exists”
  - “behavior remains ambiguous”
- [ ] Decide where those non-behavioral notes should live instead:
  - `Existing codebase context`
  - `Assumptions`
  - `Open questions`
  - or a new clearly non-behavioral section
- [ ] Keep ambiguity visible, but do not encode it as a fake behavioral acceptance requirement.
- [ ] Ensure synthesized markdown defaults remain useful even when the planner has little repo context.

### 9) Stop auto-inserting generic `Recommended Split`
- [ ] Remove the unconditional `scope.length > 2` heuristic in `synthesizePlanFromState()`.
- [ ] Only include `Recommended Split` when the split is actually grounded in:
  - the user request
  - repo context
  - or explicit planner output
- [ ] Keep `renderPlanMarkdown()` conditional so the section is omitted when no grounded split exists.
- [ ] Update prompt instructions/tests so the model is nudged toward grounded slices, not boilerplate slice text.

### 10) Harden downstream requirement extraction against old saved plans
- [ ] Update `extensions/tdd-plan.ts` so `collectBehavioralTargets()` and related helpers ignore meta-only bullets even if an old plan file still contains them.
- [ ] Add a small helper such as `isBehavioralRequirementText()` or equivalent to filter out:
  - `(none)`
  - documentation/process-quality bullets
  - out-of-scope-only bullets
  - generic planning boilerplate
- [ ] Update `detectCoverageGaps()` so it only treats **real behavioral targets** as major missing coverage candidates.
- [ ] Ensure older saved plans still work, but they produce less noise.
- [ ] Be careful not to over-filter legitimate requirements that mention:
  - rollout
  - observability
  - security/permissions
  - performance
  when those are actual product behaviors or operational guarantees.

### 11) Update docs/specs for the new contract
- [ ] Update `docs/plan-feature-spec.md` so the final markdown output spec is explicit about:
  - behavioral sections containing real user/system behavior only
  - plan-quality notes living outside behavioral sections
  - ambiguity staying visible without becoming fake TDD debt
- [ ] Update the compatibility section with `tdd-plan` to reflect the new downstream rules.
- [ ] Add wording that `Recommended Split` is optional and should only appear when grounded.
- [ ] If a new non-behavioral section is introduced, document it in the final markdown spec.

### 12) Add/adjust tests for Slice 2
- [ ] Update `__tests__/extensions/plan-feature-spec.plan.test.ts` so synthesized plans:
  - omit generic `Recommended Split` by default
  - keep acceptance criteria behavioral
  - keep edge cases behavioral
  - keep plan-quality/process notes out of downstream behavioral sections
- [ ] Update `__tests__/extensions/tdd-plan.test.ts` so:
  - `collectBehavioralTargets()` ignores `(none)`
  - `collectBehavioralTargets()` ignores documentation/process bullets
  - `detectCoverageGaps()` does not create medium-severity noise for meta-only bullets
  - older plans with mixed good/bad bullets still extract the real behaviors
- [ ] Add a regression test where a real behavioral ambiguity still blocks appropriately while a doc-only ambiguity does not.

---

## Validation / smoke pass

### 13) Automated validation
- [ ] Run the targeted test files:
  - `__tests__/extensions/tdd-plan-loop.test.ts`
  - `__tests__/extensions/tdd-plan.test.ts`
  - `__tests__/extensions/plan-feature-spec.plan.test.ts`
- [ ] Run any broader extension test command used by this repo.
- [ ] Fix snapshots / fixture expectations if artifact schemas changed.

### 14) Manual smoke tests
- [ ] Create or reuse a saved plan that previously produced noisy meta-only findings.
- [ ] Run `/tdd-plan-loop` in auto-fix mode and verify:
  - blocker counts are visible
  - medium executability/grounding blockers stop promotion
  - advisory-only findings do not prevent promotion
- [ ] Run `/tdd-plan-loop` in ask-each-round mode and verify:
  - the prompt says `Accept despite blockers` when appropriate
  - override status is recorded in artifacts
- [ ] Force or simulate a safety-cap case and verify:
  - it is marked unresolved unless manually overridden
- [ ] Generate a fresh `/plan` and verify:
  - acceptance criteria are behavioral
  - edge cases are behavioral
  - `Recommended Split` is omitted unless actually grounded
- [ ] Inspect `.pi/generated-tdd/<slug>/` artifacts and confirm the audit trail is obvious.

---

## Suggested completion checklist
- [ ] Slice 1 merged and green
- [ ] Slice 2 merged and green
- [ ] Docs/spec updated
- [ ] Manual smoke pass completed
- [ ] Artifacts verified for blocker counts, override state, promotion reason, and final stop reason
