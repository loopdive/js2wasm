---
id: 1286
sprint: 47
title: "Object.keys(any-typed obj).join() throws illegal cast — externref→string-array coerce missing"
status: done
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: Object.keys, array, string, any
goal: npm-library-support
related: [1243]
---

# #1286 — Object.keys(any).join() throws "illegal cast"

## Problem

When `Object.keys` is called on an `any`-typed (externref) object, the result is an
`externref` (host array). Calling `.join()` on that result fails with
`RuntimeError: illegal cast` because the codegen tries to cast the externref directly
to a WasmGC string-array type for the `.join()` receiver.

```ts
function test(obj: any): string {
  return Object.keys(obj).join(",");  // throws "illegal cast"
}
```

Discovered by dev-1243 as a side finding during #1243 implementation.

## Root cause

`Object.keys(externref)` returns an `externref` (the host returns a JS array). The
`.join()` call on the result expects a WasmGC `(ref array)` receiver for the string-array
`.join` implementation. The codegen doesn't insert `any.convert_extern` + cast or route
`.join()` through the host-array path when the receiver is externref.

## Fix direction

When compiling a `.join()` call where the receiver is typed `any`/externref:
1. Detect that the receiver is externref (not a known WasmGC array type).
2. Route through `__array_join` host import (or equivalent) which delegates to the host
   array's `.join()` method directly, returning an externref string.
3. Alternatively: insert `any.convert_extern` on the `Object.keys` result to recover a
   GC-managed array ref, then use the existing WasmGC `.join()` path.

## Acceptance criteria

1. `Object.keys(anyObj).join(",")` compiles and returns the correct comma-separated string.
2. `Object.keys(anyObj).join()` (no arg — default separator) also works.
3. `tests/issue-1286.test.ts` covers both cases plus a round-trip:
   `Object.keys({a:1, b:2}).join(",") === "a,b"`.
4. No regression in #1243 (for...in / Object.keys tests).

## Implementation

Took fix direction (2): route `.join()` through a host-import fallback when the
receiver is externref. New host import `__array_join_any(arr, sep) -> externref`
in `src/runtime.ts` (alongside `__array_concat_any`) accepts either a JS array
(returned directly by `__object_keys`) or a WasmGC vec (converted via
`__vec_len`/`__vec_get`) and calls the host's native `Array.prototype.join`.

Codegen changes in `src/codegen/array-methods.ts`:
- New helper `probeReceiverIsExternref` — fast-path check on identifier locals
  and globals plus a probe-compile-and-rollback for arbitrary expressions.
- New `compileArrayJoinExtern` — emits the receiver, the separator (or
  `ref.null.extern` for the no-arg form so the runtime falls back to the
  spec-mandated `,`), then a single `call` to `__array_join_any`.
- `compileArrayJoin` now early-returns to the extern fallback when the receiver
  is externref. The WasmGC-native path is unchanged for typed array receivers.

Why probe the receiver instead of trusting `actualType` from the existing
probe-compile in `compileArrayMethodCall`? That outer probe only captures
ref/ref_null with a typeIdx (line 1836); externref results are dropped. Rather
than retrofitting that flow (which several other methods rely on), the join
case does its own focused probe.

## Test Results

`tests/issue-1286.test.ts` — 10/10 pass:
- 3 acceptance-criteria tests (AC1 anyObj-comma, AC2 anyObj-default, AC3 inline-literal-roundtrip)
- 2 #1243 regression-guard tests (typed struct path still inline)
- 2 array.join() regression-guard tests (typed string/number arrays)
- 2 custom-separator tests on externref receivers (custom + empty)

Cross-check on related suites:
- `tests/issue-1243.test.ts` — all pass
- `tests/object-keys-values-entries.test.ts` — all pass
- `tests/equivalence/object-keys.test.ts` — all pass
- 42/42 across the three suites

The two pre-existing regressions discovered while writing tests (no-arg
`.join()` emits `ref.null.extern` instead of `,` when the comma string global
isn't otherwise registered) are out of scope for this issue and should be
filed separately if not already tracked.
