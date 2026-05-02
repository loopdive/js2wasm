---
id: 797a
title: "#797a -- Per-shape property flags table (compile-time)"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: critical
feasibility: medium
goal: property-model
required_by: [797b, 797d]
test262_fail: ~5000
subtask_of: 797
commit: 704379e4
---
# #797a -- Per-shape property flags table (compile-time)

## Implementation summary

Built a compile-time per-shape property descriptor table: `Map<structTypeIdx, Map<fieldName, {writable, enumerable, configurable}>>`. Property attributes are resolved statically during struct registration. No runtime flags array needed -- the compiler knows all struct types and their fields at compile time. Default: all true, updated by Object.defineProperty/freeze/seal calls detected in source.

Commit: 704379e4
