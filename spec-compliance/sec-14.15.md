# §14.15 try Statement

**Spec**: https://tc39.es/ecma262/#sec-try-statement
**Status**: ⚠️ partial
**Test262 categories**: `language/statements/try`
**Coverage**: 101 / 201 pass (50.2%) — 99 fail, 1 skip
**Top error buckets**: assertion_fail=82, other=10, null_deref=3

## What the spec requires

try/catch/finally lowers to wasm exception-handling proposal `try_table`. The exception tag holds an externref so JS errors and Wasm errors are interchangeable.

## Current implementation

Files / runtime imports involved:

- `src/codegen/statements.ts`

## Gap

50% pass — many failures are assertion_fail on the caught error type (e.g. expected RangeError, got generic Error). Exception object construction needs more fidelity.
