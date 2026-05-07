# §20.5 Error Objects (Error, NativeErrors, AggregateError, SuppressedError)

**Spec**: https://tc39.es/ecma262/#sec-error-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Error`, `built-ins/NativeErrors`, `built-ins/AggregateError`, `built-ins/SuppressedError`
**Coverage**: 117 / 199 pass (58.8%) — 82 fail, 0 skip
**Top error buckets**: assertion_fail=35, type_error=31, runtime_error=5

## What the spec requires

Error and the 8 NativeErrors (TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, AggregateError, SuppressedError) construct proper externref instances. .message, .stack, .cause are set.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (Error constructors)`
- `src/codegen/registry`

## Gap

AggregateError 16.0%, SuppressedError 27.3% — `errors` array iteration semantics, constructor coercion of non-iterable errors. Error.prototype.toString custom-toString-overrides not always honored.

## Issues filed / referenced

- [#1339](../plan/issues/sprints/50/1339-*.md)
