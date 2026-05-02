---
id: 560
title: "BigInt + Number mixed arithmetic leaves stack dirty (2 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: crash-free
test262_ce: 2
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "BigInt + Number mixed arithmetic — emit TypeError or handle gracefully"
---
# #560 — BigInt + Number mixed arithmetic leaves stack dirty (2 CE)

## Status: open

2 tests fail with "expected 0 elements on the stack for fallthru, found 2":
- `language/expressions/addition/bigint-and-number.js`
- `language/expressions/subtraction/bigint-and-number.js`

These tests verify that `BigInt + Number` throws TypeError. The compiler currently tries to compile the expression but leaves values on the stack without consuming them.

### Fix
When one operand is BigInt (i64) and the other is Number (f64), emit a trap or throw rather than attempting arithmetic. In JS, `1n + 1` is a TypeError.

## Complexity: S
