---
id: 121
title: "Issue 121: Function.prototype.call/apply"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: low
goal: standalone-mode
files:
  src/codegen/expressions.ts:
    new: []
    breaking: []
---
# Issue 121: Function.prototype.call/apply

## Summary

374 test262 tests use `.call()` or `.apply()` on function references, primarily
`Array.prototype.method.call(arrayLike, ...)`. Currently all skipped.

## Problem

In wasm, functions are not objects — they don't have `.call()` or `.apply()`
methods. The test262 Array tests heavily use this pattern to test Array methods
on non-array objects (array-likes with numeric keys and `.length`).

## Approach

For the compiler:
- `.call(thisArg, ...args)` is compiled as a direct call, dropping thisArg for standalone functions or using it as the receiver for class methods.
- `.apply(thisArg, argsArray)` spreads array literal elements into positional call args.
- This works for both standalone functions and class methods.

## Impact on Array tests

66-70 tests per Array method category use call/apply. These specifically test
Array methods on non-array objects, which is fundamentally incompatible with
our typed array implementation.

## Complexity

L — Partial support possible, full support requires function-as-object model.

## Implementation Summary

### What was done
- Added `.apply()` support for standalone functions (Case 1): when `fn.apply(thisArg, [args])` is called with an array literal, the array elements are spread as positional arguments to the function.
- Added `.apply()` fallback for standalone functions with no args array — calls the function with no arguments.
- Extended Case 2 (class method calls via `.call()`/`.apply()`) to also handle `.apply()`: `obj.method.apply(otherObj, [args])` now spreads the array literal elements as method arguments with `otherObj` as the receiver.
- Supported both closures and regular functions in all paths.

### What worked
- Array literal spreading is straightforward since the elements are known at compile time.
- Reusing the existing `.call()` infrastructure (thisArg drop, synthetic call, closure handling) kept the implementation clean.

### What didn't
- Runtime array spreading (non-literal arrays in `.apply()`) is not supported — would require dynamic array access at runtime.

### Files changed
- `src/codegen/expressions.ts` — added `.apply()` handling in `compileCallExpression` for both Case 1 (standalone functions) and Case 2 (class methods)

### Tests
- 12 new tests in `tests/issue-121.test.ts`: `.call()` verification (3), `.apply()` standalone (4), `.call()` on class methods (2), `.apply()` on class methods (1), compilation success (2)
