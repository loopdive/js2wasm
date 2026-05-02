---
id: 799b
title: "#799b -- Prototype chain walk for property access"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: critical
feasibility: medium
goal: property-model
subtask_of: 799
commit: 706a8471
---
# #799b -- Prototype chain walk for property access

## Implementation summary

Implemented compile-time prototype chain walk for property access. When a property is not found on the primary struct type, the compiler walks the class hierarchy at compile time (via extends relationships) and emits struct.get on the parent type. This is fully static -- no __proto__ field, no runtime chain walk needed. Covers the common case of class inheritance property resolution.

Commit: 706a8471
