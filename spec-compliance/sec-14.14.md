# §14.14 throw Statement

**Spec**: https://tc39.es/ecma262/#sec-throw-statement
**Status**: ✅ conforming
**Test262 categories**: `language/statements/throw`
**Coverage**: 14 / 14 pass (100.0%) — 0 fail, 0 skip

## What the spec requires

throw lowers to wasm `throw $exn`. Exception payload uses an externref-tagged exception.

## Current implementation

Files / runtime imports involved:

- `src/codegen/statements.ts`
