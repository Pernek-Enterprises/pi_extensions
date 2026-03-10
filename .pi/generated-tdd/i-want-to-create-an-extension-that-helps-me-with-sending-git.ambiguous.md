# Ambiguous requirements

Generated from: .pi/plans/i-want-to-create-an-extension-that-helps-me-with-sending-git.plan.md

- Req 22: Utility functions (trimOutput, shQuote, detectRepoRoot, ensureGhAuthenticated) are inlined — cannot test isolation without knowing export structure; tested indirectly via behavior
- Req 24: 'runs from a pi session without dropping to shell' is architectural; tested indirectly by verifying commands use ctx.exec rather than child_process directly
- Req 23: Exact diff truncation threshold is unspecified; test only asserts output is shorter than raw diff
