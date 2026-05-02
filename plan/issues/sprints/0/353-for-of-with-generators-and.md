---
id: 353
title: "- For-of with generators and custom iterators"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-03-16
priority: medium
feasibility: medium
goal: iterator-protocol
test262_skip: 152
test262_categories:
  - language/statements/for-of
files:
  src/codegen/statements.ts:
    new: []
    breaking:
      - "compileForOfStatement: integrate with generator/iterator protocol"
---
# #353 -- For-of with generators and custom iterators

## Status: review

152 tests use for-of with generators or custom iterator objects. Generator support exists but for-of doesn't integrate with the iterator protocol yet. Also includes for-of with object destructuring from arrays.

## Details

Currently for-of works with arrays but not with generators or custom iterators:
```javascript
function* gen() { yield 1; yield 2; yield 3; }
for (const x of gen()) { ... }  // should work

var iterable = { [Symbol.iterator]() { return { next() { ... } }; } };
for (const x of iterable) { ... }  // should work
```

Implementation:
1. Check if the for-of target is an array -- use existing fast path
2. Otherwise, call the iterator protocol: get `[Symbol.iterator]()`, then loop calling `.next()`
3. Check `.done` property of the result; if false, extract `.value`
4. Handle `break`/`continue`/`return` by calling `.return()` on the iterator if it exists

Depends on #153 (generator improvements) for generator-specific iteration.

## Complexity: M

## Acceptance criteria
- [x] for-of works with generator functions
- [x] for-of works with custom iterator objects (via iterator protocol host imports)
- [x] break/continue in for-of properly exits the loop
- [x] 152 previously skipped tests are now attempted

## Implementation Summary

### What was done
The `compileForOfIterator` function in `src/codegen/statements.ts` already implemented the iterator protocol correctly via host imports (`__iterator`, `__iterator_next`, `__iterator_done`, `__iterator_value`). The `compileForOfStatement` dispatcher correctly routes non-array iterables (including generators) to this path. The actual issues preventing for-of with generators from working were:

1. **Test helper missing imports**: `tests/equivalence/helpers.ts` had a hardcoded list of host import stubs that did not include generator imports (`__gen_create_buffer`, `__gen_push_f64`, `__gen_push_ref`, `__create_generator`, etc.) or iterator protocol imports (`__iterator`, `__iterator_next`, `__iterator_done`, `__iterator_value`). These were added.

2. **Overly broad skip filter**: `tests/test262-runner.ts` had a skip filter that prevented all for-of tests involving generators, `Symbol.iterator`, `[Symbol`, or `.next()` from running. This skip was removed since the iterator protocol path works correctly.

### What worked
- The existing `compileForOfIterator` function handles the full iterator protocol loop correctly
- Generator objects created by `__create_generator` implement `[Symbol.iterator]()` returning `this`, so the iterator protocol works seamlessly
- break/continue work correctly via the existing block/loop nesting with breakStack/continueStack

### Files changed
- `tests/equivalence/helpers.ts` -- Added generator and iterator protocol host import stubs
- `tests/test262-runner.ts` -- Removed for-of generator/iterator skip filter
- `tests/equivalence/for-of-generator.test.ts` -- New: 5 equivalence tests for for-of with generators
- `plan/issues/sprints/0/353.md` -- Updated issue status
- `plan/log/dependency-graph.md` -- Updated issue status
