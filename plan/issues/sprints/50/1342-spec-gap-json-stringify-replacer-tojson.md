---
id: 1342
sprint: 50
title: "spec gap: JSON.stringify replacer/toJSON/property-list (49 of 66 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: json
goal: spec-completeness
parent: 1328
related: 1324
---
# #1342 — JSON.stringify: replacer function, toJSON method, property-list filter

## Problem

`built-ins/JSON/stringify`: **17 / 66 pass (25.8%)** — 42 assertion_fail, 2 type_error,
2 runtime_error, 1 other, 1 null_deref.
`built-ins/JSON/parse`: 55 / 77 (71.4%) — 19 assertion_fail.

Spec §25.5.2 (JSON.stringify) requires:
1. **`replacer`** can be a function (called for every key, with `(key, value)`) or an Array
   (used as a property allow-list for objects).
2. **`toJSON`** method on a value: if present, called via `Get(value, "toJSON")` and the result
   replaces the value (Date, BigInt, Temporal use this).
3. **`SerializeJSONProperty`** algorithm: nested objects, arrays, escaping, NaN/Infinity → null.
4. **Cycle detection** must throw TypeError.
5. **Indent** can be a Number or String, capped at 10 spaces.

Current `__json_stringify` host-imports JS `JSON.stringify` directly, which should be spec-compliant.
The 42 assertion_fail errors strongly suggest:
- We're calling `JSON.stringify(value, replacer, space)` but the replacer is a Wasm closure that
  the host JS engine cannot invoke (no JS-to-Wasm bridge for the replacer callback).
- Or: the Wasm callbacks are wrapped in a way that loses the `this` (the holder object) per spec
  §25.5.2.2.

Pure-Wasm JSON is tracked by #1324; this issue is the host-mode fidelity problem.

## Acceptance criteria

1. `built-ins/JSON/stringify/replacer-function-arguments.js` passes.
2. `built-ins/JSON/stringify/value-tojson-{primitive,object}.js` passes.
3. `built-ins/JSON/stringify/replacer-array-{normal,non-normal}.js` passes.
4. Pass-rate for `built-ins/JSON/stringify` rises from 26% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__json_stringify`, `__json_parse` callback bridge
- `src/codegen/registry/json.ts` (or equivalent registration)

## Implementation Plan

### Root cause

Replacer is a function, but when crossing into host JSON.stringify the host expects to call
the replacer as a JavaScript function with `this` set to the holder. Our Wasm function refs
are not directly JS-callable (issue #1308) — they need an externref-callable trampoline.

### Approach

1. Wrap Wasm-replacer functions in a JS closure at boundary: `function (k, v) { return wasmFn(this, k, v); }`.
2. For Array replacers (property-list mode): pass the array directly to host; spec says only
   strings and numbers are honored.
3. For the `toJSON` lookup: JSON.stringify host code does `Get(value, "toJSON")` — works automatically
   for externref objects with toJSON; for typed structs we may need to inline the lookup before
   handing the value to the host (since host can't see Wasm struct fields).

### Edge cases

- Replacer returns undefined for an array element → element becomes null per spec.
- toJSON is not a Function → ignored (no error).
- Property-list replacer with duplicate names → use first occurrence per spec.
- Object with cyclic reference → TypeError.

### Test262 sample

- `test262/test/built-ins/JSON/stringify/replacer-function-arguments.js`
- `test262/test/built-ins/JSON/stringify/value-tojson-object.js`
- `test262/test/built-ins/JSON/stringify/replacer-array-normal.js`
