# Interactive Feature Planning Extension Spec

## Working name

`plan-feature`

Primary commands:

- `/plan <brief-or-plan-path>`
- `/plan-save [path]`
- `/plan-status`
- `/plan-done`
- `/plan-tests`
- `/end-planning`

---

## 1. Goal

Provide a repo-aware planning workflow that turns a vague feature request into a concrete markdown implementation plan.

The extension should:

1. inspect the repository first
2. explicitly identify what already exists
3. ask only the most important clarifying questions
4. produce a structured markdown plan
5. optionally hand that plan off to the existing `tdd-plan` extension

This should feel like a technical planning assistant, not a generic brainstorming prompt.

---

## 2. Key UX requirements

### Core entrypoint

```text
/plan "Feature ABC"
```

Expected flow:

1. user invokes `/plan`
2. extension starts planning in a **new branch/session flow**, modeled after `/review`
3. agent inspects the codebase and summarizes relevant findings
4. agent asks targeted clarifying questions
5. user answers in normal conversation
6. agent produces a final structured markdown plan
7. user can save it and optionally generate tests from it

### End command

```text
/end-planning
```

Behavior:

- always return to the original session position
- no extra choices
- no summarize/fix options
- just go back

This intentionally mirrors the `/review` pattern, but simplified.

---

## 3. Explicit inspiration from existing `~/.pi` extensions

The design should intentionally reuse patterns from the existing extensions in `~/.pi/agent/extensions`:

### `review.ts`
Use as the primary design reference for:

- starting a workflow in a new branch/session context
- storing an origin anchor
- showing an active-session widget
- restoring state on `session_start`, `session_switch`, and `session_tree`
- ending the workflow and navigating back with a dedicated command

Important adaptation:

- `/review` asks whether to start in `Empty branch` or `Current session`
- **`/plan` should not ask**
- **`/plan` should always start in a new branch/session-style flow**

### `answer.ts`
Use as inspiration for:

- guided clarification workflows
- extracting and presenting questions cleanly
- interactive follow-up UI if needed later

Not required for v1, but useful for future planning-question UX.

### `loop.ts`
Use as inspiration for:

- widget/status patterns
- persisted state via custom session entries
- session restoration behavior

### existing `tdd-plan.ts`
Use as the primary design reference for:

- repo inspection helpers
- plan markdown compatibility
- downstream handoff format

---

## 4. Product principles

### A. Grounded planning
The planner must inspect the codebase and cite explicit evidence.

Good:
- `src/invoices/createInvoice.ts` already handles one-off invoice creation
- `tests/invoices/createInvoice.spec.ts` shows existing test conventions

Bad:
- “You could add a service layer” without evidence

### B. Clarify only what matters
Questions should only be asked if they materially affect:

- architecture
- data model
- UX flow
- permissions/auth
- API behavior
- migration strategy
- testability

### C. Produce reusable output
The markdown output must be useful for:

- implementation planning
- team review
- `tdd-plan`

### D. Stay in planning mode
The extension should not jump into coding unless explicitly requested.

---

## 5. Command surface

## `/plan <brief-or-path>`
Start a new planning workflow.

Accepted inputs:

- short feature brief
  - `/plan "Add recurring invoices"`
- longer raw text
  - `/plan Add recurring invoices with pause/resume and reminders`
- path to an existing markdown draft
  - `/plan plans/recurring-invoices.md`

Behavior:

1. ensure model/auth are available
2. determine whether argument is a file path or plain feature brief
3. capture current session origin exactly like the review flow does
4. create a new planning branch/session flow automatically
5. initialize planning state
6. inspect repo and gather context
7. send a planning prompt to the agent
8. planning conversation continues in the new branch

### Session behavior
This must copy the **review branch workflow** but with no mode selection.

Concretely:

- if there is an existing conversation, capture the origin leaf
- if there is no leaf yet, create a lightweight planning anchor entry first
- branch away so planning happens in an isolated context
- label the branch something like `feature-planning`
- show a widget indicating planning mode is active

No `Empty branch / Current session` selector should appear.

Planning should always start in the isolated branch.

---

