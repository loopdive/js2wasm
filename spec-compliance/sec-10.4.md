# §10.4 Built-in Exotic Object Internal Methods and Slots

**Spec**: https://tc39.es/ecma262/#sec-built-in-exotic-object-internal-methods-and-slots
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Array`, `built-ins/String`
**Coverage**: 2187 / 4304 pass (50.8%) — 2097 fail, 20 skip
**Top error buckets**: assertion_fail=1223, other=300, wasm_compile=259

## What the spec requires

Array exotic objects: length-as-property is auto-updated on element set; index-property writes extend the underlying ArrayStruct.elements array. String exotic objects: integer-indexed property access returns a single-character externref. Module-namespace exotics use frozen-style host objects.

## Current implementation

Files / runtime imports involved:

- `src/codegen/array-methods.ts`
- `src/codegen/string-ops.ts`

## Gap

Array.prototype methods coverage 45.7% — many tests fail on assertion_fail (custom-class arrays, non-extensible array, holes-in-array semantics).

## Issues filed / referenced

- [#1338](../plan/issues/sprints/50/1338-*.md)
