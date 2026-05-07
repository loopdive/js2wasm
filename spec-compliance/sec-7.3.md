# §7.3 Operations on Objects

**Spec**: https://tc39.es/ecma262/#sec-operations-on-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Object`
**Coverage**: 1858 / 3411 pass (54.5%) — 1551 fail, 2 skip
**Top error buckets**: assertion_fail=1293, other=83, type_error=69

## What the spec requires

Get / Set / HasProperty / DeleteProperty / OrdinaryDefineOwnProperty are implemented for plain objects via WasmGC struct field access (fast path) or externref host-imports (slow path). CreateDataProperty matches spec for new fields.

## Current implementation

Files / runtime imports involved:

- `src/codegen/object-ops.ts`
- `src/codegen/property-access.ts`
- `src/runtime.ts`

## Gap

Object.defineProperty descriptor semantics are incomplete (467/1131 = 41%). Property attribute flags (configurable/enumerable/writable) are ignored on most paths. CopyDataProperties (for Object.assign / spread) drops getters from source.

## Issues filed / referenced

- [#1335](../plan/issues/sprints/50/1335-*.md)
- [#1336](../plan/issues/sprints/50/1336-*.md)
- [#1337](../plan/issues/sprints/50/1337-*.md)
