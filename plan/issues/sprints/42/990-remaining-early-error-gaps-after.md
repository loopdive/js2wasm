---
id: 990
title: "Remaining early-error gaps after detectEarlyErrors(): reserved words, module grammar, using, ASI"
status: done
created: 2026-04-07
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
reasoning_effort: high
goal: core-semantics
required_by: [1020]
test262_fail: 327
closed: 2026-04-12
pr: 135
---
# #990 -- Remaining early-error gaps after detectEarlyErrors()

## Implementation Summary

Extended `src/compiler/validation.ts` to detect more ES early errors: reserved words used as identifiers, module-level syntax violations, `using` declarations outside legal contexts, and ASI-sensitive patterns. Added tests in `tests/issue-990.test.ts`.

First attempt introduced 175 regressions via an over-broad `isStrictMode` module-detect; reverted that specific change (sha=4db08bf9) while keeping the valid early-error detection. Final result: +26 delta, 0 regressions.
