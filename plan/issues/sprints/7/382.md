---
id: 382
title: "- Spread argument in super/function calls"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: medium
goal: iterator-protocol
test262_ce: 4
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileCallExpression — handle spread arguments in super and function calls"
---
# #382 -- Spread argument in super/function calls

## Status: open

4+ tests fail with "A spread argument must either have a tuple type or be passed to a rest parameter" compile error.

## Details

```javascript
class Child extends Parent {
  constructor(...args) {
    super(...args); // spread in super call
  }
}

function wrapper(...args) {
  return fn(...args); // spread in function call
}
```

TypeScript requires spread arguments to have a tuple type or target a rest parameter. In plain JavaScript, any iterable can be spread into a function call.

Fixes may involve:
- Suppressing the TS diagnostic for spread arguments in JS mode
- Improving type inference for rest parameters
- Handling spread of array-typed values in codegen

## Complexity: M

## Acceptance criteria
- [ ] `super(...args)` compiles with spread arguments
- [ ] `fn(...args)` compiles with spread of rest parameters
- [ ] 4+ previously failing compile errors are resolved
