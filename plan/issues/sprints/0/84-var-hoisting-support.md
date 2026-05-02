---
id: 84
title: "Issue 84: `var` hoisting support"
status: done
created: 2026-03-08
updated: 2026-04-14
completed: 2026-03-08
goal: core-semantics
---
# Issue 84: `var` hoisting support

## Summary

Support JavaScript/TypeScript `var` declarations with proper function-scoped
hoisting semantics. Variables declared with `var` inside blocks (if, for, while)
must be accessible in the enclosing function scope.

## Motivation

`var` hoisting is fundamental to JavaScript semantics. Test262 tests and
real-world JS/TS code rely on `var` being function-scoped:

```javascript
for (var i = 0; i < 10; i++) { /* ... */ }
// i is still accessible here — it's 10
```

Currently our compiler treats `var` like `let` (block-scoped), causing failures
when variables are referenced outside their declaring block.

## Current behavior

```typescript
function test(): number {
  for (var i = 0; i < 3; i++) {}
  return i; // ERROR: 'i' is not defined
}
```

The `var i` is scoped to the for-loop block. After the loop, `i` is unknown.

## Expected behavior

`var` declarations should be hoisted to the top of the enclosing function,
initialized to `undefined` (or `0`/`NaN` for numbers), and accessible
throughout the function body.

## Approach

1. During function compilation, scan the AST for all `var` declarations
2. Collect them into a set of hoisted variables with their types
3. Allocate wasm locals for them at the function level
4. At declaration sites, only emit the initializer assignment (not a new local)
5. All references resolve to the function-level local

## Test262 impact

- Fixes 1 failing test (Math.round S15.8.2.15_A6.js)
- May fix additional compile errors in future test categories

## Complexity

M — Requires changes to variable resolution and function compilation.

## Dependencies

None.
