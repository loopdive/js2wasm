---
id: 1247
title: "compiler: typed `string[]` local with `path.split('/')` initializer triggers struct-type mismatch"
status: ready
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: arrays
goal: npm-library-support
depends_on: []
related: [1244]
created: 2026-05-02
updated: 2026-05-02
es_edition: ES5
origin: "Surfaced by #1244 Hono Tier 1a stress test. Hono's `splitPath` is typed `(path: string) => string[]`; compiling that signature triggers a Wasm-level type mismatch at instantiation."
---

# #1247 — Typed `string[]` local with `String.prototype.split` initializer triggers struct-type mismatch

## Problem

The natural typed form of Hono's `splitPath` utility:

```ts
export function splitPath(path: string): string[] {
  const paths: string[] = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}
```

compiles successfully but **fails Wasm validation at instantiation**:

```
WebAssembly.instantiate(): Compiling function #6:"splitPath" failed:
struct.get[0] expected type (ref null 6), found local.get of type
(ref null 1) @+2547
```

Two struct types are involved:
- `(ref null 1)` — the type the codegen allocates for the local `paths`
  (likely the local-array struct)
- `(ref null 6)` — the type the codegen expects from the
  `String.prototype.split` host return (likely a vec-of-strings struct)

The two don't match, so the `struct.get[0]` (reading the `length`
field, presumably) fails Wasm validation.

Workaround: type both the local and the function return as `any`, e.g.
`function splitPath(path: any): any { const paths: any = path.split("/"); … }`.
That bypasses the typed-array struct and uses a uniform externref path
that the codegen handles correctly.

## Why it matters

Real npm libraries (lodash, prettier, hono, …) use precise TypeScript
types throughout: `string[]`, `number[]`, `Array<T>`. The workaround of
"type as any" loses all that information at the boundary between the
library and the compiled module. Until this is fixed, the stress tests
for typed libraries have to rewrite signatures.

#1244 (Hono Tier 1a) hit this on the first signature it tried.

## Repro and details

Probe at `.tmp/probe-tier1.mts` in the #1244 PR worktree
(`issue-1244-hono-stress`). The minimal failing case:

```ts
export function splitPath(path: string): string[] {
  const paths: string[] = path.split("/");
  return paths;
}
```

That's enough to trigger the validation error — even without the
`shift()` call.

## Fix sketch

The codegen path that emits `String.prototype.split` is presumably
producing a vec-of-strings struct (`(ref null 6)` in the example) that
doesn't match the type the compiler infers for the local `string[]`.
Either:

- Make the `string[]` type-inference pick the same struct type as
  `__string_split` returns, or
- Add a coercion at the assignment site so the two struct types
  reconcile, or
- Have the host import return externref and let the compiler box/unbox
  uniformly.

A regression test in `tests/issue-1247.test.ts` should compile the
typed form and assert correctness; the existing `tests/string-methods.test.ts`
already covers split semantics on the `any` path.

## Acceptance criteria

1. Minimal repro instantiates and runs correctly.
2. `tests/issue-1247.test.ts` exercises the typed-`string[]` form of
   `path.split("/")`.
3. No regression in `tests/string-methods.test.ts` or `tests/equivalence/`.
4. `tests/stress/hono-tier1.test.ts` Tier 1a can be re-written with the
   natural typed signature and still pass.

## Related

- #1244 — Hono stress test that surfaced this
- #1248 — `typeof x === "string"` guard breaks `substring(start)` (also
  found in #1244)
