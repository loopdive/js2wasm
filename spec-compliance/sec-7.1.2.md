# §7.1.2 ToBoolean

**Spec**: https://tc39.es/ecma262/#sec-toboolean
**Status**: ✅ conforming
**Test262 categories**: covered by language/expressions/conditional, language/statements/if
**Coverage**: not directly measured

## What the spec requires

ToBoolean is fully inlined. f64 → bool: `f64.eq 0 | f64.ne f64` (NaN-safe). i32 → bool: `i32.ne 0`. Object/string ref → bool: `ref.is_null` plus length check for strings. BigInt 0n is correctly false.

## Current implementation

Files / runtime imports involved:

- `src/codegen/type-coercion.ts`
- `src/codegen/expressions.ts`
