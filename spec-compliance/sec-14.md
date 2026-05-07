# §14 ECMAScript Language: Statements and Declarations (overview)

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-language-statements-and-declarations
**Status**: ⚠️ partial
**Test262 categories**: `language/statements`
**Coverage**: 5925 / 9337 pass (63.5%) — 3205 fail, 207 skip
**Top error buckets**: assertion_fail=2048, runtime_error=322, type_error=258

## What the spec requires

All statement productions (block, let/const/var, if/switch, try, for/for-in/for-of/for-await, throw, return, break/continue, labelled) are implemented.

## Current implementation

Files / runtime imports involved:

- `src/codegen/statements.ts`

## Gap

Coverage 5925/9337 = 63.5%. Worst sub-buckets: try (50%), for-of (48%), with (0% — N/A by design).

## Issues filed / referenced

- [#1347](../plan/issues/sprints/50/1347-*.md)
- [#1348](../plan/issues/sprints/50/1348-*.md)
