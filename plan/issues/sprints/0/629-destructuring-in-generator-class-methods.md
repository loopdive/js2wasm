---
id: 629
title: "Destructuring in generator/class methods fails silently (2,444 FAIL)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: medium
goal: core-semantics
test262_fail: 2444
files:
  src/codegen/statements.ts:
    breaking:
      - "destructuring patterns in generator methods, async methods, class methods"
---
# #629 — Destructuring in generator/class methods fails silently (2,444 FAIL)

## Status: in-progress

2,444 tests fail with "returned 0" — these are destructuring patterns inside generator methods, async generator methods, and class method parameters. The destructuring compiles but produces wrong values at runtime.

### Common patterns
- `gen-meth-ary-ptrn-*` — generator method array destructuring
- `gen-meth-obj-ptrn-*` — generator method object destructuring
- `async-gen-meth-dflt-*` — async generator method default destructuring
- `cls-decl-gen-meth-*` — class declaration generator method patterns

### Root cause
When destructuring occurs in generator method parameters, the parameter binding happens in the generator setup phase but the values are consumed from the iterator protocol. The compiler may not correctly handle the generator's implicit iterator argument passing.

## Complexity: M
