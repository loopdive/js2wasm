# §10 Ordinary and Exotic Objects Behaviours

**Spec**: https://tc39.es/ecma262/#sec-ordinary-and-exotic-objects-behaviours
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

Ordinary objects are WasmGC structs with optional prototype field. Function-exotic objects are tagged structs whose call-internal slot is a function reference. Array-exotic objects use a dedicated ArrayStruct with length/elements. String-exotic and Module-namespace objects use externref.

## Current implementation

Files / runtime imports involved:

- `src/codegen/object-ops.ts`
- `src/codegen/class-bodies.ts`
- `src/codegen/property-access.ts`
