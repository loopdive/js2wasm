---
id: 1345
sprint: 50
title: "spec gap: Generator/AsyncIterator prototype receiver TypeErrors + return/throw (52 + 12 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
parent: 1328
---
# #1345 — Generator / AsyncIterator prototype: receiver checks, .return/.throw

## Problem

`built-ins/GeneratorPrototype`: **9 / 61 pass (14.8%) — 52 fails (20 type_error, 14 unreachable,
10 assertion_fail, 8 other)**.
`built-ins/AsyncIteratorPrototype`: **1 / 13 pass (7.7%) — 12 fails (7 type_error, 4 assertion_fail,
1 promise_error)**.
`built-ins/AsyncGeneratorPrototype`: **26 / 48 (54.2%) — 22 fails (17 type_error)**.

Spec §27.5.1 (GeneratorPrototype) and §27.6.1 (AsyncGeneratorPrototype) require:
1. **Brand check**: `next/return/throw` must validate `this` carries the [[GeneratorState]] internal slot;
   otherwise TypeError.
2. **State machine**: states are "suspendedStart", "suspendedYield", "executing", "completed".
3. **`.return(value)`**: from suspendedYield, run finally blocks; from completed, immediately return.
4. **`.throw(error)`**: from suspendedYield, throw inside the generator (caught by try/catch); from
   suspendedStart or completed, immediately rethrow.
5. **`%IteratorPrototype%`** is the [[Prototype]] of GeneratorPrototype.

The 14 `unreachable` failures are particularly bad — they indicate Wasm `unreachable` traps,
meaning we crash hard rather than throwing TypeError.

## Acceptance criteria

1. `built-ins/GeneratorPrototype/next/this-val-not-generator.js` passes (TypeError, no trap).
2. `built-ins/GeneratorPrototype/return/from-state-suspended-start.js` passes.
3. `built-ins/GeneratorPrototype/throw/from-state-completed.js` passes.
4. `built-ins/AsyncIteratorPrototype/Symbol.asyncIterator.js` passes.
5. Pass-rate for `built-ins/GeneratorPrototype` rises from 15% to ≥65%.
6. No `unreachable` traps in Generator tests (must be replaced by TypeError).

## Files to modify

- `src/codegen/expressions.ts` — yield/yield* lowering, generator state machine
- `src/codegen/registry/generator.ts` — generator prototype method emission

## Implementation Plan

### Root cause

The generator state machine is implemented but its prototype methods don't validate the
receiver. When called on a non-generator (e.g. `Generator.prototype.next.call({})`), we
attempt to read the state field via `struct.get` on a non-Generator struct — `ref.cast` traps
with `unreachable`.

### Approach

Insert a `ref.test $GeneratorBrand` guard at the top of each prototype method:
```
local.get $this
ref.test $GeneratorBrand
i32.eqz
if
  ;; throw TypeError("not a generator")
end
local.get $this
ref.cast $GeneratorBrand
;; ... existing impl
```

Same for AsyncGenerator and AsyncIterator (which is the prototype-of-prototypes — must exist
even though tests check just for its existence).

### Edge cases

- `.return(value)` while in `executing` state → throw TypeError (re-entrant call).
- `.throw(err)` from `suspendedStart` → just close the generator and throw (no try/catch around
  the prologue).
- Async generator: `.return()` resolves to `{value, done:true}`; `.throw()` rejects with the error.

### Test262 sample

- `test262/test/built-ins/GeneratorPrototype/next/this-val-not-generator.js`
- `test262/test/built-ins/GeneratorPrototype/throw/from-state-completed.js`
- `test262/test/built-ins/AsyncGeneratorPrototype/throw/throw-promise-rejected.js`
