---
id: 956
title: "Emit i32.const directly instead of f64.const + i32.trunc_sat_f64_s (673 cases, 9% of modules)"
status: done
created: 2026-04-04
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
reasoning_effort: medium
goal: core-semantics
---
# #956 — Optimize f64 integer constants in i32 context

## Source

Discovered by `scripts/analyze-wat-patterns.ts` (#948) — corpus of 3,619 modules.

## Problem

9% of modules (318/3,619) contain 673 occurrences of `f64.const N` immediately followed by `i32.trunc_sat_f64_s`, where N is an integer value. This pattern appears in comparisons and loop bounds:

```wat
local.get 3          ;; i (i32 loop counter)
f64.const 10         ;; the loop bound — as f64!
i32.trunc_sat_f64_s  ;; convert to i32 for comparison
i32.lt_s
```

Instead of:
```wat
local.get 3
i32.const 10         ;; emit directly as i32
i32.lt_s
```

## Root Cause

In `src/codegen/expressions.ts` (or `statements.ts`), when emitting loop bounds and comparison operands, the compiler emits the literal as `f64.const` (the default numeric type), then coerces to i32. When the context demands i32 and the value is a known integer literal, we should emit `i32.const` directly.

## Fix

In `compileNumericLiteral` (or wherever numeric literals are emitted), check if:
1. The value is an integer (no fractional part)
2. The expected type in context is `i32`

If both conditions hold, emit `i32.const N` instead of `f64.const N`.

The key codegen sites:
- Loop bounds in `src/codegen/statements.ts` (for-loop condition)
- Comparison RHS in `src/codegen/binary-ops.ts` or `expressions.ts`

## Impact

- Each eliminated pair saves 1 instruction (~1-3 bytes)
- 673 cases × ~2 bytes = ~1.3KB across the corpus
- Also eliminates unnecessary f64→i32 runtime conversion

## Acceptance Criteria

- `scripts/analyze-wat-patterns.ts` reports `f64_const_to_i32.count` reduced from 673 to ~0
- All existing tests continue to pass
- Loop bounds and integer comparisons emit `i32.const` directly

## Sample Before/After

**Before:**
```wat
f64.const 10
i32.trunc_sat_f64_s
i32.lt_s
```

**After:**
```wat
i32.const 10
i32.lt_s
```
