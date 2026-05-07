---
id: 1323
sprint: 50
title: "Iterator protocol bridging: implement $IteratorResult struct in pure Wasm, eliminate host bridge"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: easy
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

## Strategy

WasmGC already has struct types. Define a canonical `$IteratorResult { done: i32, value: externref }`
struct type in the IR. 

1. Add `$IteratorResult` to `src/ir/nodes.ts` and `src/ir/types.ts` alongside existing
   canonical types (`$union_*`, `$vec_*`, etc.).
2. Modify the iterator-creation path in `src/ir/lower.ts` (around the for-of lowering,
   ~L1276-1300) to construct `$IteratorResult` structs directly instead of calling host
   `__iterator_next`.
3. The initial `Symbol.iterator` sidecar dispatch (one call per iterable, not per step) can
   remain as-is — it's unavoidable for externref objects. Wrap its result in a WasmGC
   iterator wrapper immediately.
4. `__iterator_done` → `struct.get $done` field (i32 → bool comparison, pure Wasm)
5. `__iterator_value` → `struct.get $value` field (pure Wasm)
6. Remove `__iterator_next`, `__iterator_done`, `__iterator_value` host imports.
   Keep `__iterator` (for the initial Symbol.iterator resolution only).

## Acceptance criteria

1. `for (const x of [1,2,3])` compiles without `__iterator_next` host import reference
2. Spread `[...arr]` compiles without iterator host imports (beyond initial `__iterator`)
3. `tests/equivalence.test.ts` — no regressions on for-of / spread / destructuring tests
4. No regressions in test262 iterator category

## Files

- `src/ir/nodes.ts` — add `$IteratorResult` struct type
- `src/ir/types.ts` — register canonical type
- `src/ir/lower.ts` — construct structs at call sites
- `src/runtime.ts` — remove `__iterator_next`, `__iterator_done`, `__iterator_value` imports
