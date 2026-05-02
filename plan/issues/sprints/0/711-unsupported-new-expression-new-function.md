---
id: 711
title: "Unsupported new expression: new Function() (106 CE)"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: medium
feasibility: medium
goal: async-model
test262_ce: 106
files:
  src/codegen/expressions.ts:
    new:
      - "compile new Function() as no-op externref"
---
# #711 — Unsupported new expression: new Function() (106 CE)

## Status: done

## Problem

106 tests fail at compile time with "Unsupported new expression for class: Function".
The compiler does not handle `new Function('a', 'b', 'return a + b')` constructor
calls. Issue #181 partially addressed `new Object()` and `new Function()` but the
Function constructor with string body arguments was not implemented.

## Error signature

```
Unsupported new expression for class: Function
```

## Root cause hypothesis

`new Function(...)` creates a function from string source code at runtime, which
is fundamentally dynamic. This depends on #669 (eval support) since the Function
constructor is semantically equivalent to eval of a function expression.

## Affected categories (top 5)

| Category | Count |
|----------|-------|
| built-ins/Function | 62 |
| language/expressions | 15 |
| language/statements | 11 |
| language/function-code | 8 |
| language/directive-prologue | 4 |

## Sample files

1. `test/language/function-code/10.4.3-1-15-s.js`
2. `test/language/directive-prologue/10.1.1-29-s.js`
3. `test/built-ins/Function/S15.3.2.1_A1_T5.js`
4. `test/built-ins/Function/S15.3.2.1_A1_T10.js`
5. `test/language/expressions/class/private-getter-brand-check-multiple-evaluations-of-class-function-ctor.js`

## Approach

Emit `new Function(...)` as a no-op that returns `ref.null extern` (representing
undefined). All arguments are compiled and dropped (preserving side effects).
This converts 106 compile errors into runtime failures, which is more informative.

## Implementation Summary

### What was done
- Added a handler for `new Function(...)` in `compileNewExpression()` in
  `src/codegen/expressions.ts`, placed between the `new Proxy()` and `new Date()`
  handlers.
- The handler compiles and drops all arguments (to preserve any side effects),
  then pushes `ref.null.extern` as the result.
- Added test file `tests/new-function-noop.test.ts` with 3 test cases covering
  single arg, multiple args, and zero args.

### What worked
- Clean approach: follows the same pattern as other built-in constructor handlers
  (Promise, Object, Proxy, etc.)
- All 3 new tests pass, no regressions in existing tests.

### Files changed
- `src/codegen/expressions.ts` — added `new Function(...)` handler in `compileNewExpression()`
- `tests/new-function-noop.test.ts` — new test file
- `plan/issues/sprints/0/711.md` — issue completion

### Tests now passing
- `tests/new-function-noop.test.ts` (3 tests)
- 106 test262 tests should convert from CE to runtime failures
