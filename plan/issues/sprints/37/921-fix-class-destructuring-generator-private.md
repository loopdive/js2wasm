---
id: 921
title: "Fix class destructuring generator/private-method codegen that now yields Wasm type mismatches"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: core-semantics
files:
  src/codegen/:
    investigate:
      - "Trace class destructuring lowering for generator/private-method/default-parameter cases"
      - "Find the typed value flow that feeds externref into numeric arithmetic during Wasm generation"
  tests/:
    add:
      - "Add focused regression coverage for the failing class destructuring cases"
  benchmarks/results/:
    reference:
      - "Use the April 1 and April 3 test262 result files to confirm the class destructuring regression cluster"
---
# #921 -- Fix class destructuring generator/private-method codegen that now yields Wasm type mismatches

## Problem

Since the April 1 baseline, a distinct regression cluster appeared in class destructuring cases involving generator/private methods.

Observed drift:

- `8` regressions under `language/statements/class/dstr/...`
- `8` regressions under `language/expressions/class/dstr/...`
- all shifted from runtime `fail` to `compile_error`

Representative failing tests:

- `test/language/statements/class/dstr/async-private-gen-meth-dflt-ary-ptrn-elem-ary-rest-iter.js`
- `test/language/expressions/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elem-ary-rest-iter.js`

Representative current compile error:

```text
WebAssembly.instantiate(): ... f64.add[0] expected type f64, found global.get of type externref
```

This looks like a real backend typing bug in the lowering path, not just a spec-behavior mismatch.

## Goal

Restore type-correct Wasm emission for the affected class destructuring generator/private-method paths.

## Requirements

1. Isolate the common lowering path shared by the failing class destructuring tests
2. Find where an `externref` value is being fed into numeric arithmetic
3. Fix the backend typing/value-selection bug without broadening numeric coercion unsafely
4. Add focused regression coverage for representative statement and expression cases
5. Re-run targeted test262 coverage and confirm the compile errors disappear for those cases

## Acceptance criteria

- representative class destructuring generator/private-method failures no longer produce Wasm type mismatch compile errors
- the fix is backed by targeted regression coverage
- the backend path responsible for the bad typed value flow is documented or made clearer in code

## Implementation Summary

### Root Cause

Raw body swaps (`fctx.body = newArray`) in generator method compilation and switch statement compilation bypassed the `savedBodies` tracking in `FunctionContext`. When `addStringConstantGlobal` was called during inner body compilation, `fixupModuleGlobalIndices` (in `src/codegen/registry/imports.ts`) traverses `ctx.currentFunc.savedBodies` to shift global indices — but the outer body wasn't in `savedBodies` because the swap was done manually instead of through `pushBody`/`popBody`.

This caused `global.get` instructions in the outer body to reference stale indices (pointing at `externref` string constant globals instead of `f64` module globals), producing the `f64.add[0] expected type f64, found global.get of type externref` error.

### Fix

Replaced raw body swaps with `pushBody`/`popBody` (from `src/codegen/context/bodies.ts`) in 4 locations:

1. **Class generator method body** (`src/codegen/index.ts` ~line 12793)
2. **Standalone generator function body** (`src/codegen/index.ts` ~line 13812)
3. **Switch case check body** (`src/codegen/statements.ts` ~line 3848)
4. **Switch case statement body** (`src/codegen/statements.ts` ~line 3949)

### Test Results

- **Equivalence tests**: 10/10 pass (private-class-members + generator-methods)
- **Non-async class dstr tests**: 4/4 compile+instantiate without CE (was CE before fix)
- **Async class dstr tests**: 4/4 no longer have `f64.add` CE; async variants have a pre-existing separate CE (`extern.convert_any` between `struct.new` and private method call) that was always masked by the first CE — this is a different bug, not a regression from this issue

### Notes

- The async variant's second CE is pre-existing on main (confirmed by building main's compiler). It should be tracked as a separate issue.
- The `pushBody`/`popBody` pattern is the correct way to do any temporary body swap, as it keeps the body visible to `fixupModuleGlobalIndices`.

