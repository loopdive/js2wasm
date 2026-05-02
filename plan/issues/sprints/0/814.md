---
id: 814
title: "- ArrayBuffer 'no dependency provided for extern class' (413 tests)"
status: done
created: 2026-03-27
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: easy
goal: standalone-mode
test262_fail: 413
---
# #814 -- ArrayBuffer "no dependency provided for extern class" (413 tests)

## Problem

413 tests fail with `No dependency provided for extern class "ArrayBuffer"`. The compiler doesn't recognize `ArrayBuffer` as a built-in constructor in all contexts. When test code does `new ArrayBuffer(n)` or uses ArrayBuffer as a type check, the compiler emits an extern class dependency.

## Root cause

ArrayBuffer constructor support (#614) was added for TypedArray contexts, but standalone `new ArrayBuffer(n)` in test262 code paths may not be hitting the recognized constructor logic.

## Fix approach

1. Add `ArrayBuffer` to the recognized global constructor list (alongside Error, Map, Set, etc.)
2. `new ArrayBuffer(n)` → host import `__new_ArrayBuffer(n) -> externref` or compile to linear memory allocation
3. `ArrayBuffer.isView()` → host import or compile-away check

## Files to modify
- `src/codegen/expressions.ts` — compileNewExpression: recognize ArrayBuffer

## Acceptance criteria
- `new ArrayBuffer(n)` compiles without extern class error
- 413 tests unblocked

## Complexity: XS
