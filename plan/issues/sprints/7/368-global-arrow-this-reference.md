---
id: 368
title: "- Global/arrow `this` reference"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: core-semantics
test262_skip: 13
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileThisKeyword — handle global scope and arrow function this"
---
# #368 -- Global/arrow `this` reference

## Status: open

13 tests reference `this` in global scope or arrow functions. Need to bind global this to undefined (strict mode) or globalThis.

## Details

```javascript
// In strict mode (module code):
this; // undefined

// Arrow functions capture enclosing this:
var obj = {
  method() {
    var arrow = () => this;
    return arrow(); // returns obj
  }
};
```

Currently `this` may not be handled in:
1. Global/module scope -- should be `undefined` in strict mode
2. Arrow functions -- should capture the enclosing `this` lexically
3. Top-level function calls -- `this` is `undefined` in strict mode

Implementation:
- In module scope, `this` should compile to `undefined`
- Arrow functions should capture `this` from their enclosing scope via closure
- Regular functions should receive `this` as an implicit parameter

## Complexity: S

## Acceptance criteria
- [ ] `this` in module/global scope returns `undefined`
- [ ] `this` in arrow functions returns enclosing scope's `this`
- [ ] 13 previously skipped tests are now attempted
