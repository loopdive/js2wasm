---
id: 326
title: "- Array element access out of bounds"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: crash-free
test262_fail: 17
test262_refs:
  - test/language/expressions/assignment/dstr/array-elem-init-evaluation.js
  - test/language/expressions/assignment/dstr/array-elem-init-order.js
  - test/language/expressions/assignment/dstr/array-elem-init-yield-ident-valid.js
  - test/language/expressions/assignment/dstr/array-elem-put-unresolvable-no-strict.js
  - test/built-ins/Array/prototype/indexOf/15.4.4.14-9-9.js
  - test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-6-1.js
  - test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-8-9.js
  - test/built-ins/Array/prototype/splice/15.4.4.12-9-a-1.js
  - test/language/statements/for-of/dstr/const-ary-ptrn-elem-id-init-exhausted.js
  - test/language/statements/for-of/dstr/const-ary-ptrn-elem-id-iter-complete.js
files:
  src/codegen/expressions.ts:
    breaking:
      - "array access: add bounds checking or return undefined for out-of-bounds"
  src/codegen/statements.ts:
    breaking:
      - "array destructuring: handle arrays shorter than destructuring pattern"
---
# #326 -- Array element access out of bounds

## Status: review

17 test262 tests fail with "array element access out of bounds" at runtime. The compiled Wasm accesses an array index beyond its length.

## Error pattern
- RuntimeError: array element access out of bounds

## Likely causes
- Destructuring assignment accessing elements beyond array length without default values
- Array method implementations (indexOf, lastIndexOf, splice) not handling edge cases
- Off-by-one errors in array iteration bounds

## Complexity: M

## Acceptance criteria
- [x] Reduce test262 failures matching this error pattern

## Implementation Summary

Two unchecked `array.get` instructions were found in array destructuring paths that could trap when the destructuring pattern has more elements than the array:

1. **`src/codegen/expressions.ts:2008`** -- Function parameter array destructuring (`function f([a, b, c]: number[])`) used a raw `array.get` without bounds checking. Replaced with `emitBoundsCheckedArrayGet()`.

2. **`src/codegen/statements.ts:952`** -- Nested array binding pattern destructuring within object destructuring used raw `array.get`. Replaced with `emitBoundsCheckedArrayGet()`.

The existing `emitBoundsCheckedArrayGet` helper (expressions.ts:17228) saves the array ref and index to locals, compares `idx < array.len` using unsigned comparison (which also catches negative indices), and returns a type-appropriate default value (NaN for f64, 0 for i32, ref.null for refs) when out of bounds.

Other `array.get` call sites were already protected -- either by `emitBoundsCheckedArrayGet`, by `isSafeBoundsEliminated` (loop-guarded access), or by explicit loop bounds checks.

### Files changed
- `src/codegen/expressions.ts` -- bounds-checked function param array destructuring
- `src/codegen/statements.ts` -- bounds-checked nested array binding destructuring
- `tests/issue-326.test.ts` -- added 2 tests for function parameter destructuring edge cases
