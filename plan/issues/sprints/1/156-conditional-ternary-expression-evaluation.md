---
id: 156
title: "Conditional (ternary) expression evaluation"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: core-semantics
files:
  src/codegen/expressions.ts:
    new: []
    breaking: []
---
# #156 — Conditional (ternary) expression evaluation

## Problem
Ternary may not correctly handle all value types in branches, or truthiness check is wrong.

## Investigation
Ran all test262 conditional expression tests (`S11.12_*`). Result: 2/2 compilable tests pass (100%). The remaining tests are compile errors (due to `new Object()` or undeclared variables) or skipped (due to unsupported features). No actual failures found in ternary codegen.

The existing `compileConditionalExpression` already correctly:
- Determines a common result type for both branches
- Coerces branches to the common type when they differ
- Handles ref type narrowing (ref -> ref_null)

## Status: done (no fix needed)
