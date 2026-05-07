---
id: 1346
sprint: 50
title: "spec gap: yield in nested try/finally + yield expression evaluation order (46 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
parent: 1328
---
# #1346 — yield expression: try/finally + evaluation order

## Problem

`language/expressions/yield`: **16 / 63 pass (25.4%) — 46 fails (31 assertion_fail, 13 other,
2 type_error)**.

Spec §15.5.5 (YieldExpression) requires:
1. **Single-step evaluation**: the expression is evaluated, the value is sent to the consumer,
   then the consumer's return value (if .next(value) is called with a value) becomes the result
   of the yield expression.
2. **try/finally interaction**: when a generator is suspended at a yield, calling `.return()` triggers
   the finally block to run before the generator completes.
3. **yield* delegation**: forwards the iterator protocol to the inner iterable, including
   .return/.throw forwarding.
4. **yield in argument list**: `f(yield 1, yield 2)` evaluates yield 1 first, then yield 2.
5. **yield in compound expression**: `[yield 1, 2]` — yield 1 first, then 2.

The 31 assertion_fail failures suggest:
- yield* doesn't forward `.return()` correctly through nested delegation.
- Try/finally finalizers aren't run on early `.return()`.
- yield evaluation order in complex expressions isn't observed correctly.

## Acceptance criteria

1. `language/expressions/yield/star-iterable.js` passes.
2. `language/expressions/yield/star-rhs-iter-rtrn-meth-throws.js` passes.
3. `language/expressions/yield/yield-as-yield-operand-in-fn-arg.js` passes.
4. Pass-rate for `language/expressions/yield` rises from 25% to ≥70%.

## Files to modify

- `src/codegen/expressions.ts` — yield expression compiler
- `src/codegen/statements.ts` — try/finally lowering interaction with yield
- `src/codegen/registry/iterator.ts` — yield* delegation

## Implementation Plan

### Root cause

The yield state machine collapses each yield to a single suspension point with a specific
state-tag, but try/finally introduces an extra "abrupt-completion handler" state that we
don't materialize. When `.return()` is called on a generator suspended inside a try block,
we should jump to the finally block before completing, but we instead complete directly.

For yield*: the delegation loop reads from `.next()` of the inner iterable but doesn't forward
the outer's `.return(value)` and `.throw(error)` to the inner — it just propagates upward.

### Approach

1. **try/finally + yield**: extend the generator state struct with a "pending-return-value" slot.
   When `.return()` is called while suspended in a try, set the slot, jump to finally block, then
   on finally exit either rethrow or return.
2. **yield* delegation**: the inner-iterator must be stored in a generator-local field. On
   `.return()`/`.throw()` from outside, dispatch to the inner-iterator's matching method (if any).
3. **Evaluation order**: the parser/IR-lowerer should preserve sequential yield-evaluation by
   binding intermediate values to temporaries before the next yield.

### Edge cases

- yield* on null/undefined → TypeError ("not iterable").
- yield in finally block of an outer try — the finally should run to completion before re-throwing.
- yield* on an iterator that doesn't define `.return` or `.throw` — silently ignore the inner
  call (don't crash).

### Test262 sample

- `test262/test/language/expressions/yield/star-rhs-iter-rtrn-meth-throws.js`
- `test262/test/language/expressions/yield/star-iterable.js`
- `test262/test/language/expressions/yield/yield-as-yield-operand-in-fn-arg.js`
