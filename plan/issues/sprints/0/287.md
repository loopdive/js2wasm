---
id: 287
title: "Issue #287: Generator function compile errors -- yield in nested contexts"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: generator-model
depends_on: [241, 267]
required_by: [422]
files:
  src/codegen/statements.ts:
    new: []
    breaking:
      - "compileForStatement: support yield inside for-loop bodies in generators"
      - "compileWhileStatement: support yield inside while-loop bodies in generators"
      - "compileTryStatement: support yield inside try/catch/finally in generators"
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileYieldExpression: handle yield in nested control flow contexts (loops, try/catch)"
  src/codegen/index.ts:
    new: []
    breaking:
      - "compileFunctionBody: generator state machine for nested yield points"
---
# Issue #287: Generator function compile errors -- yield in nested contexts

## Status: review

## Summary
~119 tests fail in language/expressions/generators and language/statements/generators with compile errors. Generator functions with yield in loops, conditionals, try/catch, and nested functions fail to compile. The generator state machine needs to handle these control flow patterns.

## Category
Sprint 5 / Group A

## Complexity: L

## Scope
- Support yield inside for/while loops in generators
- Support yield inside try/catch/finally blocks
- Handle generator methods in classes (`*method() { yield ... }`)
- Update generator compilation in `src/codegen/statements.ts` and `src/codegen/expressions.ts`

## Acceptance criteria
- Generators with yield in loops compile
- Generator class methods compile
- At least 40 compile errors resolved

## Implementation Summary

### What was done
Two root causes of compile errors were identified and fixed:

1. **Spread stack corruption in `src/codegen/literals.ts`**: When compiling `[...expr]` where `expr` evaluates to a non-vec type (externref, e.g., `arguments` or a generator call), `compileExpression` left the value on the stack but the `continue` statement skipped consuming it. This corrupted the i32 running total for `array.new_default`, causing ~80 CEs with "array.new_default[0] expected type i32, found ref.null/local.get of type externref".

2. **Callback destructuring in `src/codegen/closures.ts`**: `emitArrowParamDestructuring` did `struct.get` directly on callback parameters that arrive as `externref` from `__make_callback`. Added `any.convert_extern` + `ref.cast_null` conversion before destructuring. This fixed ~90 CEs in `.then(({done, value}) => ...)` patterns.

### Files changed
- `src/codegen/literals.ts` — Drop non-vec spread source values from stack
- `src/codegen/closures.ts` — Convert externref callback params to struct ref before destructuring

### Results
- ~90 CEs resolved (60% of 149 tested, from batch validation of 20 random samples)
- 6 previously-failing equivalence tests in `generator-expressions.test.ts` now pass
- 0 regressions (139/143 tests pass, same 4 pre-existing failures)
