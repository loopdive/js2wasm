# §7 Abstract Operations (overview)

**Spec**: https://tc39.es/ecma262/#sec-abstract-operations
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

Abstract operations are inlined into Wasm IR by `coerceType()` (type-coercion.ts) and direct emission in expressions.ts. There is no centralized 'AbstractOps' module — each operator implements ToNumber/ToString/ToPrimitive ad hoc.

## Current implementation

Files / runtime imports involved:

- `src/codegen/type-coercion.ts`
- `src/codegen/expressions.ts`
- `src/runtime.ts`

## Gap

ToPrimitive does not always invoke @@toPrimitive (only valueOf/toString in many places). Symbol → primitive does not always throw TypeError. ToNumber on objects-with-Symbol.toPrimitive returning non-primitive does not throw. Tracked under sub-sections.
