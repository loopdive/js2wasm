---
id: 85
title: "Issue 85: Variadic `Math.min` / `Math.max`"
status: done
created: 2026-03-08
updated: 2026-04-14
completed: 2026-03-08
goal: compilable
---
# Issue 85: Variadic `Math.min` / `Math.max`

## Summary

Support `Math.min(a, b, c, ...)` and `Math.max(a, b, c, ...)` with more than
2 arguments by chaining pairwise wasm `f64.min` / `f64.max` operations.

## Motivation

Currently `Math.min` and `Math.max` are listed as "Unsupported Math method"
in the codegen. Test262 has 10 tests for these methods; 4 fail with compile
errors due to missing support.

## Approach

For `Math.min(a, b, c)`:
1. Compile `a`
2. For each subsequent argument, compile it and emit `f64.min`
3. Result is on the stack

Edge cases per spec:
- `Math.min()` with no args → `Infinity`
- `Math.max()` with no args → `-Infinity`
- NaN propagation: if any arg is NaN, result is NaN (wasm `f64.min`/`f64.max` handle this)

## Test262 impact

Would fix 4 of the 10 Math.min/max compile errors (the ones that only fail
due to missing method support, not type coercion issues).

## Complexity

S — Straightforward extension of the existing Math method pattern.

## Dependencies

None.
