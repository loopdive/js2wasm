---
id: 260
title: "ClassDeclaration + call expression combined errors"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: high
goal: core-semantics
files:
  - src/codegen/expressions.ts
---
# Issue #260: ClassDeclaration + call expression combined errors

## Problem

~195 tests fail with combined "Unsupported statement: ClassDeclaration" and "Unsupported call expression" errors when class declarations appear alongside various call expression patterns.

The issue manifests in patterns where:
- `new C().method()` chains are used
- Conditional expressions produce class instance results (`flag ? new A() : new B()`)
- Class methods are invoked on results of other expressions

## Root Cause

The conditional expression compiler (`compileConditionalExpression`) unconditionally widened `ref` types to `ref_null` for `if` block results (line 9543 of expressions.ts), even when both branches of the conditional guaranteed non-null results (e.g., `new X()`). This caused a Wasm type mismatch when the result was stored into a `ref`-typed local, since `ref_null` is not assignable to `ref` in Wasm's type system.

## Fix

Changed the conditional expression result type handling to only widen `ref` to `ref_null` when at least one branch actually produces a nullable type (`ref_null`). When both branches produce non-null `ref` types, the result keeps the `ref` kind, which is valid since both arms guarantee a non-null value.

## Implementation Summary

### What was done
- Fixed `compileConditionalExpression` in `src/codegen/expressions.ts` to preserve non-null ref types when both branches guarantee non-null results
- Added comprehensive test suite (`tests/issue-260.test.ts`) with 20 test cases covering:
  - `new C().method()` patterns
  - Chained method calls (`a.method().method()`)
  - Function return + method call
  - Class declarations in nested scopes (functions, if-blocks, for-loops)
  - Class expressions assigned to variables
  - Static methods
  - Inheritance with method calls
  - Conditional expressions with new expressions
  - Class methods calling other methods on `this`
  - Methods accepting class instances as parameters
  - Classes with string properties

### Files changed
- `src/codegen/expressions.ts` — fixed conditional expression ref type handling
- `tests/issue-260.test.ts` — new test file (20 tests)

### Tests now passing
All 20 issue-260 tests pass. No regressions in equivalence tests (26/26) or closed-imports tests (19/19).