## `/end-planning`
Finish planning and return to the original session position.

Behavior:

1. verify an active planning session exists
2. navigate back to the original origin id
3. do **not** summarize automatically
4. do **not** queue implementation work automatically
5. clear planning state
6. remove planning widget
7. show a success notification

This is equivalent to the `Return only` path in `/end-review`, but it is the only path.

---

## `/plan-save [path]`
Save the current plan markdown.

Default path:

```text
.pi/plans/<slug>.plan.md
```

Behavior:

- if a finalized draft exists, save it
- if only a partial draft exists, ask whether to save partial
- if no draft exists, ask the agent to synthesize the current best plan first
- optionally save metadata JSON alongside it

---

## `/plan-status`
Show current planning workflow status.

Should include:

- title
- slug
- state/status
- repo root
- source input type (brief or file)
- relevant files count
- open questions count
- answered questions count
- saved path if any
- whether planning mode is currently active

---

## `/plan-done`
Force the planner to produce the best final markdown now.

Behavior:

- send a follow-up prompt asking the agent to stop questioning and finalize the plan
- update in-memory draft
- suggest `/plan-save`

---

## `/plan-tests`
Bridge into the existing `tdd-plan` workflow.

Behavior:

- ensure a saved plan file exists
- if not saved yet, prompt to save first
- then either:
  - instruct the user to run `/tdd-plan <path>`
  - or later, automate that handoff

---

## Optional later commands

- `/plan-reset`
- `/plan-questions`
- `/plan-assumptions`

Not required for v1.

---

## 6. State model

Suggested runtime state:

```ts
type PlanningSessionState = {
  active: boolean;
  originId?: string;
  planningEntryId?: string;

  id: string;
  title: string;
  slug: string;
  originalInput: string;
  sourcePlanPath?: string;

  status: "collecting-context" | "clarifying" | "drafting" | "finalized";

  repoRoot: string;
  createdAt: string;
  updatedAt: string;

  repoContextSummary?: string;
  relevantFiles: Array<{
    path: string;
    reason: string;
    preview?: string;
  }>;

  questions: Array<{
    id: string;
    question: string;
    answer?: string;
    status: "open" | "answered" | "skipped";
  }>;

  assumptions: string[];
  decisions: string[];

  currentDraft?: string;
  savedPath?: string;
};
```

### Persistence approach
For v1, use the same pattern as `review.ts` and `loop.ts`:

- module-level state for active runtime behavior
- custom session entries via `pi.appendEntry()` for restoration

Suggested custom entry types:

- `planning-session`
- `planning-anchor`
- `planning-draft`
- `planning-metadata`

At minimum, persist enough to restore:

- whether planning is active
- origin id
- title/slug
- saved path
- current status

---

## 7. Session and navigation design

This section should intentionally mirror the successful parts of `review.ts`.

### Start behavior
When `/plan` runs:

1. if a planning session is already active, block and ask user to finish it first
2. record the current origin leaf id
3. if no current leaf exists, append a lightweight anchor entry
4. navigate to a new branch context from a stable point
5. label that branch `feature-planning`
6. clear editor text if needed
7. restore locked origin id after navigation events
8. persist planning state
9. show widget: `Planning session active, return with /end-planning`

### End behavior
When `/end-planning` runs:

1. look up active origin id from memory or persisted custom entry
2. call `ctx.navigateTree(originId, { summarize: false })`
3. clear planning state
4. remove widget
5. notify success

### Why this matters
This gives planning a clean isolated branch, while preserving an easy return path back to the original coding session.

---

## 8. Repo inspection requirements

The planner must inspect the codebase before asking questions or producing a plan.

### Required repo context

#### Project shape
- repo root
- `package.json`
- framework / library indicators
- source directories
- test directories
- scripts

#### Candidate relevant files
Based on feature keywords, identify:

- matching filenames
- matching directories
- content matches via grep/search
- nearby tests
- related docs/specs/plans

#### Existing conventions
Find evidence for:

- component structure
- service/module layout
- naming conventions
- testing style
- route structure if relevant

### Reuse from `tdd-plan.ts`
The new extension should reuse or adapt helpers like:

