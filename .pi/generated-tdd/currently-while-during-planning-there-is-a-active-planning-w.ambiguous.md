# Ambiguous requirements

Generated from: .pi/plans/currently-while-during-planning-there-is-a-active-planning-w.plan.md

- The plan does not name the specific function or API that renders the active-planning warning — tests accept any of several reasonable function names via dynamic lookup
- The plan does not specify whether the warning should use yellow OR red, or whether the user can configure this — tests accept either color
- The plan says 'encapsulate within yellow borders OR write in yellow or red' — tests require BOTH borders AND color since the user wants maximum visibility
- 'Review and update existing test file' is a scope item about test maintenance, not a behavioral feature — covered by grounding all tests in the real plan-feature.ts module from that file
- 'The feature behavior is documented in repo-grounded terms' and 'The plan cites affected modules' are meta-documentation criteria, not testable system behaviors
- 'Clarified decisions: (none)' is explicitly empty — nothing to test
