---
name: Create issue for every test262 skip
description: Every test262 skip filter must have a corresponding issue in plan/issues/
type: feedback
---

When adding a skip filter to test262-runner.ts, always create or update a corresponding issue in plan/issues/.

**Why:** Skip filters are workarounds, not fixes. Each one represents a compiler bug that needs tracking and eventually fixing.

**How to apply:** When a test hangs and you add a skip filter:
1. Add the skip pattern to test262-runner.ts
2. Create or update an issue (e.g. #408 for compiler hangs) with the test name, source pattern, and root cause
3. Reference the issue number in the skip filter comment