- `findUp()`
- `loadPackageJson()`
- `listFiles()`
- repo summarization logic

### Relevance strategy
For v1, use simple heuristics:

1. filename/path matches from extracted keywords
2. content grep matches
3. nearby tests
4. likely domain modules

Only send the best few matches to the model.

---

## 9. Planning prompt contract

The extension should build a dedicated planning-mode instruction.

Suggested behavior contract:

> You are in feature planning mode. First inspect the provided repository context and understand what already exists. Explicitly cite relevant files, modules, routes, components, or tests. Distinguish facts from assumptions. Ask only the highest-value clarifying questions that materially affect implementation. Usually ask no more than 3–5 at a time. Do not write implementation code. Once enough is known, produce a structured markdown plan with sections for requested feature, existing codebase context, scope, out of scope, clarified decisions, assumptions, open questions, implementation plan, acceptance criteria, edge cases, and test ideas.

### Required agent behaviors

The agent must:

- cite repo evidence explicitly
- distinguish facts vs assumptions
- ask concise, high-value questions
- avoid generic product discovery fluff
- avoid implementation code
- produce structured markdown when enough is known

The agent must not:

- invent architecture not supported by the repo
- jump immediately into coding
- ask giant questionnaires
- finalize a plan while critical blockers remain unclear

---

## 10. Questioning strategy

Questions should be prioritized like this:

### Priority 1: implementation blockers
- data model ambiguity
- UX flow ambiguity
- permissions/auth ambiguity
- API contract ambiguity
- migration / compatibility ambiguity

### Priority 2: important constraints
- performance expectations
- rollout strategy
- audit/logging needs
- analytics needs
- observability requirements

### Priority 3: polish decisions
- naming preferences
- secondary UX preferences
- non-blocking refinements

The planner should normally ask **3–5 questions max per round**.

---

## 11. Final markdown output spec

The final markdown must be structured and downstream-friendly.

Required sections:

```md
# Plan: <title>

## Requested feature
<original brief>

## Existing codebase context
- explicit repo findings
- relevant files and what they already do

## Problem statement
<why this feature exists>

## Scope
- item
- item

## Out of scope
- item
- item

## Clarified decisions
- decision + rationale

## Assumptions
- assumption

## Open questions
- unresolved item

## Implementation plan
1. step
2. step
3. step

## Acceptance criteria
- concrete behavior
- concrete behavior

## Edge cases
- edge case
- failure mode

## Test ideas
- test idea
- test idea
```

Optional sections if relevant:

- Data model changes
- API changes
- Rollout / migration
- Observability
- Security / permissions
- Performance considerations

---

## 12. Compatibility with `tdd-plan`

This extension is the upstream planning stage for the existing `tdd-plan` extension.

### Output design constraints
The saved markdown should be written so `tdd-plan` can extract useful requirements from:

- `## Scope`
- `## Clarified decisions`
- `## Acceptance criteria`
- `## Edge cases`
- `## Test ideas`

### Recommendation
Favor bullet lists for these sections, because `tdd-plan.ts` already extracts bullet and numbered requirements.

Example:

```md
## Acceptance criteria
- Users can create a recurring invoice with a monthly interval
- Users can pause an active recurring invoice without deleting it
- Resuming a paused recurrence recalculates the next run date
```

---

## 13. UI behavior

### Widget
While planning is active, show a widget similar to review mode:

- `Planning session active, return with /end-planning`

Optional variant when draft exists:

- `Planning session active (draft ready), return with /end-planning`

### Notifications
Use concise notifications for:

- planning started
- context collected
- plan saved
- planning returned to original position
- no active planning session
- missing model/auth

### No custom TUI required for v1
Do not build a large wizard UI first.

Use:

- command entry
- normal chat-based clarification
- optional `ctx.ui.input/confirm` only where needed

---

## 14. Error handling

### No model selected
Show:
- `No active model selected`

### Missing API key/session
Show:
- `Authenticate the active model first`

### No repo root / no package.json
Still work using `ctx.cwd` as root.

### No relevant files found
The planner should explicitly say that it did not find an obvious existing module and ask whether this is a greenfield area.

