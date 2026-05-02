---
id: 1284
title: "Class-typed values in index-signature dicts lose identity through extern_set/extern_get round-trip"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: classes, index-signature, extern
goal: npm-library-support
related: [1274, 1285]
---

# #1284 — Class-typed values in index-signature dicts lose identity through extern_set/extern_get

## Problem

Storing a class instance as a value in an index-signature dict (`{ [key: string]: SomeClass }`)
and reading it back fails with a null-deref at runtime. The value is written via `__extern_set`
but when read back through `__extern_get` and cast to the class struct type, it either returns
null or the cast fails.

## Repro

```ts
class Node {
  id: number;
  #children: { [s: string]: Node } = {};

  constructor(id: number) { this.id = id; }
  addChild(seg: string, c: Node): void { this.#children[seg] = c; }
  getChild(seg: string): number { return this.#children[seg].id; }
}

export function test(): number {
  const root = new Node(0);
  root.addChild("a", new Node(42));
  return root.getChild("a");  // should be 42 — currently null-deref
}
```

Observed: `RuntimeError: dereferencing a null pointer` at the `__extern_get` downstream cast.

Discovered while implementing Hono Tier 2e (recursive TrieRouter Node). Tier 2d (parallel-array
workaround) passes, but the real Hono `TrieRouter` uses `#children: { [seg: string]: Node }`.

## Root cause hypothesis

`__extern_set(dict, key, value)` stores the class instance as an `externref`. On read,
`__extern_get(dict, key)` returns an `externref` which is then cast to the struct type via
`ref.cast`. The cast likely fails because:

1. The stored value is boxed as an opaque host ref rather than a WasmGC `anyref`, so `ref.cast`
   can't see through the boxing to recover the original struct type.
2. Or: the value goes through `extern.convert_any` on write but not `any.convert_extern` on
   read, losing the GC-managed reference.

Compare to primitive values (`number`, `string`) in dicts — those work because they're
unboxed/reboxed via `__box_number`/`__unbox_number` or string pool. Class instances currently
have no equivalent round-trip path through host dict storage.

## Fix direction

Option A — store class instances as `anyref` (not `externref`) in the dict. Requires a dict
variant keyed on string with `anyref` values, bypassing the host JS dict entirely for GC-typed
values. WasmGC has `(array (mut anyref))` which can store typed refs directly.

Option B — use `any.convert_extern` on read to recover the `anyref` from the `externref`,
then `ref.cast` to the expected type. This keeps the host dict but adds the conversion op.

Option B is lower-risk (narrower change); verify it with `wasm-dis` diff against the working
WeakMap/Map paths.

## Acceptance criteria

1. The repro above compiles and returns `42` without null-deref.
2. `Tier 2e` in `tests/stress/hono-tier2.test.ts` unskipped and passing.
3. `tests/issue-1284.test.ts` covers: single-level dict, nested dict (N=2 depth), mixed
   class/primitive values in same dict, null key miss returns 0/undefined.
4. No regression in existing index-signature dict tests (Tier 2b/2c pass).
