---
id: 486
title: "Well-known Symbol.toStringTag and Symbol.hasInstance (22 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: symbol-protocol
depends_on: [481]
test262_skip: 22
files:
  src/codegen/expressions.ts:
    new:
      - "compileSymbolToStringTag — Symbol.toStringTag as struct field"
      - "compileSymbolHasInstance — Symbol.hasInstance as static method"
    breaking: []
---
# #486 — Well-known Symbol.toStringTag and Symbol.hasInstance (22 tests)

## Status: open

18 tests use `Symbol.toStringTag` (customizes `Object.prototype.toString`), 4 use `Symbol.hasInstance` (customizes `instanceof`).

## Approach

- `[Symbol.toStringTag]`: compile as `__symbol_toStringTag` string field. When `Object.prototype.toString.call(obj)` is used, check for this field.
- `[Symbol.hasInstance]`: compile as `__symbol_hasInstance` static method. The `instanceof` operator checks for this before the default prototype chain check.

## Complexity: S

## Acceptance criteria
- [ ] `class C { get [Symbol.toStringTag]() { return "MyClass"; } }` works
- [ ] `class C { static [Symbol.hasInstance](v) { ... } }` customizes instanceof
