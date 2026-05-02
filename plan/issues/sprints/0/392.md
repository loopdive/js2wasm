---
id: 392
title: "- Unknown field access on class structs (18 CE)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: compilable
test262_ce: 18
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compilePropertyAccess — handle unknown fields on class structs gracefully"
---
# #392 -- Unknown field access on class structs (18 CE)

## Status: open

18 tests fail with "Unknown field 'field' on struct 'C'" because the compiler cannot resolve dynamically added or computed field names on class instances.

## Details

Some tests access fields that are added dynamically or via computed property names:

```javascript
class C {}
var c = new C();
c.dynamicField = 42;     // not in class declaration
var val = c.dynamicField; // unknown field error
```

Fix:
1. For fields that do not exist on the struct at compile time, consider a fallback to externref property access
2. Alternatively, detect common patterns (like assignment followed by access) and expand the struct definition
3. For computed field names, route through a dynamic lookup mechanism

## Complexity: S

## Acceptance criteria
- [ ] Accessing fields not in the class declaration does not produce a compile error
- [ ] Graceful fallback for unknown field access on class instances
- [ ] Reduce test262 compile errors by ~18
