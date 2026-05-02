---
id: 678
title: "Dynamic prototype chain traversal"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
goal: property-model
depends_on: [631]
required_by: [729, 732, 738]
test262_fail: 625
files:
  src/codegen/expressions.ts:
    new:
      - "dynamic prototype chain traversal for property lookup"
superseded_by: 802
note: "#802 covers the same problem (conditional __proto__ field). #799a attempted unconditional __proto__ and regressed; #802 is the corrected conditional approach."
---
# #678 — Dynamic prototype chain traversal

## Status: open

#631 added static prototype patterns. ~625 tests need dynamic traversal.

### Approach
1. Each struct gets an optional `__proto__` externref field pointing to parent prototype
2. Property access fallback: if field not found on struct, check `__proto__` chain via host import `__proto_get(obj, "prop") -> externref`
3. `for-in` loop: walk prototype chain collecting enumerable keys
4. `instanceof`: walk `__proto__` chain checking against constructor.prototype

The `__proto__` field is only allocated for classes with inheritance. Cost: 1 externref field + 1 host call per prototype-chain property miss.

## Complexity: L
