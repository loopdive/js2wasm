---
id: 399
title: "Prototype method calls return wrong values (72 FAIL)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: contributor-readiness
test262_fail: 72
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileCallExpression — prototype method return values"
---
# #399 — Prototype method calls return wrong values (72 FAIL)

## Status: open

72 tests compile but return wrong results from prototype method calls (11% of "returned 0" failures). Mostly in Array.prototype.forEach/indexOf/lastIndexOf.

## Details

```javascript
var result = [1,2,3].indexOf(2);  // returns 0 instead of 1
[1,2,3].forEach(function(x, i) { ... });  // callback receives wrong args
```

Breakdown:
- Array.prototype.forEach: 27
- Array.prototype.indexOf: 16
- Array.prototype.lastIndexOf: 11
- Other prototype methods: 18

Likely the method implementations return incorrect values or pass wrong arguments to callbacks.

## Complexity: M

## Acceptance criteria
- [ ] Array.prototype.indexOf returns correct index
- [ ] Array.prototype.forEach passes correct arguments to callback
- [ ] Reduce prototype method failures by 50+