### Vague input
Example:

```text
/plan "make billing better"
```

Expected response:

- summarize what billing-related code exists
- ask narrowing questions before drafting

### Active planning already running
Block starting another `/plan` until `/end-planning` completes.

---

## 15. Success criteria

A successful run should satisfy all of these:

### Repo grounding
The plan explicitly references real files/modules found in the repo.

### Clarification quality
The planner asks a small number of meaningful questions, not filler.

### Plan usefulness
A teammate could implement from the plan.

### Test-generation readiness
The saved markdown can be fed into `tdd-plan` with little or no cleanup.

### Good session ergonomics
The user can safely branch into planning and then cleanly return with `/end-planning`.

---

## 16. Non-goals for v1

Do not build these yet:

- full custom wizard UI
- visual multi-step planning dashboard
- implementation code generation
- vector DB / semantic indexing
- multi-agent planning orchestration
- automatic issue/PR creation

Keep v1 lean.

---

## 17. Implementation outline

Recommended file:

```text
extensions/plan-feature.ts
```

### Main parts

#### A. Planning state helpers
Functions similar to `review.ts`:

- `getPlanningState(ctx)`
- `applyPlanningState(ctx)`
- `clearPlanningState(ctx)`
- `setPlanningWidget(ctx, active)`

#### B. Repo context helpers
Adapted from `tdd-plan.ts`:

- repo root detection
- package.json loading
- file scanning
- keyword extraction
- relevant file previews

#### C. Prompt builders

- planning system prompt
- initial user prompt with repo evidence
- finalization prompt for `/plan-done`

#### D. Commands

- `/plan`
- `/plan-save`
- `/plan-status`
- `/plan-done`
- `/plan-tests`
- `/end-planning`

---

## 18. Recommended implementation phases

### Phase 1
- `/plan`
- repo inspection
- forced new branch/session flow
- planning widget
- `/end-planning`
- planning prompt + chat clarification

### Phase 2
- maintain in-memory draft
- `/plan-save`
- markdown save format
- `/plan-status`

### Phase 3
- richer relevant-file ranking
- metadata JSON
- `/plan-tests`

### Phase 4
- better question extraction / guided answering
- optional assisted Q&A UI inspired by `answer.ts`

---

## 19. Example ideal interaction

### User

```text
/plan "Add recurring invoices"
```

### Assistant

```text
I inspected the repo and found invoice creation logic in `src/invoices/createInvoice.ts`,
invoice form UI in `src/ui/invoices/InvoiceForm.tsx`, and related tests in
`tests/invoices/createInvoice.spec.ts`. I also found scheduling-related logic in
`src/billing/schedules.ts`, which may be reusable.

Before I draft the implementation plan, I need to clarify a few decisions:

1. Should recurring invoices generate automatically on a schedule, or only create reusable templates?
2. Do users need pause/resume/cancel controls?
3. Should recurrence apply to all invoice types or only standard invoices?
4. Are email reminders in scope for this first version?
```

### User

```text
Automatic schedule, yes pause/resume, only standard invoices, email later.
```

### Assistant

Produces final structured plan markdown.

### User

```text
/plan-save
```

### User later

```text
/end-planning
```

Returns to original branch position.

---

## 20. Design decisions locked in for this spec

These points are intentionally fixed based on your requirements:

1. `/plan` uses the **review-style isolated branch/session flow**
2. unlike `/review`, `/plan` does **not** offer a session mode choice
3. `/plan` always starts in the isolated branch
4. `/end-planning` exists and is mandatory for returning
5. `/end-planning` has exactly one behavior: **just go back**
6. the extension should draw design inspiration from the existing `~/.pi` extensions, especially:
   - `review.ts`
   - `answer.ts`
   - `loop.ts`
   - existing `tdd-plan.ts`

---

## 21. Recommendation for next step

Implement `extensions/plan-feature.ts` by first copying the **session/origin/widget/end-flow pattern** from `~/.pi/agent/extensions/review.ts`, then layering in the repo-context and markdown-planning logic from `extensions/tdd-plan.ts`.
