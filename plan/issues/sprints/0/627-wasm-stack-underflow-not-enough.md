---
id: 627
title: "Wasm stack underflow: not enough arguments (354 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: critical
goal: compilable
required_by: [649]
---
# Issue #627: Wasm stack underflow from void expressions in logical operators

## Problem

354 test262 tests fail with "not enough arguments on the stack for drop/local.set (need 1, got 0)".

Breakdown by instruction:
- 147 local.set
- 131 drop
- 70 call
- 4 struct.get
- 2 if

## Root Cause

compileLogicalAnd, compileLogicalOr, and compileNullishCoalescing compile the RHS into a side buffer and treat null (void) results as externref without pushing any value. The resulting if block has a branch with no value on the stack, causing Wasm validation failure.

## Fix

When the RHS of &&, ||, or ?? is a void expression (compileExpression returns null):
1. Push defaultValueInstrs(leftType) into the void branch instruction buffer
2. Use leftType as the result type (since the void branch returns the undefined default)
3. Short-circuit the type unification logic

Also fixed Array.isArray path that unconditionally emitted drop after compiling the argument without checking if it was void.

## Implementation Summary

Files changed:
- src/codegen/expressions.ts: Fixed compileLogicalAnd, compileLogicalOr, compileNullishCoalescing, and Array.isArray handler
- tests/void-expression-stack.test.ts: 6 new test cases

The existing defaultValueInstrs helper (used for array fill) was reused to generate typed default values for void branches.
