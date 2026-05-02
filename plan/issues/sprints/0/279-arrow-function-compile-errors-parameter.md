---
id: 279
title: "Issue #279: Arrow function compile errors -- parameter and body patterns"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: medium
goal: core-semantics
files:
  src/codegen/expressions.ts:
    new:
      - "collectBindingPatternNames() — recursively collect identifier names from ObjectBindingPattern or ArrayBindingPattern"
      - "isOwnParamName() — check if a name belongs to an arrow function's own parameters including destructuring"
      - "emitArrowParamDestructuring() — emit Wasm instructions to destructure binding pattern parameters in arrow/closure bodies"
      - "emitArrowParamDefaults() — emit default-value initialization for simple arrow function parameters"
    breaking:
      - "compileArrowAsClosure: add calls to emitArrowParamDefaults and emitArrowParamDestructuring; use isOwnParamName for capture filtering"
      - "compileArrowAsCallback: add calls to emitArrowParamDefaults and emitArrowParamDestructuring; use isOwnParamName for capture filtering"
      - "compileClosureCall: support module-global closure refs via global.get + ref.as_non_null"
  src/codegen/statements.ts:
    new: []
    breaking:
      - "compileVariableStatement: arrow function initializers now also store to module global when applicable"
  src/codegen/index.ts:
    new: []
    breaking:
      - "compileFile: reordered init compilation before function body compilation so closureMap is populated for module-level arrow functions"
---
# Issue #279: Arrow function compile errors -- parameter and body patterns

## Status: done

## Summary
~93 tests fail with compile errors in arrow function contexts. These include arrow functions with destructuring parameters, default values in complex positions, or arrow functions used in contexts where the return type is ambiguous (void vs value).

## Category
Sprint 4 / Group A

## Complexity: M

## Scope
- Support arrow functions with destructuring parameters
- Handle arrow functions with complex default parameter expressions
- Fix return type inference for arrow functions in various contexts
- Update arrow function compilation in `src/codegen/expressions.ts`

## Acceptance criteria
- Arrow functions with destructuring params compile
- Arrow functions with complex defaults compile
- At least 30 compile errors resolved

## Implementation notes

### Changes made in `src/codegen/expressions.ts`

1. **`collectBindingPatternNames()`** - New helper that recursively collects all identifier names from an `ObjectBindingPattern` or `ArrayBindingPattern`. Used to properly identify which names belong to destructuring parameters.

2. **`isOwnParamName()`** - New helper that checks if a name belongs to any of an arrow function's own parameters, including names inside destructuring patterns. Replaces the previous check that only handled simple identifier parameters, which caused destructuring binding names to be incorrectly treated as captures from the outer scope.

3. **`emitArrowParamDestructuring()`** - New function that emits Wasm instructions to destructure a binding pattern parameter in an arrow/closure function body. Supports:
   - Object destructuring: resolves the struct type, finds fields by name, and emits `struct.get` instructions to extract each field into a local
   - Property renaming (`{ x: a }`)
   - Default values in destructuring bindings (`{ x = 5 }`) with proper null/NaN checks
   - Array destructuring: resolves vec struct type, extracts elements by index via `array.get`

4. **`emitArrowParamDefaults()`** - New function that emits default-value initialization for simple (non-destructuring) arrow function parameters with initializers. Mirrors the existing logic in `compileFunctionBody` (index.ts) but operates on the lifted function context.

5. **Updated `compileArrowAsClosure()`** - Added calls to `emitArrowParamDefaults` and `emitArrowParamDestructuring` after capture initialization and before body compilation. Also updated the `isOwnParam` check to use `isOwnParamName()`.

6. **Updated `compileArrowAsCallback()`** - Same additions: `isOwnParamName()` for capture filtering, `emitArrowParamDefaults` and `emitArrowParamDestructuring` before body compilation.

### Changes to support module-level arrow functions with defaults

7. **Updated `compileClosureCall()` in `expressions.ts`** - Added support for module-global closure variables. When the closure variable is not a local, falls back to `ctx.moduleGlobals.get()` and uses `global.get` + `ref.as_non_null` to load the closure struct ref.

8. **Updated `compileVariableStatement()` in `statements.ts`** - Arrow function initializers now also store to the module global (via `global.set`) when the variable has a pre-registered module global. Updates the global's type from `externref` to `ref_null $struct` and fixes the null initializer to match.

9. **Reordered init compilation in `index.ts`** - Module-level init statements (including `const f = arrow`) are now compiled BEFORE function body compilation. This ensures `ctx.closureMap` is populated when other functions (e.g. `test()`) reference module-level closure variables.

### Tests
11 tests in `tests/issue-279.test.ts` covering:
- Basic object destructuring in arrow params
- Object destructuring with rename
- Object destructuring with multiple fields
- Default parameter values in closures
- Simple module-level arrow with single default param
- Module-level arrow with multiple default params
- Arrow functions returning arithmetic (baseline)
- Arrow functions with block bodies (baseline)
- Arrow functions with captures AND destructuring
- Multiple destructured parameters

## Implementation Summary

### What was done
Fixed arrow function parameter compilation to support destructuring parameters (object and array) and default parameter values. Additionally fixed a critical bug where module-level arrow function closures could not be called from other functions because: (1) the closureMap was populated after function bodies were compiled, and (2) compileClosureCall did not support module-global closure variables.

### What worked
- Reordering init compilation before function body compilation cleanly solved the closureMap timing issue
- Adding global.get + ref.as_non_null in compileClosureCall handled the nullable ref type mismatch

### Files changed
- `src/codegen/expressions.ts` -- compileClosureCall: module global support
- `src/codegen/statements.ts` -- arrow init: store to module global
- `src/codegen/index.ts` -- reorder init before function bodies
- `tests/issue-279.test.ts` -- 2 new tests (11 total)
