# Plan: Add Visual Progress to `/worktree-pr`

## Problem

When `/worktree-pr` runs, there is no persistent visual feedback. The user sees nothing during async work (AI commit message generation, `git push`, `gh pr create`) and can't tell if the command is working or hung.

The existing `info(ctx, ...)` calls fire one-shot notifications via `ctx.ui?.notify?.(message)` and `ctx.pi?.notify?.(message)`, which flash briefly and provide no persistent progress indicator.

## Reference: How `~/.pi/agent/extensions/answer.ts` Does It

`answer.ts` shows a bordered spinner during AI extraction:

```ts
const result = await ctx.ui.custom<Result | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Extracting questions...`);
    loader.onAbort = () => done(null);

    doAsyncWork().then(done).catch(() => done(null));
    return loader;    // Component renders a spinner until done() is called
});
```

This blocks the UI, shows an animated spinner with a message, and is cancellable via Esc.

## Key Difference: Multi-Phase Progress

`answer.ts` has a **single** async operation with one static message. `/worktree-pr` has **five sequential phases** where the message should update:

| Phase     | Message                              |
|-----------|--------------------------------------|
| validate  | `Validating worktree…`               |
| diff      | `Analyzing changes…`                 |
| commit    | `Generating commit…`                 |
| push      | `Pushing <branch>…`                  |
| pr        | `Creating pull request…`             |

The `Loader` component from `pi-tui` has a `setMessage(msg)` method, but `BorderedLoader` wraps it as a private field — no `setMessage` is exposed. So we need either a custom component or direct `Loader` usage.

## Design

### Approach: Self-Contained `ProgressLoader` Component

Build a lightweight progress component inside `worktree.ts` that:
- Renders an animated spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) + current message
- Has `setMessage(msg: string)` to update the message as phases change
- Handles Esc/Ctrl+C for cancellation via an `AbortController`
- Calls `tui.requestRender?.()` on each animation frame

This matches the minimal `tui` interface already declared in `worktree.ts`:
```ts
tui: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void }
```

No external dependencies needed beyond the `matchesKey`/`Key` that already exist in `lib/pi-tui-compat.ts`.

### Integration into `handleWorktreePr`

Wrap the multi-phase flow in `ctx.ui.custom` when UI is available:

```ts
async function handleWorktreePr(ctx: Ctx): Promise<WorktreeMetadata> {
    if (ctx.hasUI && ctx.ui?.custom) {
        return await ctx.ui.custom<WorktreeMetadata>((tui, _theme, _kb, done) => {
            const progress = new ProgressLoader(tui, "Validating worktree…");
            
            runPrFlow(ctx, progress)
                .then(done)
                .catch((err) => { progress.stop(); done(err); /* re-wrapped below */ });
            
            return progress;
        });
    }
    // Non-UI fallback: existing info() notification path
    return await runPrFlow(ctx);
}
```

The actual PR logic is extracted into `runPrFlow(ctx, progress?)` which calls `progress?.setMessage(...)` between phases. The existing `info()` calls remain for non-UI contexts (tests, RPC mode).

### Fallback Path (No UI)

When `ctx.hasUI` is false (tests, non-interactive mode), the flow runs exactly as today — `info()` calls produce `ctx.pi?.notify?()` notifications. No behavioral change for non-UI consumers.

## Evidence

| Item | File | Observation |
|------|------|-------------|
| Current notifications are one-shot | `worktree.ts:63` | `info()` calls `ctx.ui?.notify?.(message, "info")` — ephemeral |
| `ctx.ui.custom` is available | `worktree.ts:10` | `UiContext.custom` type already declared, used elsewhere (line 486, 1016) |
| `tui` type is minimal | `worktree.ts:10` | Only `{ stop?, start?, requestRender? }` — no `Theme` or full `TUI` |
| `Loader.setMessage` exists in pi-tui | `pi-tui/dist/components/loader.js:36` | `setMessage(message)` updates text + triggers render |
| `BorderedLoader` does NOT expose `setMessage` | `pi-coding-agent/dist/.../bordered-loader.js` | Inner `loader` is private |
| `pi-tui-compat.ts` provides `matchesKey`/`Key` | `extensions/lib/pi-tui-compat.ts` | Already used in the codebase for input handling |
| PR phases are: validate → commit → push → pr | `worktree.ts:787-842` | `phase` variable tracks current phase |
| `answer.ts` reference uses `BorderedLoader` inside `ctx.ui.custom` | `~/.pi/agent/extensions/answer.ts:456` | Pattern: create component, run async, call `done()` |

## File Changes

### `extensions/worktree.ts`

1. **Add `ProgressLoader` class** (~40 lines) near the top of the file, after the existing helper functions:
   - Constructor: `(tui, message)` — starts animation interval
   - `setMessage(msg)` — updates displayed message
   - `render(width)` — returns `["", "  ⠋ message"]` (spinner + message, 1-line top padding)
   - `handleInput(data)` — detects Esc/Ctrl+C, calls `onAbort`
   - `stop()` — clears the interval
   - `invalidate()` — no-op (for Component interface)
   - `onAbort?: () => void` — cancellation callback
   - Uses `matchesKey`/`Key` from `lib/pi-tui-compat.ts`

2. **Refactor `handleWorktreePr`**:
   - Extract the core logic into a private `runPrWorkflow(ctx, progress?)` function
   - The existing `handleWorktreePr` becomes a thin wrapper:
     - If `ctx.hasUI && ctx.ui?.custom`: wrap in `ctx.ui.custom`, create `ProgressLoader`, pass to `runPrWorkflow`
     - Otherwise: call `runPrWorkflow(ctx)` directly (existing behavior)
   - Inside `runPrWorkflow`, add `progress?.setMessage(...)` calls at each phase transition
   - Keep existing `info()` calls so non-UI consumers still get notifications

3. **Import `matchesKey` and `Key`** from `./lib/pi-tui-compat.ts` (add to existing imports if not already there).

### `__tests__/extensions/worktree-pr.test.ts`

**Note:** The existing tests are broken — they try to access `worktreeExtension.commands` but the extension registers commands via `pi.registerCommand()`. The `getPrHandler` function returns `undefined` and all tests fail with "Expected a PR-related command among: ". This is a pre-existing bug unrelated to this feature.

For this change:
- Add a test that verifies `progress?.setMessage` is called with phase-appropriate messages during `handleWorktreePr` when `ctx.hasUI = true` and `ctx.ui.custom` is provided
- The test mocks `ctx.ui.custom` to capture the component, then verifies the component's `render()` output contains expected messages
- Add a test that verifies the non-UI path (no `ctx.hasUI`) still works identically (regression guard)

## Behavior Specification

| Scenario | Expected |
|----------|----------|
| `/worktree-pr` with UI | Spinner shows "Validating worktree…" → "Analyzing changes…" → "Generating commit…" → "Pushing branch…" → "Creating pull request…" → spinner dismisses, final `info()` notification says "PR ready: <url>" |
| `/worktree-pr` without UI | Identical to current behavior — `info()` notifications only |
| User presses Esc/Ctrl+C during progress | Spinner dismisses, operation is cancelled (error thrown) |
| Error during any phase | Spinner dismisses, error is reported via existing `fail()`/`recordFailure()` path |
| Clean working tree (no changes to commit) | Skip "Generating commit…" message, go straight to "Pushing branch…" |

## Checks

- [ ] All existing tests pass (once test mock is fixed to use `pi.registerCommand()` capture pattern)
- [ ] New progress tests verify message updates per phase
- [ ] Non-UI path remains unchanged (regression test)
- [ ] Spinner animation doesn't leak intervals (`.stop()` called on success AND error paths)
- [ ] Cancellation via Esc works and produces a clean error
- [ ] The `ProgressLoader` component works with the minimal `tui` type (no `Theme` dependency)

## Open Questions

1. **Fix existing broken tests?** The test file's `getPrHandler` pattern doesn't work with the current extension registration model. Should we fix this as part of this PR, or leave it as a separate concern? *Recommendation:* Fix it — the test file needs a mock `PiApi` that captures `registerCommand` calls. This is a small change and makes the progress tests actually runnable.

2. **Cancel semantics:** Should Esc/Ctrl+C during progress cancel the entire `/worktree-pr` operation mid-flight (e.g., after `git push` but before `gh pr create`)? The pushed branch would remain. *Recommendation:* Yes, cancel and let the user re-run. The push is idempotent, and `gh pr create` will find the existing push. Warn the user that partial progress may exist.
