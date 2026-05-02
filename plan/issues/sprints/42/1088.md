---
id: 1088
title: "test262: assertion location diagnostic misses verifyProperty/verifyEqualTo — 273 tests report 'found 0 asserts in source'"
status: done
created: 2026-04-12
updated: 2026-04-12
completed: 2026-04-14
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
goal: property-model
closed: 2026-04-12
pr: 143
---
# #1088 — Assertion location diagnostic misses `verifyProperty` / `verifyEqualTo`

## Implementation Summary

Extended the assertion-scanning regex in `tests/test262-shared.ts` and `tests/test262-vitest.test.ts` to also match `verify\w+` patterns (`verifyProperty`, `verifyEqualTo`, `verifyWritable`, etc.). The fix changes the diagnostic output from `assert #1 (found 0 asserts in source)` to the actual failing assertion line. Does not fix the underlying 273 failures (which need runtime property descriptor support), but makes failure messages actionable for triage. Delta=0, reg=0.
