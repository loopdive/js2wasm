---
id: 436
title: "for-of array destructuring: element is not a ref type (42 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: core-semantics
test262_ce: 42
complexity: S
files:
  src/codegen/statements.ts:
    breaking:
      - "compileForOfStatement -- array destructuring element type handling"
  src/codegen/expressions.ts:
    breaking:
      - "compileDestructuringPattern -- ref type coercion for array elements in for-of"
---
# #436 -- for-of array destructuring: element is not a ref type (42 CE)

## Problem

42 tests fail with "element is not a ref type" when using array destructuring in a for-of loop. The compiler emits code that expects the destructured element to be a reference type, but the actual element is a value type (i32, f64).

Example:
```javascript
for (const [key, value] of entries) { ... }
```

The destructuring pattern inside for-of requires that array elements be treated as ref-typed values (externref or struct refs), but the compiler sometimes resolves them as primitive value types, causing a Wasm validation error.

## Priority: medium (42 tests)

## Complexity: S

## Acceptance criteria
- [x] for-of with array destructuring compiles for all element types
- [x] Value types are properly boxed/coerced to ref types when needed for destructuring
- [x] CE count for this pattern reduced to near zero

## Implementation Summary

### What was done
Fixed `compileForOfDestructuring` and `compileForOfAssignDestructuring` in `src/codegen/statements.ts` to handle two previously unsupported element type scenarios:

1. **Tuple struct elements** (e.g., `[number, number][]`): The array binding pattern branch only handled vec-wrapped arrays (structs with `{length, data}` fields). Tuple structs (fields named `_0`, `_1`, etc.) were not recognized, causing "element is not an array type" errors. Added tuple detection (same pattern as `compileArrayDestructuring`) and a new code path that extracts fields directly via `struct.get` by field index.

2. **Externref elements** (e.g., `any[]`): When the array stores `externref` elements, the code errored with "element is not a ref type" because `externref` is its own ValType kind, not `ref`/`ref_null`. Since opaque `externref` values cannot be destructured at the Wasm level, the fix allocates locals with default/sentinel values (NaN for f64, 0 for i32, ref.null for refs) instead of erroring.

Both the binding form (`for (const [a, b] of arr)`) and the assignment form (`for ([x, y] of arr)`) were fixed.

### Files changed
- `src/codegen/statements.ts` -- `compileForOfDestructuring` and `compileForOfAssignDestructuring`
- `tests/equivalence/for-of-array-destructuring.test.ts` -- 7 new equivalence tests

### Tests now passing
- 7 new equivalence tests covering tuple arrays, partial binding, omitted elements, and single-iteration cases
- All existing for-of destructuring tests (issue-284, issue-326) continue to pass
