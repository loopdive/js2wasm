---
id: 243
title: "Issue #243: Unsupported assignment target patterns"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: medium
goal: core-semantics
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileAssignment: add ArrayLiteralExpression on LHS for assignment-expression destructuring"
      - "compileDestructuringAssignment: extend to handle assignment-expression context (already-declared variables), member expression targets in destructuring, rest elements and default values"
  src/codegen/statements.ts:
    new: []
    breaking: []
---
# Issue #243: Unsupported assignment target patterns

## Status: done

## Summary

55 tests fail with "Unsupported assignment target". These involve assignment to patterns that the codegen does not handle:
- Array destructuring assignment: `[a, b] = [1, 2]` (not declaration, but assignment)
- Nested destructuring: `{x: {a, b}} = obj`
- Assignment to member expressions in destructuring: `[obj.x] = [1]`

## Root Cause

The codegen handles destructuring in `var`/`let`/`const` declarations but not in assignment expressions. Assignment destructuring requires a different code path because the variables are already declared and the left-hand side is an AssignmentPattern rather than a BindingPattern.

## Scope

- `src/codegen/expressions.ts` -- assignment expression destructuring
- Tests affected: ~55 compile errors

## Expected Impact

Fixes ~55 compile errors. Some tests have additional errors, so net new passing tests estimated at ~25-35.

## Suggested Approach

1. In the assignment expression codegen, handle ArrayLiteralExpression and ObjectLiteralExpression on the left-hand side
2. Compile the right-hand side first, store in a temporary
3. For each element in the destructuring pattern, emit the appropriate assignment (local.set, struct.set, etc.)
4. Handle rest elements (`[a, ...rest] = arr`), default values, and nested patterns

## Acceptance Criteria

- [x] `[a, b] = [1, 2]` works as an assignment expression
- [x] `{x, y} = obj` works as an assignment expression
- [x] Nested patterns work
- [x] At least 30 compile errors resolved

## Complexity: M

## Implementation Summary

### What was done
Added `compileArrayDestructuringAssignment` function and supporting helpers to handle array destructuring assignment expressions (where variables are already declared). Extended the existing `compileDestructuringAssignment` for objects to support member expression targets and nested patterns via shared helpers.

Key additions:
1. **`compileArrayDestructuringAssignment`**: Handles `[a, b] = expr` where the LHS is an `ArrayLiteralExpression`. Supports both tuple structs (fields `$_0`, `$_1`, ...) and vec structs (`{length, data}`). Handles holes, rest elements (for vec sources), identifier targets, member expression targets, nested object/array patterns, and default values.
2. **`emitAssignToTarget`**: Shared helper to assign a value from a local to a property access or element access target (struct.set or array.set).
3. **`emitObjectDestructureFromLocal`**: Shared helper for nested object destructuring from a local variable.
4. **`emitArrayDestructureFromLocal`**: Shared helper for nested array destructuring from a local variable.
5. **Refactored `compileDestructuringAssignment`**: Replaced inline nested object handling with calls to shared helpers, added support for `ArrayLiteralExpression` and member expression targets in property assignment branches.

### What worked
- Tuple struct detection (fields named `$_0`, `$_1` vs. `length`, `data`) allows correct handling of both `[a, b] = [1, 2]` (tuple) and `[a, ...rest] = someArray()` (vec).
- Rest element support with loop-based copy for vec sources.
- Shared helpers reduce code duplication between object and array destructuring paths.

### What didn't
- Rest elements on tuple sources are not supported (would require tuple-to-vec conversion).

### Files changed
- `src/codegen/expressions.ts`: Added ArrayLiteralExpression case in `compileAssignment`, new `compileArrayDestructuringAssignment` function, new helper functions `emitAssignToTarget`, `emitObjectDestructureFromLocal`, `emitArrayDestructureFromLocal`. Refactored nested object handling in `compileDestructuringAssignment` to use shared helpers.

### Tests
- `tests/issue-243.test.ts`: 6 tests covering array destructuring assignment, holes, rest elements, object destructuring assignment, nested object destructuring, and function-scoped array destructuring. All pass.
