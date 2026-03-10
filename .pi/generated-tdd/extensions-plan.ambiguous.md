# Ambiguous requirements

Generated from: .pi/plans/extensions.plan.md

- The exact ctx.ui.custom API shape and renderer callback contract are inferred from the /ss command pattern mentioned in the plan and existing test examples; actual implementation may differ.
- Whether the interactive selector returns an array of slugs, an array of paths, or a single string is not specified in the plan.
- Review and update __tests__/extensions/currently-it-is-not-possible-for-me-to-work-easily-on-the-sa.plan.test.ts – the plan says 'review and update' but does not specify what changes are expected.
- Review and update __tests__/extensions/tdd-plan.test.ts – same ambiguity as above.
- Review and update __tests__/extensions/plan-feature-spec.plan.test.ts – same ambiguity as above.
- Clarified decisions: (none) – no decisions were clarified, so no behavioral test can be written for this.
