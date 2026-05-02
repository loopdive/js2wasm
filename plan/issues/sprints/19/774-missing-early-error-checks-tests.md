---
id: 774
title: "- Missing early error checks: tests expect SyntaxError but compile successfully"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: error-model
test262_fail: 2657
---
# #774 -- Missing early error checks: tests expect SyntaxError but compile successfully

## Problem

2,657 tests expect a parse/early SyntaxError but our compiler accepts them. Categories include:
- Strict mode restrictions (assignment to eval/arguments, duplicate params, with statement, octal literals)
- Invalid destructuring targets (rest element with initializer, trailing elements after rest)
- yield/await as identifiers in generator/async contexts
- delete on private names
- Invalid label/break/continue targets

## Fix approach

Add early error checks in the checker or codegen pre-pass that reject programs TypeScript's parser accepts but ES spec forbids. Some can use TS diagnostics (enable strict mode checks), others need custom validation.

## Acceptance criteria

- Tests expecting SyntaxError correctly fail to compile
- No false positives on valid programs
