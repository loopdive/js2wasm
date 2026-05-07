---
id: 1320
sprint: 50
title: "host Array.from / Iterator.from doesn't see @@iterator set on a wasm-side object — 4 test262 fails"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
language_feature: symbols, iterators, host-bridge
goal: async-model
depends_on: []
related: [1154, 1160]
---
# #1320 — host `Array.from(obj)` / `Iterator.from(obj)` doesn't see `obj[Symbol.iterator]` set from wasm

## Summary

When wasm-compiled JS sets `obj[Symbol.iterator] = function () { ... }`
on a wasm-side object and subsequently passes that object to a host
built-in like `Array.from(obj)` or `Iterator.from(obj)`, V8's host
implementation throws:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

V8's `Array.from` does `GetMethod(items, @@iterator)`. If the wasm
runtime's externref envelope around `items` does NOT expose
`@@iterator` via the standard JS property-lookup protocol, V8 finds
*something* there (otherwise it would be undefined and Array.from
would treat it as array-like) but it isn't callable. The result is
the wasm test traps at `Array.from(items)` even though the wasm-side
property is a perfectly valid generator/function.

## Failing tests in the current baseline

```
test/built-ins/Array/from/iter-cstm-ctor.js
test/built-ins/Array/from/iter-set-length.js
test/built-ins/Iterator/from/iterable-primitives.js
test/built-ins/Iterator/prototype/flatMap/iterable-primitives-are-not-flattened.js
```

All four fail with the same V8 error string and `instantiateError: true`
(throw escapes from the start function during
`WebAssembly.instantiate`). Verified to fail in isolation — a fresh
worker fork running just one of these tests produces the same error,
so this is **not** worker prototype-poisoning leak (#1154 family).

## Reproducer

The minimal pattern, drawn from `Array/from/iter-cstm-ctor.js`:

```typescript
const items: any = {};
items[Symbol.iterator] = function () {
  return { next: function () { return { done: true }; } };
};
const result = Array.from(items);  // throws: items[Symbol.iterator] when exists, be a function
```

`Iterator.from('string')` and `Array.from(5)` (after assigning
`Number.prototype[Symbol.iterator] = function* (){...}`) hit the same
bridge layer through different shapes.

## Root cause (suspected)

The wasm runtime's `__obj_set` / equivalent receives a wasm-struct
key for `Symbol.iterator` — likely the well-known symbol value or a
sentinel-encoded ID — and stores it inside the wasm-struct's
key/value vec. When the wasm `Array.from(items)` host call passes
the externref to V8, V8's host `Array.from` does
`items[Symbol.iterator]`, which goes through V8's property-access
machinery on the externref's underlying host object. That host
object is whatever the runtime returns when V8 unboxes the
externref — typically a wasm-binding wrapper that does NOT route
`@@iterator` lookups back into the wasm-struct's key/value vec.

So the property is set on the wasm side, but reads from the host
side hit a different storage and find either nothing (Array.from
treats `items` as array-like via `length`) or a non-callable stub.

This is the symmetric inverse of #1160 (which was about
`Object.prototype[Symbol.iterator]` accidentally being set from the
runtime's `_safeSet` mis-routing well-known symbol IDs onto the
prototype): there the wasm runtime wrote to the wrong host slot.
Here the wasm runtime writes to the wasm-side slot, but the host
read can't reach it.

## Fix shape (sketch)

Two layered options, in increasing scope:

1. **Bridge `Symbol.iterator` reads on wasm-objects to the wasm-struct
   storage.** When the host calls `obj[Symbol.iterator]` on a
   wasm-bound externref, the runtime's host-side wrapper should
   first check if `obj` is a wasm-struct (by `_isWasmStruct(obj)`)
   and if so look up the symbol's well-known ID in the struct's
   key/value vec, returning the stored value. The check needs to
   happen at every `GetMethod` host site that today goes through
   the standard JS lookup.

2. **Make wasm-objects expose well-known symbols via a Proxy / real
   own property.** Instead of storing `@@iterator` in the
   key/value vec, route the wasm-side
   `obj[Symbol.iterator] = fn` to set a real own property on the
   externref's host wrapper — using `Object.defineProperty(host,
   Symbol.iterator, {value: fn, writable: true, configurable: true})`.
   Then host `Array.from` / `Iterator.from` find it via the standard
   protocol unchanged.

Option 2 is the cleaner fix but only works when there IS a host
wrapper to assign to. Option 1 is a runtime adapter that intercepts
every host built-in call site — more invasive and may not catch
spec-defined indirect lookups.

## Acceptance criteria

1. The 4 failing tests above transition from `fail` to `pass` in the
   test262 baseline.
2. `Array.from(items)` where `items[Symbol.iterator] = fn` is set on a
   wasm-side object correctly invokes the iterator.
3. `Number.prototype[Symbol.iterator] = function* () {...}` followed by
   `Array.from(5)` works (the host walks the prototype chain to the
   wasm-set slot on Number.prototype).
4. No regression on tests that do NOT set `@@iterator` (the existing
   array-like fallback path stays intact).

## Why this matters

This is the smallest standing test262 cluster from the original
"Array.from requires" pattern after the worker-poisoning fixes
(#1154, #1160) cleared the rest. Each test exercises a different
spec corner of host↔wasm symbol-property visibility, so a fix here
is likely to unblock a broader set of "wasm sets a symbol on an
object, host built-in reads it" patterns beyond just Array.from.

## Investigation steps

1. Trace `obj[Symbol.iterator] = fn` through `src/runtime.ts` /
   `src/codegen/expressions/assignment.ts`. Does the well-known
   symbol ID land in the wasm-struct's key vec, or in some other
   storage?
2. Trace `Array.from` host call: where does the externref get
   unboxed for the host call, and what does the host `GetMethod`
   see when it reads `@@iterator`?
3. Compare with the `for...of` path on the same wasm-object — that
   one DOES find the wasm-set @@iterator (verified Tier 5 / lodash
   stress tests). Why does that path work but host `Array.from`
   doesn't?
