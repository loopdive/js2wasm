---
id: 484
title: "Well-known Symbol.species for constructor delegation (52 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: hard
goal: async-model
depends_on: [481]
test262_skip: 52
files:
  src/codegen/expressions.ts:
    new:
      - "compileSymbolSpecies — Symbol.species for subclass constructors"
    breaking: []
---
# #484 — Well-known Symbol.species for constructor delegation (52 tests)

## Status: open

52 tests use `Symbol.species` — the protocol that lets built-in methods (Array.map, Promise.then) use a subclass constructor.

## Approach

`Symbol.species` is a static getter on built-in classes:
```javascript
class MyArray extends Array {
  static get [Symbol.species]() { return Array; }
}
```

This can be compiled as a static struct field `__symbol_species` that returns a constructor reference. Built-in methods check `this.constructor[Symbol.species]` to determine which constructor to use for the return value.

This is harder than Symbol.iterator because it requires:
1. Constructor references as first-class values
2. Built-in array/promise methods to check the species pattern

## Complexity: L

## Acceptance criteria
- [ ] `static get [Symbol.species]()` compiles as a struct field
- [ ] Array.prototype.map respects Symbol.species
