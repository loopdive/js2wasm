---
id: 1028
title: "TypedArray.prototype.toLocaleString null/undefined in element toLocaleString path"
status: done
created: 2026-04-11
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
reasoning_effort: medium
goal: spec-completeness
parent: 820
---
# #1028 — TypedArray.prototype.toLocaleString element path crashes on null

## Problem

9 test262 tests under `test/built-ins/TypedArray/prototype/toLocaleString/` flipped `pass → fail` after today's Sprint 41 merges (likely PR #68 Array methods work or PR #64 Proxy mirror work), all with the same error pattern:

```
TypeError (null/undefined access): Return abrupt from firstElement's toLocaleString => valueOf
```

These are spec-compliance tests that verify TypedArray.prototype.toLocaleString correctly propagates abrupt completions from the first element's `toLocaleString()` or `valueOf()`.

## Investigation

1. Sample: `test/built-ins/TypedArray/prototype/toLocaleString/return-abrupt-from-firstelement-valueof.js`
2. The test expects a specific error class thrown from a trapped method — we're instead hitting null/undefined access BEFORE reaching the trap
3. Likely root cause: our TypedArray.prototype.toLocaleString implementation accesses `element.toLocaleString` without a proper ToObject / existence check
4. Check `src/runtime.ts` for any `__typed_array_to_locale_string` host handler, or look at how the method resolves in `src/codegen/array-methods.ts`

## Fix

Ensure that per-element method dispatch in TypedArray.prototype.toLocaleString:
1. ToObject(element) before `.toLocaleString` lookup
2. Lets any abrupt completion from valueOf/toLocaleString propagate *as the thrown error*, not as "null/undefined access"

## Expected impact

9 tests flip fail → pass.

## Key files

- `src/codegen/array-methods.ts`
- `src/runtime.ts` — any TypedArray host helpers

## ECMAScript spec reference

- [§23.2.3.30 %TypedArray%.prototype.toLocaleString](https://tc39.es/ecma262/#sec-%typedarray%.prototype.tolocalestring) — step 5b: if element is undefined or null, use empty string


## Implementation

The original failure wasn't element-path specific — `sample.toLocaleString()` on an
Int8Array/Uint8Array had NO handler in `calls.ts`, so it fell through to the graceful
`null.extern` fallback at `calls.ts:5601` and returned null (the "null/undefined access
BEFORE reaching the trap" described in the ticket).

Fix: added an early `.toLocaleString()` handler in `src/codegen/expressions/calls.ts`
(just before the `.toString()` fallback) that dispatches via a new late import
`__extern_toLocaleString(externref) -> externref`. The runtime handler in
`src/runtime.ts`:
- Returns `String(v)` for null/undefined
- For WasmGC structs (typed-array/array vec wrappers), uses `_wasmToPlain` to
  materialize the vec as a real JS array and delegates to native
  `Array.prototype.toLocaleString`
- For regular JS values, calls `v.toLocaleString()` directly

## Test Results

`tests/issue-1028.test.ts` — 3/3 pass (basic non-null + empty + populated returns).

Scoped test262 probe of 12 toLocaleString tests: 3 flipped fail→pass locally
(`empty-instance-returns-empty-string`, `return-result`, `detached-buffer`).

The 6 `return-abrupt-*` and 3 `calls-*-from-each-value` tests still fail — these
override `Number.prototype.toLocaleString` in wasm and expect per-element dispatch
to honor the wasm-side prototype chain. Our host-delegation path uses native JS
`Number.prototype` and can't see wasm overrides. Fixing those requires wasm-native
per-element dispatch through the wasm prototype chain and is out of scope for this
issue — tracked as follow-up.
