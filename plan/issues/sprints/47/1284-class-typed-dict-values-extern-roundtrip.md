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

## Investigation notes (2026-05-02, dev-1284)

The hypothesis in the issue body about `extern.convert_any` round-trip is **NOT**
the actual bug. After tracing with `wasm-dis`, the round-trip code generation
itself is correct in isolation:

- `Node_addChild` correctly emits `extern.convert_any(c) → __extern_set(dict, key, externref)`.
- `Node_getChild` correctly emits `__extern_get(dict, key) → any.convert_extern → ref.test (ref Node) → ref.cast (ref null Node)`.

The actual bug is at the **call site** of `new Node(...)` when:
1. The class has an index-signature field initializer (`children: { [s: string]: Node } = {}`); AND
2. The class has a method body that uses `__extern_set` (e.g. `addChild(seg, c) { this.children[seg] = c; }`).

The method does NOT need to be called from `test()` — just defining it triggers the bug.

### What the compiler emits instead of `Node_new(42)`

Disassembly of the failing `test()` shows `new Node(42)` lowers to:

```wat
(call $__extern_set
  (call $__box_number (f64.const 42))
  (call $__get_undefined)
  (call $__get_undefined))
(local.set $0 (ref.as_non_null (ref.null none)))   ;; always traps
```

That is the call signature of `__extern_set: (externref, externref, externref) → ()` —
the test function is **calling `__extern_set` instead of `Node_new`**, with arg
`42` boxed via `__box_number` and the remaining 2 params padded with
`__get_undefined`. The subsequent `ref.as_non_null(ref.null none)` placeholder
satisfies the `(ref null Node)` local type but always traps at runtime →
"dereferencing a null pointer".

### Likely root cause

Function-index shift bug. When `Node_addChild` is compiled, it
`ensureLateImport`s `__extern_set`, `__box_number`, `__get_undefined`. These
shift all defined-function indices by 3.

`compileNewExpression` at `src/codegen/expressions/new-super.ts:2122-2188`:
1. `funcIdx = ctx.funcMap.get("Node_new")` → returns idx K.
2. `paramTypes = getFuncParamTypes(ctx, funcIdx)` → reads the signature.
3. `compileExpression(args[i], paramTypes[i])` → compiles args with paramTypes hints.
4. Pads with `pushDefaultValue(paramTypes[i])` for missing args.
5. Re-looks up `funcMap.get("Node_new")` → produces `finalCtorIdx`.
6. Pushes `call finalCtorIdx`.

If at step 1 the funcMap entry for `Node_new` still points to the slot that is
now occupied by `__extern_set` (because the shift didn't update funcMap before
this compile), then paramTypes is `[externref × 3]` and the args get padded to
3 externrefs. The call then goes to `__extern_set`. The pushed result type
(`{ kind: "ref", typeIdx: NodeStruct }`) lies about the stack — local.set $0
later sees no ref on the stack.

### Probes that reproduce / isolate (in `/tmp/probe-1284-*.wasm`)

- **Probe N** (smallest repro): `class Node { children = {}; addChild(seg, c) { this.children[seg] = c; } }` — class method defined but never called from `test()`. Repros.
- **Probe K** (no method): drop `addChild` entirely → works (`Node_new(42).id === 42`).
- **Probe L** (method with empty body): `addChild(seg, c) {}` (does nothing) → works.
- **Probe E** (no class field, dict declared locally inside `test()`): works.

The trigger is the **combination** of class field index-signature init AND a
method body that emits `__extern_set` (via `this.children[seg] = c`).

### Suspected fix areas

1. `src/codegen/expressions/late-imports.ts::shiftLateImportIndices` (lines 19-91): does shift `funcMap` entries for defined functions (line 80-85) and already-emitted instructions in `ctx.mod.functions[*].body` (line 52-54). Verify the shift propagates correctly when methods are compiled before `test()`.
2. `src/codegen/expressions/new-super.ts:2122-2188::compileNewExpression`: line 2185-2186 already comments on staleness; the re-lookup at line 2187 patches `finalCtorIdx`, but `paramTypes` is captured at line 2131 before arg compilation. If a shift occurs between 2131 and 2187, `paramTypes` is stale.
3. Possibly `addUnionImports` in `src/codegen/index.ts` — see `developer.md` note: "must also shift `ctx.currentFunc.body`". When methods compile before `test()`, the order is method → method → ... → test. If a late shift during the methods' compilation didn't include the (not-yet-existing) test body, that's fine. But if test calls into methods that were compiled before some imports were added, the funcMap must be authoritative.

### Recommendation

This is a "feasibility: medium, reasoning_effort: high" issue. Escalating to
`senior-developer` (Opus) for diagnosis. Recommended approach: add logging
instrumentation around `funcMap.set` / `funcMap.get` / `shiftLateImportIndices`
to trace the exact compile order with Probe N, then patch whichever invariant
is violated. The smallest repro is in `tests/issue-1284.test.ts` (committed in
this branch) and the failing wasm is at `/tmp/probe-1284-N.wasm`.
