# §20.4 Symbol Objects

**Spec**: https://tc39.es/ecma262/#sec-symbol-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Symbol`
**Coverage**: 53 / 98 pass (54.1%) — 45 fail, 0 skip
**Top error buckets**: type_error=20, assertion_fail=18, null_deref=2

## What the spec requires

Symbols are externref host objects. Well-known symbols (Symbol.iterator, Symbol.asyncIterator, Symbol.toPrimitive, Symbol.toStringTag, Symbol.match, Symbol.replace, Symbol.split, Symbol.search) are interned at module init.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (host import)`
- `src/codegen/registry`

## Gap

53/98 (54.1%) — TypeErrors on Symbol → string/number coercion (must throw, currently returns NaN/'Symbol()'). Symbol.for / Symbol.keyFor: partial.
