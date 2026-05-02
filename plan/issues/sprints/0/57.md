---
id: 57
title: "Issue 57: Class expressions"
status: done
created: 2026-03-02
updated: 2026-04-14
completed: 2026-03-02
goal: class-system
---
# Issue 57: Class expressions

## Summary

Support class expressions: `const Foo = class { ... }`.

## Current behavior

Class expressions produce an error: "class expression is not supported".

## Desired behavior

```ts
const Point = class {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  sum(): number { return this.x + this.y; }
};
const p = new Point(1, 2);
p.sum();  // 3
```

## Implementation

### Codegen
- When encountering a `ClassExpression` in expression position:
  - Generate a synthetic class name from the variable binding (e.g. `Point`)
  - Delegate to the existing class declaration codegen
  - The result is a constructor funcref or the ability to `new` the class

## Complexity

S — ~80 lines, 1-2 files (reuse class declaration codegen)
