# §28.1 The Reflect Object

**Spec**: https://tc39.es/ecma262/#sec-reflect-object
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Reflect`
**Coverage**: 70 / 153 pass (45.8%) — 83 fail, 0 skip
**Top error buckets**: assertion_fail=77, runtime_error=2, type_error=2

## What the spec requires

Reflect.{apply, construct, defineProperty, deleteProperty, get, getOwnPropertyDescriptor, getPrototypeOf, has, isExtensible, ownKeys, preventExtensions, set, setPrototypeOf} mapped to host.

## Current implementation

Files / runtime imports involved:

- `src/codegen/registry`
- `src/runtime.ts`

## Gap

70/153 (45.8%). 77 assertion_fail — Reflect.\* are direct mirrors of [[InternalMethod]]s, and our internal-method semantics gaps surface here too.
