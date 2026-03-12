Clean. No legacy files, no v2 suffixes in file/directory names. The `docs/` directory is now empty (only contained `plan-feature-spec.md` which was deleted).

## Implementation summary

**Changed files:**
- **Deleted (7 files — REQ-1 through REQ-7):** `extensions/plan-feature.ts`, `extensions/tdd-plan.ts`, `docs/plan-feature-spec.md`, `__tests__/extensions/tdd-plan.test.ts`, `__tests__/extensions/tdd-plan-loop.test.ts`, `__tests__/extensions/plan-feature-spec.plan.test.ts`, `__tests__/extensions/currently-while-during-planning-there-is-a-active-planning-w.plan.test.ts`
- **Renamed (REQ-8, REQ-9):** `extensions/plan-v2.ts` → `plan.ts`, `extensions/planning-v2/` → `planning/`, `extensions/implement-v2/` → `implement/`, `extensions/implement-plan-loop-v2.ts` → `implement-plan-loop.ts`, `__tests__/extensions/plan-v2.test.ts` → `plan.test.ts`, `__tests__/extensions/implement-plan-loop-v2.test.ts` → `implement-plan-loop.test.ts`, `__tests__/extensions/planning-v2-question-ui.test.ts` → `planning-question-ui.test.ts`
- **Updated source files (REQ-10, REQ-11, REQ-12):** All commands renamed (e.g., `/plan-v2` → `/plan`), types renamed (`PlanningV2State` → `PlanningState`, etc.), state keys renamed (`ctx.state.planningV2` → `ctx.state.planning`), constants renamed, custom entry types renamed, import paths updated, artifact dir changed to `.pi/generated-implementation`, `/plan-tests-v2` replaced with `/plan-next`, all v2 strings dropped from user-facing messages
- **Updated test files (REQ-13):** All import paths, command assertions, and artifact path assertions updated
- **Updated README.md (REQ-14):** Removed legacy extension sections, added new planning/implementation sections, updated repo layout

**Key contract IDs addressed:** REQ-1 through REQ-14, CHK-1 through CHK-7

**Remaining risks or caveats:**
- 22 pre-existing worktree test failures are unrelated to this change
- The `docs/` directory is now empty (could be removed if desired)
- Historical artifacts in `.pi/plans/` and `.pi/generated-tdd/` are intentionally preserved per REQ-16
