---
id: 61
title: "Issue 61: Object.keys / Object.values / Object.entries"
status: done
created: 2026-03-02
updated: 2026-04-14
completed: 2026-03-03
goal: contributor-readiness
---
# Issue 61: Object.keys / Object.values / Object.entries

## Summary

Support static `Object` methods for iterating over object properties.

## Desired behavior

```ts
const obj = { x: 1, y: 2, z: 3 };
Object.keys(obj);     // ["x", "y", "z"]
Object.values(obj);   // [1, 2, 3]
Object.entries(obj);  // [["x", 1], ["y", 2], ["z", 3]]
```

## Implementation

### Approach A: Compile-time expansion (for known struct types)
- Since struct fields are known at compile time, expand to array literal:
  - `Object.keys(obj)` → `["x", "y", "z"]` (string array)
  - `Object.values(obj)` → `[obj.x, obj.y, obj.z]`
  - `Object.entries(obj)` → requires tuples (#56)

### Approach B: Host delegation (for externref objects)
- Pass object to host, get back an array
- `Object_keys: (obj) => Object.keys(obj)` etc.
- Return type: externref (host array)

### Recommended: Approach A for struct types, B for externref

## Complexity

M — ~200 lines, 2 files
