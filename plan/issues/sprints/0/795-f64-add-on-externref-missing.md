---
id: 795
title: "- f64.add on externref — missing unbox coercion (57 CE)"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: medium
feasibility: easy
goal: maintainability
test262_ce: 57
commit: ca936888
---
# #795 -- f64.add on externref — missing unbox coercion (57 CE)

## Problem

57 tests fail with "f64.add expected type f64, found externref" or similar. Arithmetic operations on values that are externref (boxed numbers from host) need unboxing before the operation.

## Fix approach

In binary expression compilation, when an operand is externref and the operation expects f64, call `coerceType(ctx, fctx, {kind: "externref"}, {kind: "f64"})` which uses `__unbox_number` to extract the f64 value.

## Files to modify

- `src/codegen/expressions.ts` — compileBinaryExpression arithmetic paths
- `src/codegen/type-coercion.ts` — verify externref→f64 coercion path exists
