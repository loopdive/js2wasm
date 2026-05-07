# §6 ECMAScript Data Types and Values

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-data-types-and-values
**Status**: ⚠️ partial
**Test262 categories**: `language/types`
**Coverage**: 83 / 113 pass (73.5%) — 30 fail, 0 skip
**Top error buckets**: other=13, assertion_fail=8, type_error=8

## What the spec requires

All eight ECMAScript types are represented: undefined, null, boolean, string, symbol, number (f64/i32 typed locals), bigint (host import), and object (WasmGC structs / externref). Type checks are mostly handled at compile time via TypeScript's type inference; runtime checks use ref.test on WasmGC structs.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts`
- `src/runtime.ts`

## Gap

BigInt arithmetic uses host-import fallbacks rather than i64-native lowering; some primitive ↔ object coercion paths are not symmetric (Symbol → primitive throws but isn't always caught at the right point). 30/113 fail, mostly Symbol coercion edge cases.
