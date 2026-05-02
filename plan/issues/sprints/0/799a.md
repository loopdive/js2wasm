---
id: 799a
title: "#799a -- __proto__ field on structs"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: medium
goal: property-model
subtask_of: 799
commit: 33400565
note: caused -2,788 regression, being revised to conditional-only approach in #802
---
# #799a -- __proto__ field on structs

## Implementation summary

Added `$__proto__` field to struct types for prototype chain support. Initial implementation added the field unconditionally to ALL structs, which caused a -2,788 test regression by breaking struct.new argument counts across the codebase. Lesson learned: adding fields to all structs is too invasive. The correct approach (#802) is conditional -- only add __proto__ to structs that actually need dynamic prototype support (Object.setPrototypeOf, Object.create).

For static inheritance (class extends), the compiler resolves the chain at compile time with no runtime field needed (#799b).

Commit: 33400565
