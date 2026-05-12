# §15.1 Parameter Lists

**Spec**: https://tc39.es/ecma262/#sec-parameter-lists
**Status**: ❌ not implemented
**Test262 categories**: `language/rest-parameters`
**Coverage**: 3 / 11 pass (27.3%) — 8 fail, 0 skip
**Top error buckets**: wasm_compile=3, assertion_fail=2, negative_test_fail=1

## What the spec requires

Default-valued, rest, and destructuring parameters are all supported. Default-evaluation is lazy (only when the call site omits an argument). f64 default sentinel: 0x7FF00000DEADC0DE.

## Current implementation

Files / runtime imports involved:

- `src/codegen/destructuring-params.ts`

## Gap

Rest params 27.3% — failures on rest-param destructuring with iterators. wasm_compile errors suggest array-coercion type-mismatch.
