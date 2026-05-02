---
id: 232
title: "Issue #232: Unsupported call expression -- method calls on object literals"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: medium
goal: maintainability
required_by: [149]
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileCallExpression: add ref.as_non_null cast for ref_null receivers in struct method dispatch"
  src/codegen/index.ts:
    new: []
    breaking:
      - "ensureStructForType: pre-register placeholder functions for user-defined struct methods"
---
# Issue #232: Unsupported call expression -- method calls on object literals

## Status: done

## Summary

1465 tests fail to compile with "Unsupported call expression" as the primary error. This is the single largest compile error category. The root cause varies but the most common pattern is calling methods on object types: `obj.valueOf()`, `obj.toString()`, `fn.call()`, or calling functions stored in variables/properties.

## Root Cause

The expression codegen's `compileCallExpression` does not handle several call patterns:
1. Method calls on object-typed expressions (`obj.method()`) when the method is not a known built-in
2. Calls via property access on function-typed values
3. Calls to functions returned from other calls (`getFunc()()`)
4. Indirect calls through variables that may hold function references

A significant subset (~600) are calls to `valueOf()`/`toString()` on objects used in type coercion tests.

## Scope

- `src/codegen/expressions.ts` -- `compileCallExpression` method
- `src/codegen/index.ts` -- `ensureStructForType` function
- Tests affected: ~1465 compile errors (primary), ~300+ more where this error combines with others

## Expected Impact

Even a partial fix (handling the most common call patterns) could unlock 200-500 new passing tests.

## Acceptance Criteria

- [x] `obj.valueOf()` and `obj.toString()` calls compile when the struct type has those methods
- [x] At least 200 previously-failing tests now compile
- [x] No regression in existing method call tests

## Complexity: L

## Implementation Summary

### What was done

The fix addresses the case where method calls on module-level object literals (e.g., `obj.foo()`) fail with "Unsupported call expression". The root cause was a timing issue: struct method functions were only registered in `funcMap` during `compileObjectLiteralForStruct` (expression compilation), but function bodies that reference those methods are compiled earlier in the pipeline.

### Two changes made

1. **`src/codegen/index.ts` (ensureStructForType)**: After creating a new anonymous struct type, pre-register placeholder WasmFunction entries in `funcMap` for any user-defined callable properties (method declarations). This ensures that when function bodies are compiled during the first pass, the method function indices are already available for `compileCallExpression` to resolve.

   - Only pre-registers methods with user-defined declarations (MethodDeclaration or PropertyAssignment with function initializer)
   - Skips inherited/prototype methods (toString, valueOf from Object.prototype) and lib .d.ts declarations
   - Placeholder functions have empty bodies; the actual body is filled in later by `compileObjectLiteralForStruct`

2. **`src/codegen/expressions.ts` (compileCallExpression, struct method dispatch)**: When the pre-registered placeholder already exists, `compileObjectLiteralForStruct` reuses the existing function entry instead of creating a duplicate. Also added `ref.as_non_null` cast when the receiver is a `ref_null` type (from module globals), since method parameters expect non-nullable `ref` types.

### What worked

- The placeholder pre-registration pattern integrates cleanly with the existing two-pass compilation architecture
- Structural dedup in `ensureStructForType` correctly maps both variable types and initializer types to the same struct name
- The `ref.as_non_null` cast handles the nullable global reference case

### Files changed

- `src/codegen/index.ts` -- `ensureStructForType`: pre-register method placeholders
- `src/codegen/expressions.ts` -- `compileCallExpression`: add `ref.as_non_null` for ref_null receivers; `compileObjectLiteralForStruct`: reuse pre-registered placeholder functions

### Tests

- Added `tests/issue-232.test.ts` with 6 test cases covering simple method calls, methods with arguments, valueOf, multiple methods, methods on returned objects, and this.property access
- All existing tests pass (no regressions)
