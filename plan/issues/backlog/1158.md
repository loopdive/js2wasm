---
id: 1158
title: "destructureParamArray fallback eagerly consumes iterators via Array.from — violates 13.3.3.6 for empty pattern []"
status: ready
created: 2026-04-21
updated: 2026-04-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
---
# #1158 — `__array_from_iter` eagerly consumes iterator in array destructuring fallback

## Problem

`destructureParamArray` (src/codegen/destructuring-params.ts ~L584-588) emits a
fallback that calls `__array_from_iter`, which in turn calls
`Array.from(iter)` on the argument. This eagerly materializes every
iterator element into a JS array so that `__extern_length` /
`__extern_get_idx` can operate on it.

This is over-consumption for patterns that should NOT pull any iterator
elements:

- Empty array pattern `[]` — per ECMAScript 13.3.3.6, must call
  `GetIterator` on the source, then immediately `IteratorClose`
  (`iter.return()`). No `next()` calls. Our fallback pulls every
  element via `Array.from`.
- Any pattern `[a, b]` where the iterator yields more than 2 elements
  must only pull 2 plus close. Our fallback pulls all elements.
- A throwing iterator at element N must propagate at element N only if
  the pattern reads at least N+1 elements. Our fallback pulls greedily.

## Surfaced by

PR #254 (fix for #1127 class method destructure-default captures) —
removes the CE / spurious-TypeError from class-method destructuring
inputs that go through the externref fallback, but the underlying
tests in `class/dstr/*-ary-ptrn-elem-ary-empty-init` still FAIL:

```
assert_sameValue(iterCount, 0) — expected 0, got 1
```

because the test's generator body ran once when `Array.from(iter)`
pulled its first `.next()`.

## Spec

[ECMA-262 13.3.3.6 Runtime Semantics: IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization)

```
ArrayBindingPattern : [ ]
  1. Return NormalCompletion(empty).

ArrayBindingPattern : [ Elision ]  -- Elision with no BindingElement
  [...]

ArrayBindingPattern : [ BindingElementList ]
  1. Let iteratorRecord be GetIterator(value).
  2. [...] For each BindingElement, pull one value via IteratorStep.
  3. Return IteratorClose(iteratorRecord, ...).
```

For the empty pattern, steps 2 is vacuous — no `IteratorStep` calls.
Our current implementation violates this by materializing all elements
via `Array.from` before any pattern logic runs.

## Affected test262 bucket

`test/language/statements/class/dstr/*-ary-ptrn-elem-ary-empty-init.js`
and `test/language/expressions/class/dstr/*-ary-ptrn-elem-ary-empty-init.js`
— ~48 tests that assert `iterCount === 0` after a destructure whose
first element is `[]` with a default that falls through to an iterator.

## Fix approach

Option A — detect empty pattern at compile time, skip materialization:
- If the target BindingPattern is empty `[]`, emit just
  `get-iterator + iterator-close` (no `next()`/materialize).
- Emits a shorter, spec-correct path for the empty case.
- Low-risk since it's a new branch; the existing `__array_from_iter`
  fallback stays for non-empty nested patterns.

Option B — emit lazy, count-aware iterator consumption:
- Replace `Array.from` with a loop that pulls exactly N elements (N =
  number of non-rest elements in the pattern), then closes the iterator.
- Correct in general but larger codegen change and interacts with
  rest elements, defaults, and throwing iterators.

Option A addresses the immediate test262 failure bucket; Option B is
the eventual spec-correct direction.

## Touch points

- `src/codegen/destructuring-params.ts` — `destructureParamArray`
  fallback around L584-588 (where `__array_from_iter` is emitted)
- `src/runtime.ts` — `__array_from_iter` implementation if Option B
  routes through a new runtime helper
- `src/codegen/destructuring.ts` (if any) — non-param call sites that
  use the same materializer

## Acceptance criteria

- ~48 test262 tests in the `class/dstr/*-ary-ptrn-elem-ary-empty-init`
  and `expressions/class/dstr/*-ary-ptrn-elem-ary-empty-init` buckets
  flip FAIL→PASS (after #1127 removes the spurious TypeError)
- Regression test in `tests/issue-1158.test.ts` asserting `iterCount`
  is unchanged after destructuring `[[] = iter]` with a generator iter

## Related

- #1127 / PR #254 — fixed the class-method capture path so these
  tests reach the iterCount assertion instead of CE; surfaced this bug
- #1135 — iterable-fallback destructuring (original iterator protocol
  plumbing)
- ECMA-262 13.3.3.6
