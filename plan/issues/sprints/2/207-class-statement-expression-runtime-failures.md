---
id: 207
title: "Issue #207: Class statement/expression runtime failures"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: standalone-mode
---
# Issue #207: Class statement/expression runtime failures

## Status: review

## Problem
Class expression and declaration edge cases fail in test262.
`typeof A === "function"` where A is a class returns false instead of true.

## Root Cause
The `typeof` static resolution only checked `getCallSignatures()` to determine if a type is a function.
Classes have construct signatures but not call signatures, so they were classified as "object" instead of "function".

## Fix
Added `getConstructSignatures()` check alongside `getCallSignatures()` in both:
- `compileTypeofExpression` (typeof as standalone expression)
- `compileTypeofComparison` (typeof in equality comparison)

## Files Changed
- `src/codegen/expressions.ts` -- typeof construct signature check in two locations
- `tests/equivalence.test.ts` -- 2 new class typeof tests
