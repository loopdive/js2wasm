---
id: 1323
sprint: 50
title: "Iterator protocol: $IteratorResult WasmGC struct, reshape __iterator_next, eliminate per-field host calls"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime, codegen
language_feature: iterators, for-of
goal: standalone-mode
---
# #1323 — Iterator protocol: pure-Wasm $IteratorResult struct

## Problem

`__iterator`, `__iterator_next`, `__iterator_done`, `__iterator_value` are JS host imports
(`src/runtime.ts`). They handle Symbol.iterator sidecar lookup and extract `{done, value}`
from result objects. This means any `for-of` loop or spread in standalone mode hits the JS
host for every iteration step.

## Strategy (revised 2026-05-07 with team-lead)

WasmGC has struct types. Define a canonical `$IteratorResult { done: i32, value: externref }`
struct type in the IR. The `.next()` call still must hit the JS host (you can't invoke a JS
object's method from pure Wasm), but the per-field `.done` / `.value` extraction can become
`struct.get` — pure Wasm.

**Net win**: 3 host calls per iteration step → 1.

1. Add `$IteratorResult` canonical struct to `src/ir/nodes.ts` and `src/ir/types.ts`
   alongside existing canonical types (`$union_*`, `$vec_*`, etc.).
2. Reshape `__iterator_next` host import: `(externref) → (ref null $IteratorResult)`.
   The JS host:
   - Calls `iter.next()` to get the JS result object `{ done, value }`.
   - Calls a wasm-exported constructor `__make_iterator_result(done: i32, value: externref) → (ref null $IteratorResult)` to build the struct.
   - Returns the struct ref.
3. Rewrite `iter.done` lowering (`src/ir/lower.ts:1289-1294`):
   ```
   <emit resultObj as struct ref>
   struct.get $IteratorResult $done   ;; -> i32
   ```
4. Rewrite `iter.value` lowering (`src/ir/lower.ts:1295-1300`):
   ```
   <emit resultObj as struct ref>
   struct.get $IteratorResult $value  ;; -> externref
   ```
5. Update `forof.iter` lowering (`src/ir/lower.ts:1307+`) and `IrInstrIterNext` /
   `IrInstrIterDone` / `IrInstrIterValue` types in `src/ir/nodes.ts` to use struct ref
   types instead of externref for the `resultObj`.
6. Keep `__iterator` (Symbol.iterator dispatch — unavoidable for externref).
7. Keep `__iterator_return` (calls iter.return() — same host-call constraint).
8. Remove `__iterator_done` and `__iterator_value` host imports from
   `src/codegen/index.ts:addIteratorImports` and `src/runtime.ts:3552-3571`.

## Acceptance criteria

1. `for (const x of [1,2,3])` compiles without `__iterator_next` host import reference
2. Spread `[...arr]` compiles without iterator host imports (beyond initial `__iterator`)
3. `tests/equivalence.test.ts` — no regressions on for-of / spread / destructuring tests
4. No regressions in test262 iterator category

## Files

- `src/ir/nodes.ts` — add `$IteratorResult` struct type, update `IrInstrIterNext`/`IterDone`/`IterValue` operand types from externref to struct ref
- `src/ir/types.ts` — register canonical type
- `src/ir/lower.ts` — `iter.done`/`iter.value` lower to `struct.get`; `forof.iter` updates result-slot type
- `src/codegen/index.ts:addIteratorImports` — drop `__iterator_done`/`__iterator_value`, change `__iterator_next` return type to struct ref, ensure `__make_iterator_result` is exported
- `src/runtime.ts` — drop `__iterator_done`/`__iterator_value` impls; rewrite `__iterator_next` impl to call `wasmExports.__make_iterator_result(done, value)` after `iter.next()`

## Implementation notes (dev-1302, 2026-05-07)

The wasm side needs an EXPORTED constructor function so the JS host can build
`$IteratorResult` structs. Pattern to follow: see how existing canonical structs
(e.g. `$union_*`, vec types) are constructed from JS — most aren't, they're built
inside Wasm. This may require a new export-helper pattern.

Alternatively: define an internal helper function `__make_iterator_result` that
takes `(i32, externref)` and emits `(struct.new $IteratorResult)`. Export it
under `__make_iterator_result` so the JS bridge can call `wasmExports.__make_iterator_result(done, value)`.

Reference the `addIteratorImports` builder in `src/codegen/index.ts:5064` — that's
where you'd register the new export and reshape the import signatures.

The host bridge (runtime.ts:3523-3571) already has the JS plumbing to call
`callbackState?.getExports()` — see how `__iterator_done` already falls back to
`exports?.__sget_done?.(result)`. The new `__make_iterator_result` export is the
same shape.

## Acceptance criteria
