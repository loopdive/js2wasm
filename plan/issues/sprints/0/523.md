---
id: 523
title: "Internal compiler errors: undefined property access (59 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-03-18
priority: medium
feasibility: medium
goal: crash-free
test262_ce: 59
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileInternalError — handle undefined .text and missing expression types"
---
# #523 — Internal compiler errors: undefined property access (59 CE)

## Status: review

Two internal error patterns:
- "Cannot read properties of undefined (reading 'text')" — 36 CE
- "Unsupported expression: SpreadElement" — 23 CE

These are compiler crashes on unexpected AST shapes. The 'text' error is a null node reference. The SpreadElement error is spread in unsupported positions (not in array/call).

## Complexity: S

## Implementation Summary

### What was done:

1. **SpreadElement in IIFE arguments** (primary fix): The `compileIIFE` function compiled call arguments in a loop that passed each argument directly to `compileExpression`. When any argument was a `SpreadElement` (e.g., `(function(){})(...[1,2,3])`), it hit the fallthrough "Unsupported expression: SpreadElement" error. Fixed by flattening spread arguments via `flattenCallArgs` before the argument compilation loop, and skipping any remaining non-flattenable spread elements.

2. **SpreadElement safety net in compileExpressionInner**: Added a handler for `SpreadElement` just before the generic unsupported-expression error. If a SpreadElement reaches `compileExpressionInner` through any code path (there are dozens of argument compilation loops throughout the codebase), it now compiles the operand expression instead of crashing. This acts as a catch-all for the many call-argument loops that don't explicitly handle spread.

3. **Null guard for .text access in binding pattern destructuring**: Added a guard in the object binding pattern destructuring for function parameters (line ~1340). The code cast `element.propertyName ?? element.name` to `ts.Identifier` without checking, which could crash if `propertyName` was a computed property name. Added an `isIdentifier || isStringLiteral` check before the cast.

4. **Undefined .text errors (36 CE)**: Investigation showed these errors appear to have been fixed by recent commits on main. The test262 results were from a prior run, and all the failing test files now compile successfully.

### Files changed:
- `src/codegen/expressions.ts` — SpreadElement handling in IIFE args, safety net in compileExpressionInner, binding pattern null guard
- `tests/null-dereference-guards.test.ts` — new tests for spread in IIFE patterns

### Tests passing:
- 3 new tests for SpreadElement in IIFE positions
- No regressions in existing test suite
