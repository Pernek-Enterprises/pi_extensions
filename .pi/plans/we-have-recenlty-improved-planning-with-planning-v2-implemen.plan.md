# Plan: Remove old plan-feature.ts & tdd-plan.ts, drop v2 suffix from all planning/implement extensions

## Requested feature
Delete the two legacy planning/TDD extensions (plan-feature.ts, tdd-plan.ts) and clean up all associated artifacts (docs, tests, README references). Replace the `/plan-tests-v2` command with a new `/plan-next` command that shows the execution contract path. Drop the "v2" suffix from all remaining planning and implementation extension file names, directory names, command names, type names, and string literals — since the old extensions are gone, the current ones are simply "the" planning extensions.

## Requirements

### Phase 1: Delete legacy files (7 files)
- Delete extensions/plan-feature.ts
- Delete extensions/tdd-plan.ts
- Delete docs/plan-feature-spec.md
- Delete __tests__/extensions/tdd-plan.test.ts
- Delete __tests__/extensions/tdd-plan-loop.test.ts
- Delete __tests__/extensions/plan-feature-spec.plan.test.ts
- Delete __tests__/extensions/currently-while-during-planning-there-is-a-active-planning-w.plan.test.ts (imports directly from plan-feature.ts; will not compile after deletion)

### Phase 2: Rename files and directories (drop v2 suffix)
- Rename `extensions/plan-v2.ts` → `extensions/plan.ts`
- Rename `extensions/planning-v2/` → `extensions/planning/`
- Rename `extensions/implement-v2/` → `extensions/implement/`
- Rename `extensions/implement-plan-loop-v2.ts` → `extensions/implement-plan-loop.ts`
- Rename `__tests__/extensions/plan-v2.test.ts` → `__tests__/extensions/plan.test.ts`
- Rename `__tests__/extensions/implement-plan-loop-v2.test.ts` → `__tests__/extensions/implement-plan-loop.test.ts`
- Rename `__tests__/extensions/planning-v2-question-ui.test.ts` → `__tests__/extensions/planning-question-ui.test.ts`

### Phase 3: Rename commands (in extensions/plan.ts)
- `/plan-v2` → `/plan`
- `/plan-save-v2` → `/plan-save`
- `/plan-answer-v2` → `/plan-answer`
- `/plan-status-v2` → `/plan-status`
- `/plan-tests-v2` → replaced with new `/plan-next` command (shows execution contract path via `state.savedContractPath`; warns user to run `/plan-save` first if no contract saved)
- `/end-planning-v2` → `/end-planning`

### Phase 4: Rename commands (in extensions/implement-plan-loop.ts)
- `/implement-plan-loop-v2` → `/implement-plan-loop`
- `/implement-plan-loop-v2-status` → `/implement-plan-loop-status`
- `/end-implement-plan-loop-v2` → `/end-implement-plan-loop`

### Phase 5: Rename internal code references (all files touched by Phase 2)
- Update all import paths from `./planning-v2/` → `./planning/` and `./implement-v2/` → `./implement/`
- Rename types: `PlanningV2State` → `PlanningState`, `PlanningV2Question` → `PlanningQuestion`, `PlanningV2QnAComponent` → `PlanningQnAComponent`, `ImplementPlanLoopV2Status` → `ImplementPlanLoopStatus`, `ImplementPlanLoopV2NextState` → `ImplementPlanLoopNextState`, `ImplementPlanLoopV2Iteration` → `ImplementPlanLoopIteration`, `ImplementPlanLoopV2State` → `ImplementPlanLoopState`
- Rename constants/variables: `PLANNING_V2_STATE_TYPE` → `PLANNING_STATE_TYPE` (value: `"planning-session"`), `IMPLEMENT_LOOP_V2_STATE_TYPE` → `IMPLEMENT_LOOP_STATE_TYPE` (value: `"implement-plan-loop-session"`), `planV2Extension` → `planExtension`, `implementPlanLoopV2Extension` → `implementPlanLoopExtension`
- Rename state keys: `ctx.state.planningV2` → `ctx.state.planning`, `ctx.state.implementPlanLoopV2` → `ctx.state.implementPlanLoop`
- Rename custom entry types: `"planning-v2-answers"` → `"planning-answers"`, `"planning-v2-session"` → `"planning-session"`, `"implement-plan-loop-v2-session"` → `"implement-plan-loop-session"`, `"implement-plan-loop-v2"` → `"implement-plan-loop"`, `"implement-plan-loop-v2-status"` → `"implement-plan-loop-status"`
- Rename artifact directory: `".pi/generated-implementation-v2"` → `".pi/generated-implementation"`
- Drop "v2" from all user-facing notification strings and descriptions (e.g., "Start a clean-slate v2 planning session" → "Start a planning session")

