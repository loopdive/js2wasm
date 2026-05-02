---
id: 734
title: "- Array method correctness (343 tests)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-03-25
priority: medium
feasibility: medium
goal: iterator-protocol
test262_fail: 343
files:
  src/codegen/array-methods.ts:
    modify:
      - "Array method correctness — externref support, reduceRight, NaN includes"
---
# #734 -- Array method correctness (343 tests)

## Status: done

## Problem

343 test262 tests under built-ins/Array/prototype fail with assertion errors, meaning array methods run but produce wrong results.

### Likely affected methods
- map, filter, reduce, forEach (callback behavior)
- splice, slice, concat (index edge cases)
- indexOf, includes, find, findIndex (comparison semantics)
- sort (comparison function, stability)
- flat, flatMap (depth handling)
- Array.from (iterable conversion)

### What needs to happen

1. Sample failing tests grouped by Array method
2. Fix the most impactful methods first
3. Ensure spec-compliant handling of: sparse arrays, negative indices, length > 2^32-1, deleted elements during iteration

## Complexity: L (>400 lines, many methods)

## Implementation Summary

**Commit**: 4c32461d — `fix: improve Array method correctness — externref support, reduceRight, NaN includes (#734)`

**What was done**: Fixed externref support in array methods, corrected reduceRight implementation, fixed NaN handling in Array.includes. 213 insertions, 26 deletions in array-methods.ts.

**Files changed**: `src/codegen/array-methods.ts`
