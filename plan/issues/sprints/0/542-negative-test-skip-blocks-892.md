---
id: 542
title: "Negative test skip blocks 892 tests"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: spec-completeness
---
# Issue #542: Negative test skip blocks 892 tests

892 test262 tests with `negative` metadata are being skipped unnecessarily.
These tests expect a parse/early/runtime error. Many should be attempted:
- If the compiler rejects the code (compile error), that's a pass
- If execution throws, that's a pass
- If execution succeeds without error, that's a fail

## Problem

Runtime negative tests (phase: runtime) go through `shouldSkip` which filters
them out for reasons like "uses eval", "uses with statement", etc. But since
these tests *expect* errors, we should try to compile and run them regardless.

Parse/early/resolution negative tests were already handled before `shouldSkip`,
but the `run-test262.ts` pre-filter was also incorrectly applying `shouldSkip`
to ALL negative tests.

## Fix

1. In `runTest262File`: bypass `shouldSkip` for runtime negative tests
2. In `run-test262.ts` pre-filter: bypass `shouldSkip` for ALL negative tests
