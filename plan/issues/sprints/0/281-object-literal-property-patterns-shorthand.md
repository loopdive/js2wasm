---
id: 281
title: "Issue #281: Object literal property patterns -- shorthand, spread, methods"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: class-system
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileObjectLiteralForStruct: add support for shorthand properties, spread elements, and method definitions with computed names"
---
# Issue #281: Object literal property patterns -- shorthand, spread, methods

## Status: done
completed: 2026-03-12

## Summary
~303 tests fail in language/expressions/object with compile errors. Many involve shorthand properties (`{x, y}`), spread in objects (`{...a}`), method definitions with computed names, and getter/setter pairs that the codegen does not fully handle.

## Category
Sprint 4 / Group C

## Complexity: M

## Scope
- Support shorthand property definitions in object literals
- Handle spread elements in object literals
- Support method definitions with various parameter patterns
- Update object literal compilation in `src/codegen/expressions.ts`

## Acceptance criteria
- Shorthand properties compile
- Object spread compiles
- Method definitions in objects with complex params compile
- At least 40 compile errors resolved

## Implementation Summary

### What was done
- Extended method declaration handling to support string literal, numeric literal, and computed property names
- Added `emitMethodParamDefaults` helper for default parameter initialization in object methods
- Both fixes ensure object literal methods compile correctly with complex name/param patterns

### Files changed
- `src/codegen/expressions.ts` — method name resolution + default params
- `tests/issue-281.test.ts` — 23 tests (all passing)

### Impact
Object literal method patterns and default params now compile correctly
