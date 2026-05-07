# §13.5 Unary Operators

**Spec**: https://tc39.es/ecma262/#sec-unary-operators
**Status**: ⚠️ partial
**Test262 categories**: `language/expressions/typeof`, `language/expressions/delete`, `language/expressions/void`, `language/expressions/unary-plus`, `language/expressions/unary-minus`, `language/expressions/logical-not`, `language/expressions/bitwise-not`, `language/expressions/postfix-increment`, `language/expressions/postfix-decrement`, `language/expressions/prefix-increment`, `language/expressions/prefix-decrement`
**Coverage**: 180 / 302 pass (59.6%) — 104 fail, 18 skip
**Top error buckets**: other=58, assertion_fail=36, type_error=5

## What the spec requires

All 11 unary operators are implemented with typed and externref paths. typeof: returns interned strings via inline lookup. delete: handles property removal via host import for externref, struct-field clear for typed.

## Current implementation

Files / runtime imports involved:

- `src/codegen/typeof-delete.ts`
- `src/codegen/expressions.ts`
