---
id: 941
title: "Add equivalence tests for global isNaN() and isFinite() functions"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
reasoning_effort: medium
goal: npm-library-support
tags: [good-first-issue, testing]
files:
  tests/equivalence/:
    add:
      - "global-type-checks.test.ts — equivalence tests for isNaN, isFinite, typeof"
---
# #941 -- Add equivalence tests for global `isNaN()` and `isFinite()` functions

## Problem

The compiler inlines global `isNaN(x)` and `isFinite(x)` (see `src/codegen/expressions.ts` lines 11586-11615):
- `isNaN(x)` → `x !== x` (Wasm: `local.get x`, `local.get x`, `f64.ne`)
- `isFinite(x)` → `x - x === 0.0` (Wasm: `local.get x`, `local.get x`, `f64.sub`, `f64.const 0`, `f64.eq`)

These are different from `Number.isNaN` / `Number.isFinite` — the global versions coerce their argument to a number first. But for numeric inputs (the common case), the behavior is the same.

There are no equivalence tests verifying these inline implementations match JS.

## What to change

Create `tests/equivalence/global-type-checks.test.ts`:

```typescript
// isNaN(NaN) → true (1)
// isNaN(42) → false (0)
// isNaN(0) → false (0)
// isNaN(Infinity) → false (0)
// isFinite(42) → true (1)
// isFinite(Infinity) → false (0)
// isFinite(-Infinity) → false (0)
// isFinite(NaN) → false (0)
// isFinite(0) → true (1)
```

Each test should be a function that takes no arguments, calls the global function with a literal, and returns 1 (truthy) or 0 (falsy).

## Testing

```bash
npm test -- tests/equivalence/global-type-checks.test.ts
```

## Scope boundary

- Only test `isNaN` and `isFinite` with numeric arguments
- Do NOT test string coercion cases like `isNaN("hello")` (those need the host import path)
- Do NOT modify compiler source
- Follow the existing equivalence test pattern

## Acceptance criteria

- [ ] New file `tests/equivalence/global-type-checks.test.ts` exists
- [ ] At least 8 test cases
- [ ] All tests pass
- [ ] Tests follow existing equivalence test pattern
