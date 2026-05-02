---
id: 598
title: "Typed export signatures: avoid externref at module boundary"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: performance
required_by: [600]
files:
  src/codegen/index.ts:
    new:
      - "emit typed export signatures (f64, i32) instead of externref at module boundary"
    breaking:
      - "export function signatures change from externref to concrete types"
---
# #598 — Typed export signatures: avoid externref at module boundary

## Status: review
completed: 2026-03-19

All exported functions use `externref` for parameters and return values, forcing boxing/unboxing at every JS↔Wasm call. V8's JS-to-Wasm wrappers are heavily optimized for primitive types; externref forces the slow generic path.

When TypeScript types are known (`(number, number) => number`), emit `(f64, f64) -> f64` at the Wasm boundary. V8 and SpiderMonkey can then skip boxing entirely.

## Impact
Eliminates 2 indirections per function call for primitive-typed exports.

## Complexity: M

## Implementation Summary

Investigation revealed that the codegen already emits concrete Wasm types for exported functions
with primitive TypeScript types:

- `number` params/returns -> `f64` (not externref)
- `boolean` params/returns -> `i32` (not externref)
- `void` returns -> no result type
- `any`/`string` -> `externref` (correctly, since these need host representation)

The `resolveWasmType` function in `src/codegen/index.ts` already maps TS primitive types to
concrete Wasm types, and these types flow through to the export signatures without any
externref wrapping layer.

Added regression test suite (`tests/typed-export-signatures.test.ts`) with 10 tests verifying:
- WAT signature inspection (f64 for number, i32 for boolean, no externref)
- Runtime correctness (JS calling Wasm exports with concrete types)
- Edge cases (optional params, module globals, void returns, any/string stay externref)

### Files changed
- `tests/typed-export-signatures.test.ts` (new) - 10 regression tests
