# §7.2 Testing and Comparison Operations

**Spec**: https://tc39.es/ecma262/#sec-testing-and-comparison-operations
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

IsCallable, IsConstructor, SameValue, SameValueZero, IsArray are all inlined. AbstractEqualityComparison and StrictEqualityComparison emit Wasm comparisons directly for typed locals; mixed-type uses runtime helpers.

## Current implementation

Files / runtime imports involved:

- `src/codegen/binary-ops.ts`
- `src/codegen/expressions.ts`

## Gap

IsConstructor on arrow functions / methods returns true incorrectly in a few paths (used by `new` checks).
