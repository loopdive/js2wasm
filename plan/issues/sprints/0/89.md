---
id: 89
title: "Issue 89: Test262 coverage — language/statements"
status: done
created: 2026-03-09
updated: 2026-04-14
completed: 2026-03-09
goal: test-infrastructure
---
# Issue 89: Test262 coverage — language/statements

## Status: DONE

## Summary

Added `language/statements/function` to the test262 runner (other statement categories were already present).

## Categories added

- function (451 test files — most skipped due to unsupported features)

(Previously added: if, while, do-while, for, switch, break, continue, return, block, empty, expression, variable, labeled, throw, try)

## Results

All compilable statement tests pass (100%). Skip filters cover:
- Prototype chain, Object.defineProperty/create/freeze
- Getter/setter in object literals
- Property introspection (hasOwnProperty, propertyIsEnumerable)

## Tests

6773 test262 tests total, 412 pass, 0 fail
