---
id: 1159
title: "Nested empty array pattern with initializer violates §13.3.3.6 iterator consumption semantics"
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
es_edition: es6
---
# #1159 -- Nested empty array pattern with initializer violates §13.3.3.6 iterator consumption semantics

## Problem

When a class method (or any function) parameter is a binding pattern where
a nested empty array pattern has an initializer that returns an iterator,
the initializer's side effects (mutations to outer-scope variables inside
`initCount += 1; return iter`) are not observable after the call. The
failing test262 shape:

```ts
var initCount = 0;
var iterCount = 0;
var iter = function*() { iterCount += 1; }();
class C {
  static m([[] = function() { initCount += 1; return iter; }()]: any) {
    return initCount * 10 + iterCount;
  }
}
// Expected: 0 (the outer [[1]] provides the element, initializer is not called)
// Observed: 1 (per probe-1127-exact.test.ts test 4 — `meth-static-ary-ptrn-elem-ary-empty-init`)
```

Test reference: `probe-1127-exact.test.ts` Test 4 in worktree
`issue-1127-dstr-init` (check the test harness passes `setExports` before
running — see probe-1127-nested-rest.test.ts for the working shape).

## ECMAScript spec reference

- [§13.3.3.6 IteratorBindingInitialization (BindingPattern)](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization)
  — step sequence determines when the initializer is called
- [§13.15.5.3 DestructuringAssignmentEvaluation](https://tc39.es/ecma262/#sec-runtime-semantics-destructuringassignmentevaluation)
- [§7.4.2 IteratorNext](https://tc39.es/ecma262/#sec-iteratornext) — iterator step semantics

## How this differs from related issues

- **Not #1127**: that was nested rest patterns (`[...[x,y,z]]`). Those all
  pass on origin/main as of 2026-04-21.
- **Not #1158**: that was `__array_from_iter` eagerness. This failure
  persists even when the outer argument is a concrete array.
- **Not #1135**: that covered iterable fallback for externref rest.

## Sample test262 files

- `test/language/statements/class/dstr/meth-static-ary-ptrn-elem-ary-empty-init.js`
- Likely related: `meth-static-ary-ptrn-elem-ary-init-skipped.js` and
  `-elem-ary-init-exhausted.js` variants

## Root cause hypothesis

The compiled class method either:
1. Invokes the initializer when it shouldn't (outer element is not
   `undefined`, so per §13.3.3.6 the initializer must not run), or
2. Invokes it eagerly before the element presence check.

Prior attempt to fix via externref widening (PR #254, closed
2026-04-21) caused 691 regressions and is a known-bad approach.
See reversion commit f5a4d122 on `issue-1127-dstr-init`.

## Acceptance criteria

- Test262 `meth-static-ary-ptrn-elem-ary-empty-init.js` passes
- Test 4 of probe-1127-exact.test.ts returns 0 (not 1)
- No regressions in class-method destructure buckets
- No regressions in free-function destructure buckets

## DO NOT

Repeat the PR #254 approach of widening class-method binding-pattern
params with initializers to externref. The typed ref_null path must
handle this correctly, or a more targeted fix is needed in
`emitExternrefDestructureGuard` / `destructureParamObjectExternref`.
