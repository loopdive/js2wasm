---
id: 438
title: "Internal error: Cannot read properties of undefined in expression compilation (20 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: error-model
test262_ce: 20
complexity: S
files:
  src/codegen/expressions.ts:
    breaking:
      - "compileExpressionInner -- null safety for undefined property access"
---
# #438 -- Internal error: Cannot read properties of undefined in expression compilation (20 CE)

## Problem

20 tests fail with "Internal error compiling expression: Cannot read properties of undefined (reading ...)" -- a JavaScript TypeError thrown inside the compiler itself during expression compilation.

This indicates the codegen is accessing a property on a value it expects to exist but which is undefined. Common causes:
- Looking up a variable binding that was never registered
- Accessing .type or .kind on an AST node that is unexpectedly null
- Dereferencing a struct type that was not resolved

## Priority: medium (20 tests)

## Complexity: S

## Acceptance criteria
- [ ] Identify and fix the specific undefined property accesses
- [ ] Add null guards or proper error messages for unresolvable references
- [ ] CE count for this internal error pattern reduced to near zero
