# §13.15 Assignment Operators

**Spec**: https://tc39.es/ecma262/#sec-assignment-operators
**Status**: ⚠️ partial
**Test262 categories**: `language/expressions/assignment`, `language/expressions/compound-assignment`, `language/expressions/logical-assignment`
**Coverage**: 604 / 1017 pass (59.4%) — 363 fail, 50 skip
**Top error buckets**: assertion_fail=273, other=50, type_error=17

## What the spec requires

Simple, compound (`+=` etc.), and logical (`&&=`, `||=`, `??=`) assignment are implemented. Destructuring assignment is implemented via desugaring to GetIterator + sequential element binding.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts (compileAssignment)`

## Gap

Destructuring with default values that throw: error context lost. Compound assignment on member: getter side-effects may be observed twice.
