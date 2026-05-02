---
id: 561
title: "Math.hypot closure captures ref instead of f64 (1 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-03-19
priority: medium
feasibility: medium
goal: compilable
test262_ce: 1
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "closure captured variable type — local.tee returns ref instead of f64"
---
# #561 — Math.hypot closure captures ref instead of f64 (1 CE)

## Status: review

`built-ins/Math/hypot/Math.hypot_ToNumberErr.js` fails because valueOf closures with void return types are not called during ref-to-f64 coercion. The coerceType eqref dispatch path only included closures returning f64/i32, skipping void-returning closures entirely. This meant valueOf side effects (counter++, throw) were never executed.

### Fix
In coerceType's eqref valueOf dispatch (expressions.ts ~line 820), broadened the closure filter from "must return f64 or i32" to "any zero-param closure". For void/null-returning closures, the call is emitted for side effects and `f64.const NaN` is pushed as the result (matching JS semantics: `Number(undefined) = NaN`).

## Complexity: S

## Implementation Summary

### What was done
- Changed the `callableClosureTypes` filter in coerceType's eqref valueOf dispatch to include ALL zero-param closures, not just those returning f64/i32
- Added post-call `f64.const NaN` for void/null-returning closures (matching JS ToNumber(undefined) = NaN semantics)
- This ensures valueOf side effects (assignments, throws) are properly executed when objects are coerced to numbers

### What worked
- The fix is minimal (changed filter condition + added NaN push for void returns)
- Math.hypot_ToNumberErr.js now passes: the throwing valueOf is called, exception propagates, counter stays 0

### Files changed
- `src/codegen/expressions.ts` - coerceType eqref valueOf dispatch

### Tests now passing
- `built-ins/Math/hypot/Math.hypot_ToNumberErr.js`
