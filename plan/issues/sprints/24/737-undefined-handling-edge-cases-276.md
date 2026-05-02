---
id: 737
title: "- Undefined-handling edge cases (276 tests)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: core-semantics
test262_fail: 276
files:
  src/codegen/expressions.ts:
    breaking:
      - "undefined propagation in comparison and coercion"
  src/codegen/type-coercion.ts:
    breaking:
      - "undefined handling in type coercion paths"
---
# #737 -- Undefined-handling edge cases (276 tests)

## Status: in-progress

## Problem

276 tests fail because `undefined` is not handled correctly in assertions. Common patterns:
- Missing function parameters should be `undefined` (not 0 or NaN)
- Property access on object without the key should return `undefined`
- `void` expression should return `undefined`
- Uninitialized `let`/`var` should be `undefined`
- `undefined` comparison with `===` fails

### What needs to happen

1. Audit undefined representation in the runtime (should be a distinct value, not NaN/0/null)
2. Ensure missing parameters, missing properties, and void all produce the same undefined sentinel
3. Fix `=== undefined` comparison to work with the sentinel

## Complexity: S (<150 lines)
