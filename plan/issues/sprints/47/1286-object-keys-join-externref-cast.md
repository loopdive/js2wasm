---
id: 1286
title: "Object.keys(any-typed obj).join() throws illegal cast — externref→string-array coerce missing"
status: ready
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
