# Plan: Improve `/tdd-plan-loop` blocker visibility and upstream `/plan` grounding

## Recommended Split
- **Slice 1: Make `/tdd-plan-loop` stop/promotion decisions review-style and visibly blocker-driven**
  - Deliver end-to-end value by making the loop clearly show blocker severity, produce a strong fix handoff, and stop auto-promoting weak output.
- **Slice 2: Fix `/plan` output so saved plans stop poisoning `/tdd-plan-loop` with meta/process requirements**
  - Deliver end-to-end value by generating cleaner plans that downstream TDD can convert into realistic tests.

## Requested feature
Review the `/tdd-plan-loop` flow comprehensively and make it behave more like `~/.pi/agent/extensions/review.ts`: the review should clearly surface issue severity, give the agent a strong prompt to fix concrete problems, and stop looping once the output is good enough instead of drifting into weak tests or hitting the safety cap.

User decisions captured:
- Humans may still accept despite blockers, but **P0–P2 style blockers must be visible**, not buried in prose.
- For medium-severity findings in risky categories, use the stronger blocker policy recommended below.
- Fix the issue **upstream on the `/plan` side too**, so meta-only plan bullets stop poisoning the TDD loop.

## Existing codebase context

### Facts
- **`extensions/tdd-plan.ts` already has loop stop reasons**, including `"no-blocking-findings"`, `"user-accepted-current-output"`, and `"safety-cap-reached"`.  
  This means the repo already models loop outcomes explicitly.
- **`extensions/tdd-plan.ts` currently defines blocking too narrowly**:
  - `hasBlockingFindings()` returns true only when a finding has `severity === "high"`.
- **`extensions/tdd-plan.ts` auto-promotes when there are no high-severity findings**, even if the assessor still returned `verdict: "fail"`.
- **`extensions/tdd-plan.ts` also promotes on safety cap**, which can make a weak result look “done”.
- **`extensions/tdd-plan.ts` already builds a review-style fix queue text** via `buildAssessmentFeedbackPrompt()`, but it is only fed back into the next generator round; there is no stronger dedicated “fix these findings now” handoff flow like `review.ts`.
- **`~/.pi/agent/extensions/review.ts` uses a clearer blocker contract**:
  - `hasBlockingReviewFindings()` treats `[P0]`, `[P1]`, and `[P2]` as blocking.
  - The loop stops only when no blocking findings remain.
  - It has a dedicated fix prompt: `REVIEW_FIX_FINDINGS_PROMPT`.
- **`extensions/plan-feature.ts` currently synthesizes meta/process bullets directly into behavioral sections**:
  - Acceptance criteria include:
    - `"The feature behavior is documented in repo-grounded terms."`
    - `"The plan cites affected modules or explicitly notes when no prior module exists."`
    - `"Acceptance criteria cover the primary user-visible flow and at least one edge case."`
  - Edge cases include:
    - `"No obvious existing module is found for the request."`
    - `"Critical behavior remains ambiguous and needs clarification before implementation."`
- **`extensions/plan-feature.ts` also auto-inserts a generic split** when `scope.length > 2`:
  - `"Slice 1: deliver the smallest end-to-end version..."`
  - `"Slice 2: add the next user-visible capability..."`
- **`extensions/tdd-plan.ts` treats `Scope`, `Acceptance criteria`, `Clarified decisions`, and `Edge cases` as behavioral inputs** via `collectBehavioralTargets()` and `detectCoverageGaps()`.  
  That means the meta bullets produced by `/plan` get treated as testable requirements downstream.
- **Artifacts in `.pi/generated-tdd/...` show repeated noisy findings** such as:
  - `"(none)"`
  - documentation-quality criteria
  - out-of-scope text
  being flagged as missing behavioral coverage.
- **Artifacts also show real severe failures still getting promoted or manually accepted**, including findings like:
  - non-existent APIs
  - invented signatures
  - unrealistic test harnesses

### Assumptions
- Tightening both the loop policy and the plan output will reduce safety-cap hits more effectively than changing only one side.
- The best fit is to **adapt** the `review.ts` mental model, not literally copy its implementation, because `/tdd-plan-loop` already uses structured JSON findings rather than markdown `[P0]` tags.

## Problem statement
The current flow has two coupled problems:

1. **The loop does not clearly distinguish “advisory issues” from “do not promote this” issues.**  
   Repo evidence: `hasBlockingFindings()` only checks `severity === "high"` in `extensions/tdd-plan.ts`.

2. **The upstream plan generator injects meta/process bullets into sections that `/tdd-plan-loop` treats as behavioral requirements.**  
   Repo evidence: `extensions/plan-feature.ts` synthesizes documentation/process bullets into `Acceptance criteria` and `Edge cases`, and `extensions/tdd-plan.ts` later consumes those sections as test targets.

Together, this makes the loop both:
- too noisy about the wrong things, and
- too weak at stopping the wrong output from being promoted.

## Affected modules
- `extensions/tdd-plan.ts`
- `extensions/plan-feature.ts`
- `__tests__/extensions/tdd-plan-loop.test.ts`
- `__tests__/extensions/tdd-plan.test.ts`
- `__tests__/extensions/plan-feature-spec.plan.test.ts`
- `docs/plan-feature-spec.md`

## Clarified decisions
- Keep **human override** available, but make blocker visibility explicit.
- Adopt a **review-style blocker model** for auto-promotion decisions.
- Fix the problem **both downstream and upstream**:
  - downstream: `/tdd-plan-loop` decisioning, visibility, handoff
  - upstream: `/plan` output quality and section hygiene
