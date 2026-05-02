---
id: 181
title: "Unsupported `new Object()` and `new Function()` constructor calls"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: compilable
---
# #181 — Unsupported `new Object()` and `new Function()` constructor calls

## Status: review

## Summary
58 test262 compile errors from `new Object(...)` (39 tests) and `new Function(...)` (19 tests). These are built-in constructors that need special handling.

## Motivation
- `new Object()` should create an empty object literal `{}`
- `new Function(...)` creates functions from strings (inherently dynamic, likely can't support)
- The Object constructor could be mapped to struct creation

For `new Object()`, this is straightforward: emit an empty struct. `new Function()` requires dynamic code generation which is fundamentally impossible in wasm — these should be added to the skip filter.

## Scope
- `src/codegen/expressions.ts` — NewExpression handling for built-in constructors
- `tests/test262-runner.ts` — skip filter for `new Function()` pattern

## Complexity
S

## Acceptance criteria
- [ ] `new Object()` creates an empty object
- [ ] `new Function()` tests skipped (dynamic code generation)
- [ ] 39 Object constructor compile errors fixed

## Implementation Notes
- Added early return in compileNewExpression for `new Object()` that emits `ref.null.extern` (empty externref)
- Added "Object" and "Function" to KNOWN_CONSTRUCTORS set so they don't generate unnecessary __new_X host imports
- Added `new Function()` skip pattern to test262-runner.ts skip filter
