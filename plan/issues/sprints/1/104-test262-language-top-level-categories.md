---
id: 104
title: "Issue 104: Test262 — language/ top-level categories"
status: done
created: 2026-03-10
updated: 2026-04-14
completed: 2026-03-10
goal: core-semantics
---
# Issue 104: Test262 — language/ top-level categories

## Summary

Add test262 coverage for the top-level `language/` categories that correspond
to syntax features already implemented: destructuring, default parameters, rest
parameters, computed property names, spread, and template literals.

## Categories to add

| Category | Feature | Status in compiler |
|---|---|---|
| `language/destructuring` | destructuring assignment | ✅ done (#17) |
| `language/default-parameters` | default parameter values | ✅ done (#49) |
| `language/rest-parameters` | rest parameters `...args` | ✅ done (#18) |
| `language/computed-property-names` | `{ [expr]: v }` | ✅ done (#65) |
| `language/template-literals` | `` `${x}` `` | ✅ done (#13) |
| `language/spread-operator` | `...arr` in calls/arrays | ✅ done (#18) |

## Approach

1. Add each category to `TEST_CATEGORIES`
2. Run and inspect: skip filters typically needed for:
   - Destructuring with default values inside patterns
   - Destructuring of iterator protocol (not just arrays/objects)
   - Computed property names with Symbol values
   - Tagged template literals
   - Rest parameters combined with destructuring

## Complexity

S
