# §15 ECMAScript Language: Functions and Classes (overview)

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-language-functions-and-classes
**Status**: ⚠️ partial
**Test262 categories**: `language/function-code`
**Coverage**: 150 / 217 pass (69.1%) — 67 fail, 0 skip
**Top error buckets**: assertion_fail=31, other=23, type_error=8

## What the spec requires

Function definitions (declarations, expressions, arrow), generator and async variants, and class declarations/expressions are implemented.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts`
- `src/codegen/class-bodies.ts`
