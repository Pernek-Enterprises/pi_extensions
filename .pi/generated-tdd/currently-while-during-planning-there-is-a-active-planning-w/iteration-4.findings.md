Verdict: needs attention
Summary: The tests fabricate an API that almost certainly does not exist in plan-feature.ts. The dynamic lookup of candidate function names (formatPlanningWarning, formatPlanningBanner, etc.) is speculative and will fail at runtime since the plan itself acknowledges no such function exists yet. The plan's scope is only to 'Review and update' an existing test file, not to test a new formatting function. The tests also assume a specific call signature (state object with active/title) that is entirely invented.

Findings:
- 1. Tests depend on a formatting function that does not exist in the codebase (non-executable-or-unrealistic/high)
- 2. Plan is too ambiguous to derive concrete behavioral tests (ambiguity/high)
- 3. Invented call signature: format({ active, title }) has no basis (non-executable-or-unrealistic/medium)
- 4. Missing major behavioral requirement (missing-major-plan-coverage/medium)
- 5. Missing major behavioral requirement (missing-major-plan-coverage/medium)
- 6. Missing major behavioral requirement (missing-major-plan-coverage/medium)
- 7. Missing major behavioral requirement (missing-major-plan-coverage/medium)

Strengths:
- The out-of-scope guard test for existing APIs (getPlanningState, applyPlanningState, clearPlanningState) is a valid and useful regression test.
- Good documentation of ambiguities in the file header comments.
- Edge cases are thoughtfully enumerated (inactive state, empty title, undefined fields).
- The test file correctly imports from the real module path.

Fix queue:
- 1. Do not write behavioral tests for a function that doesn't exist and whose shape is not specified in the plan. Either (a) acknowledge the ambiguity finding and return verdict=fail at the plan level, or (b) write tests only for what is concretely specified: verify that the existing __testables API (getPlanningState, applyPlanningState, clearPlanningState) is preserved, and add a descriptive pending/skip test documenting what the warning formatting tests should cover once the API is defined.
- 2. Report the plan as insufficiently specified for TDD. The generated test file should contain at most the existing-API guard test and clearly marked TODO/skip tests documenting the requirements that need clarification before tests can be written. Do not invent function signatures.
- 3. Remove all tests that depend on this invented signature. If tests must be written speculatively, explicitly mark them as pending/skipped with a note about the assumed contract.
- 4. Add an explicit behavioral test for this requirement or explain why it cannot be tested realistically.
- 5. Add an explicit behavioral test for this requirement or explain why it cannot be tested realistically.
- 6. Add an explicit behavioral test for this requirement or explain why it cannot be tested realistically.
- 7. Add an explicit behavioral test for this requirement or explain why it cannot be tested realistically.
