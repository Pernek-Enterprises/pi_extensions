# Plan: Fix PR Description in `/worktree-pr`

## Problem

When `/worktree-pr` creates a GitHub PR, the description body contains **literal `\n` characters** instead of actual newlines, producing an unreadable wall of text (visible in screenshot). The markdown formatting (headings, bullets, paragraphs) is completely lost.

## Root Cause

**`shQuote` in `extensions/worktree.ts` (line 695-696) uses `JSON.stringify()`:**

```typescript
function shQuote(value: string): string {
    return JSON.stringify(value);
}
```

`JSON.stringify("line1\nline2")` produces `"line1\nline2"` — a double-quoted string with the two-character escape `\n`. In bash, **double-quoted strings do NOT interpret `\n` as a newline**. Only `$`, `` ` ``, `\`, `!`, and `"` are special inside double-quotes. So `gh pr create --body "## Summary\n\nChanges..."` passes literal `\n` to the `gh` CLI, which then posts them verbatim to GitHub.

### Evidence

| Evidence | Location |
|----------|----------|
| `shQuote = JSON.stringify` | `extensions/worktree.ts:695-696` |
| Used for PR body | `extensions/worktree.ts:836`: `--body ${shQuote(generatedTexts.prBody)}` |
| Correct implementation exists in same repo | `extensions/inline-git-commands.ts:29`: `return \`'\${s.replace(/'/g, "'\\\\''")}'\`` |
| Shell demo confirms the issue | `echo "line1\nline2"` → outputs literal `line1\nline2` |
| Screenshot shows literal `\n` in PR body | User-provided screenshot |

## Decisions

| Question | Answer | Rationale |
|----------|--------|-----------|
| `--body-file` vs fixing `shQuote`? | **Both.** Fix `shQuote` for global correctness + use `--body-file` for the PR body. | `--body-file` is the most stable approach for multi-line markdown — zero shell escaping risk. Fixing `shQuote` is additionally correct for all other call sites (commit messages, etc.). |
| Two overlapping test files? | **Leave both as-is**, update each as needed. | User preference. Both files stay; each gets minimal updates to work with the new code. |

## Fix Strategy

### Change 1: Fix `shQuote` for global correctness

Replace `JSON.stringify` with proper POSIX single-quote escaping to match `inline-git-commands.ts`:

```typescript
// BEFORE (worktree.ts:695-696)
function shQuote(value: string): string {
    return JSON.stringify(value);
}

// AFTER
function shQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
```

Single-quoted strings in bash pass everything through literally (newlines, `$`, backticks, etc.) — the only character that needs escaping is `'` itself, handled by the `'\''` idiom.

**Blast radius:** `shQuote` is used in ~17 places in `worktree.ts`. All usages (branch names, commit messages, paths) benefit from this fix. None rely on the JSON-escaping behavior.

### Change 2: Use `--body-file` for PR body (belt-and-suspenders)

Even with a fixed `shQuote`, PR bodies can contain single quotes, which makes `--body-file` the most robust path for arbitrarily complex markdown.

**In `handleWorktreePr` (around line 830-837):**

```typescript
// BEFORE:
`gh pr create --base main --head ${shQuote(branch)} --title ${shQuote(generatedTexts.prTitle)} --body ${shQuote(generatedTexts.prBody)}`

// AFTER:
// 1. Write body to temp file
const bodyFile = path.join(os.tmpdir(), `pi-pr-body-${metadata.slug}-${Date.now()}.md`);
await fs.writeFile(bodyFile, generatedTexts.prBody, "utf8");
try {
    const prResult = await runInCwd(ctx, cwd,
        `gh pr create --base main --head ${shQuote(branch)} --title ${shQuote(generatedTexts.prTitle)} --body-file ${shQuote(bodyFile)}`
    );
    // ... use prResult
} finally {
    await fs.unlink(bodyFile).catch(() => {});
}
```

