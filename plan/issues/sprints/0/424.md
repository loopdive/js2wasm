---
id: 424
title: "Logical assignment on unresolved struct type (14 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: contributor-readiness
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileAssignment — logical assignment with struct property targets"
---
# #424 — Logical assignment on unresolved struct type (14 CE)

## Problem

14 tests fail when using logical assignment operators (&&=, ||=, ??=) on properties where the containing object's struct type cannot be resolved.

Example:
```javascript
obj.x ??= defaultValue;
obj.y ||= fallback;
```

The compiler needs the struct type to emit struct.get for the read side and struct.set for the write side of the logical assignment, but the type is unresolved.

## Priority: medium (14 tests)

## Complexity: S

## Acceptance criteria
- [ ] Logical assignment works on struct properties with resolvable types
- [ ] Graceful fallback or error for truly unresolvable types
- [ ] Reduce this CE pattern to zero