### Phase 6: Update test files
- Update imports in `__tests__/extensions/plan.test.ts` (formerly plan-v2.test.ts): import paths, expected command names (drop -v2)
- Update imports in `__tests__/extensions/implement-plan-loop.test.ts`: import paths, expected command names, artifact path assertions (drop v2)
- Update imports in `__tests__/extensions/planning-question-ui.test.ts`: import path from `planning-v2/` → `planning/`

### Phase 7: Update README.md
- Remove the extensions/plan-feature.ts section (lines 20-36), the extensions/tdd-plan.ts section (lines 37-42), and their repo layout entries (lines 66-68)
- Add brief sections describing the planning extensions (plan.ts, planning/, implement/, implement-plan-loop.ts) and update the repo layout listing — all without v2 suffix

### Constraints
- Do NOT modify package.json (uses directory glob `./extensions`, no per-file entries)
- Do NOT modify .pi/plans/ or .pi/generated-tdd/ historical artifacts

## Checks
- `grep -r 'plan-feature\|tdd-plan' extensions/ __tests__/ docs/ README.md` returns zero results
- `grep -rn '\-v2\|_v2\|V2\| v2' extensions/ __tests__/ README.md` returns zero results (confirms all v2 suffixes removed from source and tests)
- npm test (or equivalent) passes with remaining tests
- `/plan-next` command is registered in extensions/plan.ts and shows the execution contract path
- No remaining `/plan-tests-v2` or any `-v2` command registrations in any extension file
- All 7 legacy files no longer exist on disk
- All 7 file/directory renames completed

## Ambiguities
- The exact content for the new README sections (plan.ts, planning/, implement/, implement-plan-loop.ts descriptions and updated repo layout) is not specified — the implementer must draft appropriate descriptions based on the actual extension files.

## Evidence
- extensions/plan-feature.ts — Legacy extension to delete (1447 lines)
- extensions/tdd-plan.ts — Legacy extension to delete (2454 lines)
- docs/plan-feature-spec.md — Associated doc to delete (830 lines)
- __tests__/extensions/tdd-plan.test.ts — Dedicated test file to delete (376 lines)
- __tests__/extensions/tdd-plan-loop.test.ts — Dedicated test file to delete (504 lines)
- __tests__/extensions/plan-feature-spec.plan.test.ts — Dedicated test file to delete (935 lines)
- __tests__/extensions/currently-while-during-planning-there-is-a-active-planning-w.plan.test.ts — Test file importing __testables from plan-feature.ts — must be deleted
- extensions/plan-v2.ts — To be renamed to plan.ts; contains commands and internal references to rename
- extensions/planning-v2/ — Directory to rename to planning/; contains types and components to rename
- extensions/implement-v2/ — Directory to rename to implement/; contains types and state to rename
- extensions/implement-plan-loop-v2.ts — To be renamed to implement-plan-loop.ts; contains commands to rename
- __tests__/extensions/plan-v2.test.ts — To be renamed to plan.test.ts; imports and assertions to update
- __tests__/extensions/implement-plan-loop-v2.test.ts — To be renamed to implement-plan-loop.test.ts; imports and assertions to update
- __tests__/extensions/planning-v2-question-ui.test.ts — To be renamed to planning-question-ui.test.ts; import path to update
- README.md — Contains documentation sections and repo layout entries for the legacy extensions — to be updated
- package.json — Confirmed safe — uses directory glob, no per-file references

## Out of scope
- Modifying package.json
- Modifying .pi/plans/ historical plan artifacts
- Modifying .pi/generated-tdd/ historical TDD loop artifacts
- Any functional changes to remaining extensions beyond renaming and the /plan-next addition
