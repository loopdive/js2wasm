# §13 ECMAScript Language: Expressions (overview)

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-language-expressions
**Status**: ⚠️ partial
**Test262 categories**: `language/expressions`
**Coverage**: 6772 / 11036 pass (61.4%) — 3714 fail, 550 skip
**Top error buckets**: assertion_fail=2000, other=541, runtime_error=432

## What the spec requires

All expression productions in §13 have Wasm IR lowerings. Numeric ops use typed Wasm (f64/i32) when types are known, externref + host helpers otherwise. Optional-chaining, nullish-coalescing, and template-strings are fully implemented.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts`
- `src/codegen/binary-ops.ts`

## Gap

Coverage 6772/11036 = 61.4%. Worst sub-buckets: assignment (54.4%), yield (25.4%), await (45.5%). Largest absolute regression source: assertion_fail in arithmetic edge cases (precision, signed-zero, NaN propagation).