**Requires:** Add `import os from "node:os";` at top of file (or use `import { tmpdir } from "node:os"`). `fs` and `path` are already imported.

### Change 3: Update tests to handle `--body-file`

Both test files need their body-extraction logic updated:

**`__tests__/extensions/worktree-pr.test.ts`:**
- `extractPrBody` currently looks for `--body '...'` / `--body "..."` inline. Needs to also match `--body-file <path>` and read the file content from the test filesystem.
- Tests using `getPrHandler` / `findPrCommandName` that access `.commands` — these already fail. Update to use a `getRegisteredCommands` pattern (the other test file already has this).

**`__tests__/extensions/currently-when-...plan.test.ts`:**
- `extractPrBody` needs the same `--body-file` support.
- The test that expects `.commands` property (line ~211) needs removal — the extension uses `registerCommand()`, not a `.commands` export.
- The `makePrCtx` exec mock needs to handle the `--body-file` path — when it sees `gh pr create --body-file <path>`, read the temp file content for verification.

**Approach for test body extraction with `--body-file`:**

```typescript
function extractPrBody(command: string): string {
    // Handle --body-file <path>
    const bodyFileMatch = command.match(/--body-file\s+'([^']*(?:'\\''[^']*)*)'/s);
    if (bodyFileMatch) {
        const filePath = bodyFileMatch[1];
        try { return readFileSync(filePath, "utf8"); } catch { return ""; }
    }

    // Existing --body patterns...
    const singleQuoteMatch = command.match(/--body\s+'([^']*(?:'\\''[^']*)*)'/s);
    if (singleQuoteMatch) return singleQuoteMatch[1].replace(/'\\'''/g, "'");

    return "";
}
```

Since the temp file is written to `os.tmpdir()` with `fs.writeFile` (real filesystem, not mocked), the test's `extractPrBody` can simply `readFileSync` the path. The file exists briefly during the test execution before the `finally` block deletes it — but the `gh pr create` mock runs synchronously within the same `await`, so the file is still present when the mock captures the command.

**Actually, cleaner approach:** Intercept the file write in tests. The `handleWorktreePr` uses `fs.writeFile` directly (not `ctx.persistArtifact`), so we either:
- Let it write to real tmpdir and read it back in `extractPrBody` — simplest, works because mock exec runs before cleanup
- OR: mock `fs.writeFile` — complex, not worth it

**Recommended: Let the real write happen.** The mock `exec` for `gh pr create` fires before the `finally` cleanup, so `readFileSync` in `extractPrBody` will succeed.

## Affected Files

| File | Change |
|------|--------|
| `extensions/worktree.ts` | Fix `shQuote` + use `--body-file` for PR creation + add `os` import |
| `__tests__/extensions/worktree-pr.test.ts` | Update `extractPrBody` for `--body-file`, fix `getPrHandler` to use `getRegisteredCommands` |
| `__tests__/extensions/currently-when-...plan.test.ts` | Update `extractPrBody` for `--body-file`, remove `.commands` expectation |

## Implementation Sequence

1. Fix `shQuote` in `extensions/worktree.ts` — POSIX single-quoting
2. Add `os` import, refactor `handleWorktreePr` to use `--body-file` with temp file + cleanup
3. Update `extractPrBody` in both test files to handle `--body-file`
4. Fix test infrastructure in `worktree-pr.test.ts` (use `getRegisteredCommands` pattern)
5. Remove `.commands` expectation from plan test
6. Run all tests, verify passing

## Verification Checklist

- [ ] `shQuote("line1\nline2")` produces `'line1\nline2'` with real newline preserved
- [ ] `gh pr create` command uses `--body-file` not `--body`
- [ ] Temp file is cleaned up in `finally` block
- [ ] All tests in `worktree-pr.test.ts` pass
- [ ] All tests in `currently-when-...plan.test.ts` pass
- [ ] PR body extracted in tests contains actual newlines, not `\n` literals
- [ ] Empty diff case still works gracefully