- Prefer explicit blocker summaries and fix queues over burying severity in freeform summaries.
- Do not silently treat safety-cap output as “good enough”.

## Blocker policy
Recommended policy for **auto-promotion**:

### Auto-promotion should block on
- **Any high-severity finding**
- **Any medium-severity `non-executable-or-unrealistic` finding**
- **Any medium-severity `ambiguity` finding that prevents repo-grounded tests**
- **Any medium-severity `missing-major-plan-coverage` finding for the primary flow**
  - requested feature
  - primary acceptance criteria
  - key edge case in scope

### Auto-promotion should not block on
- low-severity findings
- medium-severity findings tied only to:
  - out-of-scope text
  - empty sections like `"(none)"`
  - documentation/process/meta criteria
  - optional polish not required for the primary flow

### Human override
- Keep manual accept in interactive mode.
- Rename/reframe it as an explicit override, e.g. conceptually:
  - **Accept despite blockers**
- Show visible blocker counts and top blocker tags before the user decides.

## Scope

### Slice 1: `/tdd-plan-loop`
- Make blocker visibility explicit in loop summaries, status, and user prompts.
- Replace the current high-only blocker gate with the blocker policy above.
- Add a stronger review-style fix handoff artifact/prompt per failing round.
- Prevent silent “looks fine” promotion when the assessor still reports important blockers.
- Make safety-cap outcomes explicitly unresolved unless the human overrides.
- Preserve manual human acceptance with visible blocker context.
- Record promotion reason and blocker state in loop artifacts.

### Slice 2: `/plan`
- Stop synthesizing documentation/process bullets into behavioral sections that feed `tdd-plan`.
- Stop auto-inserting generic `Recommended Split` text unless the split is genuinely grounded in the request/repo.
- Keep ambiguity/process quality visible, but move it to non-behavioral sections or separate metadata so it does not become fake test coverage debt.
- Ensure generated plans distinguish:
  - behavioral requirements
  - plan quality notes
  - unresolved ambiguity
  - out-of-scope constraints

## Out of scope
- Replacing the whole `tdd-plan` model interaction design
- Removing manual human judgment from the loop
- Building a large new planning UI
- Solving every possible plan-quality issue unrelated to TDD downstream compatibility

## Acceptance criteria
- `/tdd-plan-loop` shows visible blocker information, not just a generic summary, before promotion or manual accept.
- Auto-fix mode stops only when blocker-class findings are gone, not merely when high-severity findings are gone.
- Ask-each-round mode allows human override, but the UI/status clearly shows blocker presence and severity before acceptance.
- Safety-cap outcomes are recorded as unresolved or overridden, not implicitly treated as clean.
- Each failing loop round produces a concrete fix handoff with:
  - blocker titles
  - why they matter
  - required fixes
  - repo-grounding constraints
- `/plan` no longer places documentation/process/meta bullets inside downstream behavioral sections consumed by `/tdd-plan`.
- `/tdd-plan` coverage-gap detection no longer treats empty/meta-only requirements as major missing behavioral coverage.
- Repo artifacts make promotion decisions auditable:
  - blocker counts
  - override status
  - promotion reason
  - final stop reason

## Edge cases
- A round has no high findings but still has medium-severity executability or grounding blockers.
- A plan is genuinely ambiguous; ambiguity remains visible and blocks auto-promotion only when it prevents grounded tests.
- A human accepts output despite blockers; the artifacts record that this was an override.
- The loop hits safety cap with blockers still open.
- An older saved plan still contains meta bullets in behavioral sections.
- No obvious module exists yet; the plan may note that fact without turning it into a fake behavioral test requirement.

## Rollout / migration
- Ship Slice 1 first to stabilize loop trust without waiting on upstream plan improvements.
- Then ship Slice 2 so new plans stop generating avoidable noise.
- Preserve backward compatibility for existing interactive workflows by keeping manual acceptance available.
- If needed, gate stricter auto-promotion behind a temporary rollout flag during validation, but the intended end state should be the stricter default.

## Audit logging / analytics / observability
Add loop artifact fields and status reporting for:
- blocker counts by severity and category
- derived blocker priority band (P0/P1/P2/P3-style or equivalent)
- promotion reason
- promoted with blockers: yes/no
- human override: yes/no
- unresolved at safety cap: yes/no
- iterations to clean result
- rate of noise findings from meta-only plan bullets
- generation failure vs assessment failure rates

This is strongly supported by the existing repo pattern of persisting:
- `iteration-*.coverage.json`
- `iteration-*.findings.json`
- `iteration-*.findings.md`
- `loop-summary.json`

## Test impact
Update tests so the repo explicitly verifies:
- blocker classification and promotion rules in `__tests__/extensions/tdd-plan-loop.test.ts`
- meta-only requirement filtering and behavioral target extraction in `__tests__/extensions/tdd-plan.test.ts`
- `/plan` synthesized markdown quality and downstream-compatible section content in `__tests__/extensions/plan-feature-spec.plan.test.ts`

## Remaining blockers
No major product blockers remain.

The only implementation-level ambiguity left is whether blocker visibility should be represented as:
- derived P0–P3 tags,
- blocker/non-blocker badges,
- or both.

My recommendation: **both** internally/visually align with `review.ts` semantics, while keeping the structured category/severity data already used by `tdd-plan.ts`.
