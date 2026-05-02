---
id: 731
title: "- Function/class .name property (558 tests)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-03-25
priority: medium
feasibility: easy
goal: class-system
test262_fail: 558
files:
  src/codegen/statements.ts:
    new:
      - "set .name property on function and class objects at creation"
  src/codegen/expressions.ts:
    new:
      - "set .name for anonymous functions assigned to variables"
---
# #731 -- Function/class .name property (558 tests)

## Status: backlog

## Problem

558 test262 tests check that `Function.name` or class name is set correctly. The compiler likely does not populate the `.name` property on function/class objects.

### ES spec requirements
- Named function declarations/expressions: `.name` = function name
- Anonymous function assigned to variable: `.name` = variable name
- Method definitions: `.name` = method name
- Getter/setter: `.name` = "get "/"set " + property name
- Class declarations/expressions: `.name` = class name
- Arrow functions: `.name` = variable name if assigned

### What needs to happen

1. When creating function/class objects, set the `.name` property as a string field on the struct
2. For anonymous functions assigned to variables, infer name from assignment target
3. For getters/setters, prefix with "get "/"set "

## Complexity: M (<400 lines)
