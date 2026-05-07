# §13.11 Equality Operators

**Spec**: https://tc39.es/ecma262/#sec-equality-operators
**Status**: ⚠️ partial
**Test262 categories**: `language/expressions/equals`, `language/expressions/does-not-equals`, `language/expressions/strict-equals`, `language/expressions/strict-does-not-equals`
**Coverage**: 90 / 145 pass (62.1%) — 55 fail, 0 skip
**Top error buckets**: other=37, assertion_fail=13, type_error=4

## What the spec requires

Strict equality on typed values: direct Wasm op. Abstract equality (==): inlined type-table emits the §7.2.13 algorithm. NaN, +0/-0 handled correctly via f64.eq.

## Current implementation

Files / runtime imports involved:

- `src/codegen/binary-ops.ts`
