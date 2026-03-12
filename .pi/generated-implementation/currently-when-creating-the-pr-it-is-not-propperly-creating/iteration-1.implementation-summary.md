## Implementation summary

### Changed files

1. **`extensions/worktree.ts`** (line 695) — Replaced `shQuote` from `JSON.stringify(value)` to `'${value.replace(/'/g, "'\\''")}'` (POSIX single-quote escaping), matching the pattern in `inline-git-commands.ts`.

2. **`__tests__/extensions/currently-when-creating-a-pr-with-worktree-pr-the-pr-descrip.plan.test.ts`** — Rewrote `extractPrBody` to parse POSIX single-quoted strings (handling `'\''` escaping) instead of JSON-stringified strings. Removed the broken `.commands` property expectation from the extension shape test.

3. **`__tests__/extensions/worktree-pr.test.ts`** — Rewrote `extractPrBody` to parse POSIX single-quoted strings with `'\''` escaping, replacing the naive `[^']*` regex that wouldn't handle embedded single quotes.

### Contract IDs addressed

- **REQ-1** ✅ — `shQuote` now uses POSIX single-quote escaping
- **REQ-2** ✅ — Implementation matches `inline-git-commands.ts` pattern exactly
- **REQ-3** ✅ — Both test files' `extractPrBody` updated for single-quoted bodies; broken `.commands` expectation removed
- **REQ-4** ✅ — Drop-in replacement; all 17+ call sites use the same signature `shQuote(string): string`
- **CHK-1–CHK-4** ✅ — Verified: real newlines preserved, single quotes escaped, edge cases handled, plan tests pass (8/8)

### Remaining risks or caveats

- **`worktree-pr.test.ts`** has 7 pre-existing failures unrelated to this fix (the test accesses `(ext as any).commands` but the extension uses `registerCommand`). These failures existed before this change and are out of scope per the contract (AMB-1).
- **REQ-5** (optional AI prompt improvement) was not implemented — the existing prompt in `getGeneratedTexts` is functional and this is a secondary priority.
