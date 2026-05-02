---
id: 565
title: "returned 0: wrong return value (4,259 FAIL)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
goal: core-semantics
test262_fail: 651
files:
  src/codegen/expressions.ts:
    new: []
    breaking: []
  src/codegen/statements.ts:
    new: []
    breaking: []
---
# #565 — returned 0: wrong return value (4,259 FAIL)

## Status: open

651 tests compile and run but return 0 instead of the expected value (down from 4,259). Now **100% concentrated in `language/statements/class`** — all 651 are class statement tests.

This is no longer an umbrella issue — it has a single root cause in class statement compilation.

## Complexity: L
