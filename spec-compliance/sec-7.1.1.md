# §7.1.1 ToPrimitive

**Spec**: https://tc39.es/ecma262/#sec-toprimitive
**Status**: ⚠️ partial
**Test262 categories**: covered indirectly by every operator/coercion test
**Coverage**: not directly measured

## What the spec requires

ToPrimitive is implemented inline at every coercion site. The fast path emits direct numeric/string conversions; the slow path falls back to host-imported \_\_to_primitive when the operand is externref of unknown type.

## Current implementation

Files / runtime imports involved:

- `src/codegen/type-coercion.ts (coerceType)`
- `src/codegen/expressions.ts (binary ops)`

## Gap

The @@toPrimitive (Symbol.toPrimitive) hook is partially supported. Object → primitive does not always honor user-defined toString/valueOf override order. Symbol → number/string does not throw TypeError as required by spec.
