# Plan: Currently when creating the PR it is not propperly creating a good description text when using /worktree-pr (see screenshot). Instead it should create a good description of the change based on the changes in the pr.

## Requested feature
Fix PR description creation so that newlines are preserved correctly when passed to `gh pr create --body`, by replacing the broken `shQuote` implementation (which uses JSON.stringify and produces literal \n) with POSIX single-quote escaping.

## Requirements
- Replace the `shQuote` function in `extensions/worktree.ts` (around line 695-696) so it uses POSIX single-quote escaping (`'...'` with embedded single quotes escaped as `'\''`) instead of `JSON.stringify()`. This ensures real newlines and special characters are preserved correctly in shell arguments.
- The new `shQuote` implementation should follow the same POSIX single-quoting pattern already used in `inline-git-commands.ts` in this repo.
- Update the `extractPrBody` test(s) to handle single-quoted bodies instead of JSON-stringified bodies, and remove the broken `.commands` expectation.
- All existing call sites of `shQuote` (17+ usages) must continue to work correctly with the new implementation — the fix must be a drop-in replacement.
- (Optional) Improve the AI prompt structure in `getGeneratedTexts` in `extensions/worktree.ts` for better PR description quality.

## Checks
- Verify that `shQuote` applied to a string containing real newlines (e.g., `'line1\nline2'`) produces a shell-safe quoted string that, when evaluated by bash, preserves the actual newline characters.
- Verify that `shQuote` correctly handles strings containing single quotes by escaping them as `'\''`.
- Verify that `shQuote` handles edge cases: empty strings, strings with only special characters, strings with backslashes, strings with double quotes.
- Verify that `extractPrBody` tests pass after being updated to expect single-quoted output format.
- Run the full test suite (`npm test` or equivalent) to confirm no regressions across all 17+ `shQuote` call sites.

## Ambiguities
- Two overlapping test files exist for PR creation. The plan suggests the plan-generated one (`currently-when-...`) has better infrastructure but does not definitively resolve which should be canonical or whether both should be updated.
- Should `--body-file` be used as a fallback mechanism if edge cases appear with the `shQuote` fix, or is the `shQuote` fix considered fully sufficient?

## Evidence
- extensions/worktree.ts — Contains the broken `shQuote` function (line ~695) and `getGeneratedTexts` — the primary files to modify.
- extensions/inline-git-commands.ts — Contains the correct POSIX single-quote escaping implementation to use as a reference pattern.
- __tests__/ — Contains test files including `extractPrBody` tests that need updating.

## Out of scope
- Switching to `--body-file` approach (only a fallback if shQuote fix proves insufficient)
- Refactoring or consolidating the two overlapping test files beyond what is needed for this fix
- Changes to GitHub API interaction beyond shell argument quoting
