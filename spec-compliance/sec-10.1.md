# §10.1 Ordinary Object Internal Methods and Slots

**Spec**: https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Object/getPrototypeOf`, `built-ins/Object/setPrototypeOf`, `built-ins/Object/getOwnPropertyDescriptor`, `built-ins/Object/defineProperty`, `built-ins/Object/preventExtensions`, `built-ins/Object/freeze`, `built-ins/Object/seal`, `built-ins/Object/isExtensible`
**Coverage**: 964 / 1717 pass (56.1%) — 751 fail, 2 skip
**Top error buckets**: assertion_fail=671, other=33, runtime_error=22

## What the spec requires

[[GetPrototypeOf]], [[SetPrototypeOf]], [[GetOwnProperty]], [[DefineOwnProperty]] are implemented via host imports for externref objects and via struct field access for typed objects.

## Current implementation

Files / runtime imports involved:

- `src/codegen/object-ops.ts`
- `src/runtime.ts`

## Gap

[[Extensible]] flag (preventExtensions/freeze/seal) is not enforced for typed structs — we don't have a hidden 'extensible' bit. Property attributes (writable/configurable/enumerable) are not tracked per property except via host fallback.
