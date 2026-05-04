---
id: 1154
title: "test262 worker: Array.prototype poisoning leaks into TypeScript compiler — Array.from fails at compile time (~378 test262 regressions)"
status: ready
created: 2026-04-21
updated: 2026-04-21
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
language_feature: test-infrastructure
goal: async-model
depends_on: [1119]
---
# #1154 — Array.from compile-time failure from incomplete prototype-poisoning restore

## Problem

378 tests report:

```
L1:0 Codegen error: %Array%.from requires that the property of the first argument, items[Symbol.iterator], when exists, be a function
```

This is V8's error message for `Array.from(items)` when `items[Symbol.iterator]` exists but is not a function. The message is emitted at `L1:0 Codegen error:` — meaning the compiler itself threw during codegen, not the compiled wasm at runtime.

`compile_ms` ≈ 180–250ms on these tests, so they are doing real compile work before the throw. The throw happens inside the TypeScript compiler or js2wasm codegen when it calls `Array.from(someArrayLike)` internally.

The trigger: a **preceding test262 test** defined `Array.prototype[Symbol.iterator]` as a non-function (e.g. `Object.defineProperty(Array.prototype, Symbol.iterator, { value: 42 })` or `Array.prototype[Symbol.iterator] = undefined`). The test262 worker's `restoreBuiltins()` sandbox in `scripts/test262-worker.mjs:60-98` only restores the `Symbol.iterator` slot via direct assignment — it does **not** recover from the case where a prior test set a non-configurable property descriptor on `Array.prototype`.

This is a state-leak variant and is closely related to **#1119** (Incremental compiler state leak — CompilerPool fork). Whereas #1119 targets checker-state leakage, this one targets **Array.prototype[Symbol.iterator] leakage** between compilations.

## Sample failing tests

```
test/built-ins/Array/prototype/findIndex/resizable-buffer-grow-mid-iteration.js
test/built-ins/Array/prototype/findLastIndex/resizable-buffer-grow-mid-iteration.js
test/built-ins/Array/prototype/forEach/15.4.4.18-2-5.js
```

All were passing on sprint-42/begin (22,412 pass) and regressed in the April 19 cascade — most likely because the worker's `GC_INTERVAL`/`RECREATE_INTERVAL` were tuned against an earlier, smaller set of poisoning patterns.

## Root cause

`scripts/test262-worker.mjs` shares an `incrementalCompiler` object across up to 100 tests (see `RECREATE_INTERVAL`). The sandbox in `restoreBuiltins()`:

- Restores `Array.prototype[Symbol.iterator]` by direct assignment *only if it differs from the original*.
- Does NOT remove descriptors added via `Object.defineProperty(Array.prototype, Symbol.iterator, {get: () => 42, configurable: false})` — the descriptor remains, and the getter can be arbitrary.
- Does NOT restore named functions on `Array.prototype` (`values`, `keys`, `entries`) that some tests replace.

When the TS compiler or codegen subsequently calls `Array.from(internalArray)`, V8's `Array.from` spec calls `GetMethod(items, @@iterator)`; if `internalArray` is a real Array, it walks the prototype chain and finds the corrupted iterator, leading to the `%Array%.from requires…` throw.

## Fix approach

Layered options (in order of preference):

1. **Full prototype snapshot** at worker startup: snapshot `Object.getOwnPropertyDescriptors(Array.prototype)` and after each test, restore every descriptor (including deleting anything added). Same for `Object.prototype`, `String.prototype`, `Map.prototype`, `Set.prototype`, `RegExp.prototype`, `Promise.prototype`.
2. **Configurable check before reset**: when `restoreBuiltins()` sees a non-configurable poison descriptor, mark the worker as poisoned and force-exit (the current code does this only for numeric indices — extend to `Symbol.iterator`).
3. **Compile in a separate Realm / VM context**: run compilation inside `node:vm.runInNewContext()` so prototype mutations never leak to the compiler. This is the proper fix but more invasive.

Recommend layer 1 (full descriptor snapshot) as the immediate fix; layer 3 as the follow-up under #1119.

## Acceptance criteria

- The 3 sample tests above compile without throwing `%Array%.from requires...`.
- Running the full test262 suite produces 0 occurrences of `%Array%.from requires that the property of the first argument` in the error log.
- `scripts/test262-worker.mjs` has explicit snapshot+restore coverage for `Array.prototype`, `Object.prototype`, and `Symbol.iterator` descriptors.
- No regressions in compile time (restore overhead should be < 2ms per test).
