# §13.10 Relational Operators

**Spec**: https://tc39.es/ecma262/#sec-relational-operators
**Status**: ⚠️ partial
**Test262 categories**: `language/expressions/instanceof`, `language/expressions/in`, `language/expressions/less-than`, `language/expressions/greater-than`, `language/expressions/less-than-or-equal`, `language/expressions/greater-than-or-equal`
**Coverage**: 175 / 263 pass (66.5%) — 88 fail, 0 skip
**Top error buckets**: other=46, assertion_fail=33, type_error=8

## What the spec requires

Numeric comparisons use Wasm f64/i32 ops directly. String comparison uses host import. instanceof uses prototype-chain walk via host or typed type-tag for known classes.

## Current implementation

Files / runtime imports involved:

- `src/codegen/binary-ops.ts`

## Gap

instanceof on built-in types (Error, Array, etc.) is partial.
