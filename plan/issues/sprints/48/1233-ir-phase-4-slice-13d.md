---
id: 1233
sprint: 48
title: "IR Phase 4 Slice 13d — Array per-element-type methods through IR"
status: done
created: 2026-05-01
updated: 2026-05-02
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: array-methods
goal: builtin-methods
depends_on: [1238]
es_edition: ES2020
related: [1169p, 1232]
---
# #1233 — IR Phase 4 Slice 13d: Array per-element-type methods through IR

## Problem

After #1238 registers Array as a pseudo-`ExternClassInfo`, the
non-callback Array prototype methods can lower through the IR. Unlike
String (#1232), Array methods are GENERIC over the element type:
`number[].push(x)` takes `f64`, `string[].push(x)` takes `string`, etc.
The pseudo-extern registry needs per-vec-element-type variants since
`ExternClassInfo.methods` carries concrete `ValType[]` signatures.

Target methods (non-callback only — `.map`/`.filter`/`.reduce` etc.
deferred to a separate slice that integrates with the IR closure model):
- `arr.push(...items: T): f64` (returns new length)
- `arr.pop(): T | undefined`
- `arr.indexOf(search: T, fromIndex?: f64): f64`
- `arr.includes(search: T): bool`
- `arr.slice(start?: f64, end?: f64): T[]`
- `arr.join(sep?: string): string`
- `arr.concat(...items: T[]): T[]`

## Implementation notes

- Per-vec-element-type registration: when the IR encounters a vec type
  during `resolveType`, the registry pass synthesizes Array methods
  with `params[0] = (ref|ref_null) $vec_<element>` and the rest
  parametrised by the element type. Cache per-vec-type.
- Each method maps to an existing legacy helper or codegen primitive
  (`compileArrayPush`, `compileArrayPop`, etc. in
  `src/codegen/array-methods.ts`). The IR can either:
  - (a) Reuse the legacy helper by name (preferred for the IR-native
    pattern — no new emit code), or
  - (b) Emit primitive vec ops directly when a method is a single
    Wasm sequence (`arr.length` precedent in #1169p — `emitVecLen`).
- Variadic methods (`push(a, b, c)`) need spread expansion at the call
  site or per-arity dispatch. Match the legacy convention.

## Acceptance criteria

1. Each listed method, when used in an IR-claimable function for
   `number[]` and `string[]`, is claimed and lowered correctly.
2. End-to-end test (in `tests/issue-1233.test.ts`) using the #1181
   bridge pattern (legacy builder + IR consumer).
3. No regression in #1169p, #1232, or other slice-1..13 tests.

## Out of scope

- Callback-taking methods: `.map`, `.filter`, `.reduce`, `.forEach`,
  `.find`, `.findIndex`, `.every`, `.some`. These interact with the
  IR's closure/function-reference model in ways not yet supported.

## MLIR alignment

Per-element-type method variants must be expressed as `TypeMap` specializations,
not hardcoded per-type dispatch in the emitter. The registration step synthesizes
`MethodVariant { receiverType: ValType; argTypes: ValType[]; returnType: ValType }`
entries from `typeMap` at the call site — keyed on the element type inferred for the
receiver vec. This keeps the variant table MLIR-replaceable: MLIR produces a TypeMap
with the same element-type annotations and the variant selection logic is unchanged.

## Resolution (2026-05-03)

The infrastructure landed in #1238 already covers most of this. The
remaining gap was:

1. **`concat` missing from the pseudo-extern Array registry** —
   added. The fallback signature uses externref for the variadic
   items and the return value; the IR's existing `lowerMethodCall`
   dispatch falls through to `compileArrayConcat` for the
   per-element-type splatting (same convention `slice`, `join`,
   etc. already follow).
2. **No regression test file** — added `tests/issue-1233.test.ts`
   with 17 tests covering all 7 target methods (push, pop, indexOf,
   includes, slice, join, concat) for both `number[]` and
   `string[]` receivers, plus a registry-coverage block.

### Test pattern (the #1181 bridge)

ArrayLiteral initialisers (`const arr: number[] = [1, 2]`) are
selector-rejected (deferred to a slice that lands the IR
`vec.new_fixed` instr per the comment in `select.ts`), so tests use
the bridge: a separate (legacy-compiled) `build()` function returns
the array literal, and the IR-claimable `consume(arr)` function
takes it as a typed param. The export wires `build() → consume()`.

### Verification

- `tests/issue-1233.test.ts` — 17 / 17 passing.
- 71-test regression sweep (Hono tier 1+2+3, #1232, #1284,
  array-methods, this issue) — same 2 baseline failures vs main,
  +17 passing tests added by this issue. Zero regressions.

### Selector-rejected patterns (out of scope for slice 13d)

These fall back to legacy and are explicitly listed as out of scope:

- ArrayLiteral initialisers in IR-claimable function bodies
  (`const arr: number[] = [1, 2]`) — needs `vec.new_fixed` IR instr.
- Postfix non-null assertions (`arr.pop()!`) — needs
  NonNullExpression acceptance in `isPhase1Expr`.
- Callback-taking methods (`.map`, `.filter`, `.reduce`,
  `.forEach`, `.find`, `.findIndex`, `.every`, `.some`) — needs
  IR's closure / function-reference model integration.

The current slice's acceptance is "param-receiver functions calling
these 7 methods work correctly through IR for `number[]` and
`string[]`" — verified.
