---
id: 517
title: "Unsupported call expression: class/generator/built-in method calls (2,164+ CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
goal: maintainability
test262_ce: 2164
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileCallExpression — handle class method calls, generator calls, string built-in calls"
---
# #517 — Unsupported call expression: class/generator/built-in method calls (2,164+ CE)

## Status: review

3,711 total "Unsupported call expression" CEs. Breakdown by context:

| Context | Count |
|---------|------:|
| Class body (expressions + statements) | 2,164 |
| Async generator | 387 |
| Generator | 137 |
| String built-in methods (split, trim, match, search) | 195 |
| Array built-in methods (slice, splice, sort, map) | 138 |
| Object literal | 221 |
| Async function | 41 |
| Number.prototype.toString | 44 |

The class body cases are likely method calls on `this`, super calls, or computed property calls inside class declarations. The string/array cases are missing built-in method implementations.

## Complexity: L

## Implementation Notes

### Problem
When a class or struct has a function-typed property (e.g. `callback: () => number`), calling it
via `this.callback()` or `obj.fn(x)` would hit the "Unsupported call expression" fallback because
the compiler looked for `ClassName_callback` in `funcMap` (treating it as a method), found nothing,
and fell through.

### Fix
Added `compileCallablePropertyCall()` helper function in `expressions.ts` that handles callable
struct field dispatch. When a method lookup fails for a class/struct receiver, the helper:

1. Checks if the property name is a struct field on the receiver type
2. Verifies the field's TS type has call signatures (is callable)
3. Reads the field value via `struct.get`
4. Dispatches via `call_ref` using the appropriate closure wrapper type

Three dispatch paths depending on field wasm type:
- **ref to known closure struct**: direct closure call via `call_ref`
- **externref**: convert to closure struct via `any.convert_extern` + `ref.cast`, then `call_ref`
- **ref to unknown struct**: match against registered closure types by signature

The fallback is inserted in two places:
- Class instance receiver block (handles `this.fn()` and `obj.fn()` for class instances)
- Struct type receiver block (handles callable properties on object literals)

### Files Changed
- `src/codegen/expressions.ts`: Added `compileCallablePropertyCall()` function (~170 lines),
  integrated into class instance and struct type receiver blocks

### Tests
- New: `tests/class-method-calls.test.ts` -- 5 tests covering callable property patterns
- No regressions in existing test suite
