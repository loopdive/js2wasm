---
id: 1275
title: "typeof-guard narrowing for any-typed parameters (untyped JS functions)"
status: done
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: typeof, type-narrowing, any
goal: npm-library-support
related: [1031, 1107]
---
## Implementation note (2026-05-02, dev-1245)

Patterns already work on main — issue title's "fails to narrow" claim was stale. PR#170
added regression tests only (test-only, no src changes). All acceptance criteria met.

Known follow-up: `typeof closureRef == "function"` returns "object" when closure passed as
externref — `__typeof_function` helper limitation, ties into #1276.

# #1275 — typeof-guard narrowing for `any`-typed parameters

## Problem

Lodash functions take `any`-typed parameters (no TypeScript annotations). The compiler
currently fails to narrow the type of `value` inside a `typeof value == 'number'` guard,
leading to Wasm validation errors (branch type mismatch) or silent runtime failures.

Example from `lodash-es/toNumber.js`:

```js
function toNumber(value) {          // implicit any — compiled as externref
  if (typeof value == 'number') {
    return value;                   // should emit f64 (narrowed to number)
  }
  if (isSymbol(value)) {
    return NAN;                     // f64 — fine
  }
  ...
  if (typeof value != 'string') {
    return value === 0 ? value : +value;  // +value must coerce externref→f64
  }
  ...
}
```

The root issue: when a parameter is `any` (externref in Wasm), a `typeof x == 'number'`
guard must narrow `x` to f64 inside the true branch. Currently all branches use the same
externref type, causing either a type mismatch at Wasm validation or boxing overhead.

## Patterns to handle

1. **`typeof x == 'number'` guard** — narrow `x` to f64 in true branch, emit unbox
2. **`typeof x == 'string'` guard** — narrow to string type in true branch
3. **`typeof x == 'function'` guard** — narrow to funcref in true branch
4. **`+value` coercion** — externref → f64 (call `__unbox_number` or `extern.convert_any` + cast)
5. **`typeof x.prop == 'function'` guard** — property access on externref, then typeof

## Impact

Blocks `toNumber`, `isObject`, `isSymbol`, and virtually every lodash type-checking
utility. Without this, `clamp`, `floor`, `ceil`, `round`, and all functions depending on
`toNumber` cannot compile correctly.

## Acceptance criteria

1. `toNumber(3.14)` → `3.14` (number input fast path)
2. `toNumber('3.14')` → `3.14` (string coercion path)
3. Wasm validates without type mismatch on branches
4. `tests/issue-1275.test.ts` covers all three typeof-narrowing patterns
5. No regression in typeof-operator tests
