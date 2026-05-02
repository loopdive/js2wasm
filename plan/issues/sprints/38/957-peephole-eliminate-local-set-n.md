---
id: 957
title: "Peephole: eliminate local.set N + drop dead-store pattern (272 cases, 5% of modules)"
status: done
created: 2026-04-04
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
reasoning_effort: medium
goal: performance
---
# #957 — Eliminate local.set + drop dead-store pattern

## Source

Discovered by `scripts/analyze-wat-patterns.ts` (#948) — corpus of 3,619 modules.

## Problem

5% of modules (173/3,619) have 272 occurrences of `local.set N` immediately followed by `drop`. This pattern arises from expression statements like `i++` where the "expression result" (old value of `i`) is pushed but never used:

```wat
local.get 3          ;; push old i (the "result" of i++ expression — never used)
local.get 3          ;; push i for computing i+1
i32.const 1
i32.add
local.set 3          ;; i = i+1
drop                 ;; drop old i — wasted push+drop pair
```

The optimized form just increments without the extra push:
```wat
local.get 3
i32.const 1
i32.add
local.set 3
```

## Root Cause

In `src/codegen/expressions.ts`, `compileUpdateExpression` (`i++`, `x++`) emits:
1. Push current value (as the expression's "result")
2. Compute and store new value

When the parent expression is a statement (`ExpressionStatement`), the "result" is immediately discarded. The existing dead-load peephole from #947 may not cover this case since it's a `local.set + drop` pattern, not a `local.get + drop` pattern.

## Fix

### Option A: Peephole (simplest)
In `src/codegen/peephole.ts`, add rule: if we see `... local.set N + drop`, the `drop` is removing a value pushed before the `local.set`. We can replace the surrounding sequence.

Actually, the pattern to eliminate is: when the stack value that will be `drop`ped is a `local.get N` pushed purely for the expression result. Look for:
```
local.get N      ← push for result
local.get N      ← push for computation (or alternative computation)
... arithmetic
local.set N
drop             ← remove both this AND the first local.get N
```

### Option B: Codegen (better)
In `compileUpdateExpression`, check if result is needed. If `isExpressionStatement`, emit only the increment without pushing the old value.

The `VOID_RESULT` sentinel is used for this: when context says `void result`, skip the initial `local.get` for the result value.

## Impact

272 cases × 2 eliminated instructions (local.get + drop) = 544 fewer instructions across the corpus.

## Acceptance Criteria

- `scripts/analyze-wat-patterns.ts` reports `dead_drops.count` near 0
- All equivalence tests pass
- `for (let i = 0; i < N; i++)` loops emit no superfluous local.get+drop

## Sample

**Before:**
```wat
local.get 3      ;; old i (unused result)
local.get 3      ;; i for increment
i32.const 1
i32.add
local.set 3
drop             ;; drop old i
```

**After:**
```wat
local.get 3
i32.const 1
i32.add
local.set 3
```
