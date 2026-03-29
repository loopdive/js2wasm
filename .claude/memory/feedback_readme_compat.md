---
name: feedback_readme_compat
description: Keep README ES Conformance section and skip filter reasons in sync
type: feedback
---

When adding or removing skip filters in tests/test262-runner.ts, also update:
1. README.md "ECMAScript Standard Features Not Yet Supported" table
2. README.md "ECMAScript Proposals" table
3. The skip reason string should match the README table format (e.g., "ES2015: ..." or "Stage 3: ...")

**Why:** User wants the README compatibility table to always reflect current skip filters. The skip reasons show in the test262 report.html, so they should be consistent with the README.

**How to apply:** After any change to shouldSkip() in test262-runner.ts, check if the README tables need updating.
