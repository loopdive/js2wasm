---
id: 1320
sprint: 50
title: "Runtime bridge: Array.from(externref) / Iterator.from(externref) doesn't preserve own [Symbol.iterator] on plain JS objects (4 test262 fails)"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: iterators, externref, Array.from
goal: spec-conformance
depends_on: []
related: [1154]
---
# #1320 — Array.from / Iterator.from runtime bridge drops own [Symbol.iterator]

## Background

Filed as a follow-up to #1154 after closing it as resolved. The original
~378 leak-cluster is fixed; 4 tests still hit the
`%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function` error, but the root
cause is **different** — they fail standalone (verified in isolation),
not from prior-test prototype poisoning.

## Failing tests

- `test/built-ins/Array/from/iter-cstm-ctor.js`
- `test/built-ins/Array/from/iter-set-length.js`
- `test/built-ins/Iterator/from/iterable-primitives.js`
- `test/built-ins/Iterator/prototype/flatMap/iterable-primitives-are-not-flattened.js`

The first two fail with the exact V8 native error. The latter two fail
with `WebAssembly.Exception` (likely the same root cause routed through
a different code path).

## Repro

```bash
npx tsx -e "
import { compile } from './src/index.ts';
import { readFileSync } from 'node:fs';
import { buildImports } from './src/runtime.ts';
const src = readFileSync('test262/test/built-ins/Array/from/iter-cstm-ctor.js', 'utf-8');
const r = compile(src, { fileName: 'test.ts', skipSemanticDiagnostics: true });
const imports = buildImports(r.imports, undefined, r.stringPool);
await WebAssembly.instantiate(r.binary, imports);
"
```

Throws synchronously from `WebAssembly.instantiate`:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

The error originates from V8's native `Array.from` inside our runtime's
host-import bridge for the compiled `Array.from(items)` call.

## Hypothesis

The test source pattern is:

```js
var items = {};
items[Symbol.iterator] = function() {
  return { next: function() { return { done: true }; } };
};
result = Array.from.call(C, items);
```

When this compiles, `items` becomes an externref (a JS object reference)
in wasm memory, and the assignment `items[Symbol.iterator] = ...` routes
through our runtime's safeSet for symbol-keyed properties.

Suspected: the safeSet path for `Symbol.iterator` on a plain JS-host
object (externref-wrapped `{}`) either:

1. Routes the assignment to a sibling property (well-known-symbol ID
   path) instead of installing an own `[Symbol.iterator]` descriptor on
   the target object, OR
2. Installs the descriptor on a wrapper that V8's `Array.from` doesn't
   see when walking `items[Symbol.iterator]`.

When the compiled `Array.from(items)` then calls into the host import,
the host invokes native `Array.from(items)`. V8 reads
`items[Symbol.iterator]`, finds either nothing or a non-function value
(inherited from `Object.prototype` after the safeSet path mis-routed),
and throws.

## Investigation start points

- `src/runtime.ts` — locate the `__safeSet` / `_safeSet` host import for
  symbol-keyed property assignment. Compare its handling of
  `Symbol.iterator` on a plain JS object vs. on a wasm-managed struct
  (`_isWasmStruct(obj)` gate referenced in the worker comment at
  test262-worker.mjs L546–554, which describes a similar miss-route
  pattern that #1160 had to defensively clean up).
- `src/codegen/expressions/calls.ts` (or wherever `Array.from` /
  `Iterator.from` is lowered) — verify the call site emits the
  externref directly without re-wrapping.

## Acceptance criteria

1. The 4 listed tests no longer throw the `%Array%.from requires...`
   error in `WebAssembly.instantiate`.
2. `iter-cstm-ctor.js` instantiates and the test body's
   `assert.sameValue(callCount, 1, ...)` passes.
3. No new regressions in tests under
   `test/built-ins/Array/from/` or `test/built-ins/Iterator/`.

## Out of scope

- Prototype-poisoning leak handling (covered by #1154 — closed).
- Any non-`Array.from` / non-`Iterator.from` symbol-iterator bugs.
