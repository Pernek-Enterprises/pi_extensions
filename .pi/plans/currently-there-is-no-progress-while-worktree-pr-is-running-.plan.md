# Plan: Currently there is no progress while /worktree-pr is running. I want visual progress similar to ~/.pi/agent/answer (When it says Extracting questions ...) while creating the PR so it is not ambiguous if it hangs or works.

## Requested feature
Add a visual progress spinner to the worktree PR creation workflow so users see real-time phase updates instead of no feedback while the operation runs.

## Requirements
- Create a ProgressLoader component in extensions/worktree.ts that animates through spinner frames ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ at 80ms intervals.
- ProgressLoader must expose a setMessage(msg) method that updates the displayed text and triggers a re-render.
- ProgressLoader must expose a handleInput(data) method that detects Esc (\u001b) or Ctrl+C (\x03) for cancellation.
- ProgressLoader must expose a stop() method that clears the animation interval to prevent leaks.
- ProgressLoader render(width) must return ['', '  <spinner> message'] format.
- ProgressLoader must use only the minimal tui interface already declared in the file — no external dependencies.
- Extract the core PR logic from handleWorktreePr into a new runPrWorkflow(ctx, progress?) function that calls progress?.setMessage(...) at each phase transition: validate → 'Validating worktree…', diff → 'Analyzing changes…', commit → 'Generating commit…', push → 'Pushing <branch>…', pr → 'Creating pull request…'.
- Existing info() calls in the PR workflow must be preserved for non-UI consumers.
- New handleWorktreePr wrapper: when ctx.hasUI && ctx.ui?.custom is available, wrap the workflow in ctx.ui.custom(), create a ProgressLoader, and run the workflow async while the spinner is visible. Properly stop the spinner on both success and error paths.
- When Esc or Ctrl+C is pressed during the progress spinner, throw an error to halt the PR operation.
- Without UI (ctx.hasUI is false or ctx.ui?.custom unavailable), handleWorktreePr calls runPrWorkflow(ctx) directly — identical to previous behavior.

## Checks
- ProgressLoader cycles through all 10 spinner frames (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) at approximately 80ms intervals.
- Calling setMessage updates the text shown next to the spinner on the next render.
- Pressing Esc or Ctrl+C during spinner triggers cancellation (throws error to halt operation).
- Calling stop() clears the interval — no further frame updates occur after stop.
- runPrWorkflow calls progress.setMessage with the correct message string at each of the 5 phase transitions.
- When ctx.hasUI is true and ctx.ui.custom is available, handleWorktreePr renders the ProgressLoader spinner during the workflow.
- The spinner is stopped on both successful completion and error paths (no interval leaks).
- When ctx.hasUI is false, handleWorktreePr runs the workflow without any spinner — behavior identical to pre-change.
- Existing info() logging calls remain in runPrWorkflow and are still invoked regardless of progress parameter presence.
- No new external dependencies are added — ProgressLoader uses only the tui interface already in extensions/worktree.ts.

## Evidence
- extensions/worktree.ts — The single file being modified: contains ProgressLoader component, runPrWorkflow extraction, and handleWorktreePr wrapper.

## Out of scope
- Changes to any files other than extensions/worktree.ts
- Adding external dependencies
- Modifying the tui interface definition
- Progress indicators for other worktree operations beyond PR creation
