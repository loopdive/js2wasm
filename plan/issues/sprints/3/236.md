---
id: 236
title: "Issue #236: allowJs type flexibility -- boolean/void/string as function arguments"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: compilable
---
# Issue #236: allowJs type flexibility -- boolean/void/string as function arguments

## Status: done

## Summary

731 tests fail to compile with TypeScript type errors when passing boolean, void, or string values as function arguments. Common errors include:
- "Argument of type 'boolean' is not assignable to parameter of type 'number'" (~252 errors)
- "Argument of type 'void' is not assignable to parameter of type 'number'" (~241 errors)
- "Argument of type 'string' is not assignable to parameter of type 'number'" (~238 errors)

These are valid JavaScript patterns that TypeScript rejects in strict mode.

## Root Cause

The test262 tests are JavaScript files compiled with `allowJs: true`. TypeScript's type checker still reports errors for type mismatches even in allowJs mode. The compiler does not suppress or coerce these argument types, causing compilation failure.

Sprint 2 started addressing this with #145 (allowJs type flexibility) but many patterns remain.

## Scope

- `src/codegen/expressions.ts` -- argument coercion in call expressions
- `src/codegen/index.ts` -- TypeScript diagnostic filtering for allowJs
- Tests affected: ~731 compile errors

## Expected Impact

Fixing type coercion for function arguments would resolve ~400-500 compile errors (the ones where this is the sole error).

## Suggested Approach

1. In allowJs mode, suppress TypeScript diagnostics for argument type mismatches (TS2345)
2. In the codegen, when an argument type does not match the parameter type, insert coercion:
   - boolean -> number: `i32` already, just reinterpret (or `select 1 0`)
   - void -> number: emit `f64.const NaN` or `f64.const 0` depending on context
   - string -> number: call `parseFloat` or `Number()` coercion
3. This is a broad fix that helps many different test categories

## Acceptance Criteria

- [ ] Boolean arguments accepted where number is expected (with coercion)
- [ ] Void arguments produce NaN where number is expected
- [ ] String arguments coerced to number where applicable
- [ ] At least 200 compile errors resolved
- [ ] No regression in existing typed function calls

## Implementation Notes

TS diagnostic code 2345 ("Argument of type 'X' is not assignable to parameter of type 'Y'") was already in the `DOWNGRADE_DIAG_CODES` set from a prior sprint. The compiler already downgrades this to a warning, allowing compilation to continue. The codegen handles type coercion at call sites when argument types don't match parameter types.

## Complexity: M
