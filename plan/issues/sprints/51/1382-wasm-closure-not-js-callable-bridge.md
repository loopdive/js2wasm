---
id: 1382
sprint: 51
title: "structural: Wasm closures not JS-callable from host imports — bridge gap"
status: ready
created: 2026-05-08
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: closures, callbacks
goal: ir-full-coverage
---
# #1382 — Wasm closures not JS-callable from host imports

## Problem

A recurring structural blocker across multiple features: Wasm closure structs
(`$closure_N`) cannot be passed directly as JS-callable function arguments to
host imports. This pattern is required by:

- **#1339** — `Array.from(items, mapFn)`: host `__array_from` receives a Wasm
  closure and errors "object is not a function"
- **#1358** — `Array.prototype.{filter,map,every,some,forEach}.call(obj, cb, thisArg)`:
  `__call_with_this(fn, thisArg, ...)` requires `fn` to be JS-callable, but Wasm
  closures aren't
- **#1338** — `Function.prototype.bind`: LHS coerce on the bound function fails
  because the JS bound function doesn't survive the `externref → closure struct`
  cast chain at the assignment site
- **#1371** (IR external call whitelist): any IR function passed as a callback
  to a whitelisted external hits the same wall

The root issue: our Wasm closures are `struct` refs — they're callable from
Wasm via `call_ref` using the function table, but the JS host receives an
opaque object with no `[[Call]]` internal method.

## Options

### Option A — JS-callable wrapper on demand (preferred)

Add a runtime primitive `__make_js_callable(closureRef, funcTableIdx) -> externref`
that wraps a Wasm closure in a JS `Function`:

```js
// src/runtime.ts
__make_js_callable(closure, funcIdx) {
  return function(...args) {
    return instance.exports.__wasm_call_closure(closure, funcIdx, ...args);
  };
}
```

The Wasm side exports `__wasm_call_closure(closure: externref, funcIdx: i32, ...args)`.
Call sites that need to pass a closure to a host import first call
`__make_js_callable`, store the result as `externref`, then pass it.

**Downside**: one allocation per callback site, plus the round-trip through JS.

### Option B — Always emit JS-callable trampolines for exported closures

When a closure is created and will be passed to a host import context (detectable
at compile time for typed call sites), emit a JS-function wrapper eagerly at
closure creation. Store alongside the `$closure_N` struct.

**Downside**: requires call-site type inference; harder to implement correctly.

### Option C — Thread thisArg as Wasm param, avoid host entirely

For `array.{filter,map,every,some,forEach}` specifically: the existing Wasm-native
loop already uses `call_ref` — it just needs `thisArg` threaded as an extra parameter
to the callback's function type. Change the closure function type signature to include
an optional `thisArg: externref` param and update call sites.

**Only solves the thisArg sub-problem, not Array.from mapFn or bind.**

## Recommended approach

Option A for the general case. Option C as a quick fix for `thisArg` in array
methods (since those are already Wasm-native loops and don't go through the host).

## Acceptance criteria

1. `Array.from([1,2,3], x => x * 2)` produces `[2,4,6]` — closure mapFn works.
2. `[1,2,3].map(fn, thisObj)` — thisArg is correctly forwarded to the closure.
3. `Function.prototype.bind` LHS: the bound result is assignable without triggering
   the closure-struct cast chain.
4. No performance regression on the existing `array.map` hot path (which uses
   `call_ref` directly and must NOT go through the JS wrapper).

## Files

- `src/runtime.ts` — `__make_js_callable` + `__wasm_call_closure` exports
- `src/codegen/array-methods.ts` — call sites for array callbacks
- `src/codegen/expressions/calls.ts` — bind call site coerce fix
- `src/ir/integration.ts` — IR external call whitelist bridge

## Notes

Discovered independently by dev-1306 during #1339, #1358 investigation.
Blocks: #1339 (mapFn), #1358 (thisArg), #1338 (bind LHS).
