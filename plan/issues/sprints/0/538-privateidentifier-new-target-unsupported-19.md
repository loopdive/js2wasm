---
id: 538
title: "PrivateIdentifier + new.target unsupported (19 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: maintainability
---
# PrivateIdentifier + new.target unsupported (19 CE)

## Problem

Two unsupported patterns causing compile errors:

1. **`#field in obj`** -- The `in` operator handler does not recognize `PrivateIdentifier` as a valid left-hand side. When `#field in obj` appears, the codegen fails to extract a static key because it only checks for string/numeric literals.

2. **`new.target`** -- Already partially implemented (returns i32 1 in constructors, ref.null.extern outside). But `typeof new.target` is not handled, so `typeof new.target === "undefined"` or `typeof new.target !== "undefined"` fails.

## Solution

1. In the `InKeyword` handler in `compileExpression`, added a check for `ts.isPrivateIdentifier(leftExpr)` to extract the field name (stripping the `#` prefix) as a static key for the property existence check.

2. In `compileTypeofExpression`, added a handler for `typeof new.target` that returns `"function"` inside constructors and `"undefined"` outside constructors.

## Implementation Summary

### What was done
- Added `PrivateIdentifier` handling in the `in` operator codegen (expressions.ts ~line 3558)
- Added `typeof new.target` handling in `compileTypeofExpression` (expressions.ts ~line 3011)
- Created `tests/issue-538.test.ts` with 3 tests for `typeof new.target` and `new.target` truthiness in constructors

### Files changed
- `src/codegen/expressions.ts` -- two additions (PrivateIdentifier in `in` operator, typeof new.target)
- `tests/issue-538.test.ts` -- new test file

### Tests now passing
- typeof new.target inside constructor returns "function"
- new.target inside constructor is truthy
- typeof new.target === "function" inside constructor
