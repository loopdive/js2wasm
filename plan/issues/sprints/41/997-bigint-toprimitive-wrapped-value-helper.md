---
id: 997
title: "BigInt ToPrimitive/wrapped-value helper emits i64 into externref __call_fn_0 wrapper (55 CE)"
status: done
created: 2026-04-07
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: core-semantics
test262_ce: 55
---
# #997 -- BigInt ToPrimitive/wrapped-value helper emits i64 into externref `__call_fn_0` wrapper (55 CE)

## Problem

The latest full recheck (`benchmarks/results/test262-results-20260407-111308.jsonl`)
contains **55 compile errors** in a newly clarified invalid-binary subcluster:

```text
invalid Wasm binary (WebAssembly.instantiate(): Compiling function #...:"__call_fn_0"
failed: type error in fallthru[0] (expected externref, got i64) ...) [in __call_fn_0()]
```

The new #989 enrichment makes this bucket source- and WAT-localized instead of
leaving it inside the generic invalid-binary umbrella.

## Representative samples

- `test/language/expressions/bitwise-or/bigint-toprimitive.js`
  - `L1:1 ... __call_fn_0 ... expected externref, got i64 @+4255`
- `test/language/expressions/right-shift/bigint-wrapped-values.js`
  - `L1:1 ... __call_fn_0 ... expected externref, got i64 @+1785`
- `test/language/expressions/addition/bigint-wrapped-values.js`
  - `L1:1 ... __call_fn_0 ... expected externref, got i64 @+1785`
- `test/language/expressions/strict-equals/bigint-and-object.js`
  - `L1:1 ... __call_fn_0 ... expected externref, got i64 @+2639`
- `test/built-ins/BigInt/asIntN/bigint-tobigint-wrapped-values.js`
  - `L1:1 ... __call_fn_0 ... expected externref, got i64 @+2657`

## WAT / source clue

All representative cases point at the same wrapper shape:

```wat
(func $__call_fn_0
  (local $__any anyref)
  (local $__struct (ref null ...))
  (local $__funcref funcref)
  local.get 0
  any.convert_extern
  local.set 1
  local.get 1
  ...)
```

The wrapper expects to stay on the externref/anyref path but one branch now
falls through with raw `i64`, which is consistent with BigInt values bypassing
boxing on the way into a helper call boundary.

## ECMAScript spec reference

- [§7.1.1 ToPrimitive](https://tc39.es/ecma262/#sec-toprimitive) — BigInt values are already primitives; bypass @@toPrimitive
- [§21.2 BigInt Objects](https://tc39.es/ecma262/#sec-bigint-objects) — BigInt is a primitive, not an object; wrapping produces a BigInt wrapper object


## Root cause

This looks like a focused BigInt boxing/coercion bug in wrapper/helper emission,
not a generic binary corruption issue:

1. the failing function is almost always `__call_fn_0`
2. the tests are all BigInt ToPrimitive / wrapped-value families
3. the validator complains about `i64` flowing into an externref-typed fallthrough

This is likely a follow-up to earlier BigInt coercion fixes (#237 / #659), but
in a narrower wrapper-export path.

## Suggested fix

1. Trace `emitClosureCallExport()` / helper-wrapper generation for BigInt return
   and argument paths
2. Ensure BigInt/i64 values are boxed before any externref-facing helper branch
3. Add regression coverage for:
   - `*-bigint-toprimitive.js`
   - `*-bigint-wrapped-values.js`
   - `BigInt/asIntN` / `BigInt/asUintN` wrapped-value variants

## Acceptance criteria

- eliminate the 55 `__call_fn_0 ... expected externref, got i64` compile errors
- BigInt helper/wrapper call paths validate without falling through with raw `i64`
