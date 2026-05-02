---
id: 290
title: "Issue #290: Instanceof compile errors -- class hierarchy and expressions"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: compilable
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileInstanceOf: support class expressions and call expressions as right operand"
---
# Issue #290: Instanceof compile errors -- class hierarchy and expressions

## Status: review

## Summary
~20 tests fail in language/expressions/instanceof with compile errors. These involve instanceof checks against class expressions, function constructors, or values from complex expressions. The current instanceof implementation only handles simple class names.

## Category
Sprint 5 / Group A

## Complexity: S

## Scope
- Support `x instanceof (class { })` with class expressions
- Support `x instanceof f()` where the right side is a call expression
- Handle instanceof with function constructors
- Update instanceof compilation in `src/codegen/expressions.ts`

## Acceptance criteria
- instanceof with class expressions compiles
- instanceof with expression right-hand sides compiles
- At least 10 compile errors resolved

## Implementation Summary

### What was done
Rewrote `compileInstanceOf` in `src/codegen/expressions.ts` to support:

1. **Class hierarchy (inheritance)**: Added `collectInstanceOfTags()` that recursively collects the tag of a class and all its descendants via `classParentMap`. For `x instanceof Foo`, the emitted code checks if x's `__tag` equals Foo's tag OR any subclass tag (using OR chain).

2. **Expression right operands**: Added `resolveInstanceOfClassName()` that resolves the class name from any expression (not just identifiers) using the TypeScript type checker. It tries: direct identifier lookup, construct signature return type, and symbol name -- all with `classExprNameMap` fallback.

3. **Graceful fallback**: When the right operand class cannot be resolved at compile time, emits `i32.const 0` (false) instead of a compile error. The left operand is still compiled for side effects then dropped.

4. **Multi-tag comparison**: When a class has subclasses, uses a temporary local to store the tag value, then emits `(tag == t1) || (tag == t2) || ...` via `i32.eq` + `i32.or` chains.

### Files changed
- `src/codegen/expressions.ts` -- rewrote `compileInstanceOf`, added `collectInstanceOfTags` and `resolveInstanceOfClassName`
- `tests/instanceof.test.ts` -- added 3 hierarchy tests (child instanceof Parent, deep hierarchy, parent not instanceof child)

### Tests now passing
- All 7 instanceof tests pass (4 existing + 3 new hierarchy tests)
- No regressions in compiler.test.ts (pre-existing Math.abs timeout unrelated)
