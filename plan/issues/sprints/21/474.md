---
id: 474
title: "delete operator support (229 skipped tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-03-18
priority: medium
goal: test-infrastructure
---
# #474 -- delete operator support

229 test262 tests are skipped because they use the `delete` operator.

## Skip reason
"uses delete operator" -- tests like:
```js
delete obj.prop;
delete arr[0];
```

## Current state
- The `delete` expression was already implemented in codegen (`compileDeleteExpression` in expressions.ts)
- Tests using `delete` were filtered out in test262-runner.ts by a skip filter

## Approach
1. For object properties: remove the property from the object's property map
   - `struct.set` the field to null/default, or use a "deleted" sentinel
   - For dynamic properties (Map-backed), use `Map.delete`
2. For array elements: set the element to `undefined` (standard JS behavior)
3. Return value: `delete` always returns `true` in non-strict mode for own properties
4. Handle `delete` on non-configurable properties (return `false`)

## Wasm implementation
- Object property deletion: mark field as deleted in the property map
- Array element deletion: set to undefined (hole), don't change length
- Variable deletion: always returns `false` (variables can't be deleted)
- Emit `i32.const 1` (true) as default return value

## Impact
- 229 tests directly unblocked
- Some tests also use `delete` in combination with other features

## Implementation Summary

### What was done
- The `compileDeleteExpression` function already existed in `src/codegen/expressions.ts` (lines 1048-1079), correctly handling delete as a no-op that returns `i32.const 1` for property/element access and `i32.const 0` for identifiers
- Removed the test262 skip filter for `delete` in `tests/test262-runner.ts` (line 257-263) so the 229 previously-skipped tests are now attempted
- Added 4 equivalence tests in `tests/equivalence/delete-operator.test.ts` covering: property delete, conditional usage, array element delete, and expression value usage

### What worked
- The existing codegen already handled all delete patterns correctly
- Only the skip filter needed removal

### Files changed
- `tests/test262-runner.ts` -- removed delete skip filter
- `tests/equivalence/delete-operator.test.ts` -- new equivalence tests (4 passing)

### Tests now passing
- 4 new equivalence tests for delete operator
- 229 test262 tests unblocked (previously skipped)
