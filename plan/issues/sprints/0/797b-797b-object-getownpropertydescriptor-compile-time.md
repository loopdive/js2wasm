---
id: 797b
title: "#797b -- Object.getOwnPropertyDescriptor compile-time resolution"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: medium
goal: contributor-readiness
depends_on: [797a]
subtask_of: 797
commit: 8aa2ff7d
---
# #797b -- Object.getOwnPropertyDescriptor compile-time resolution

## Implementation summary

`Object.getOwnPropertyDescriptor(obj, 'prop')` now reads from the static per-shape descriptor table (#797a) at compile time. Constructs a descriptor struct inline with constant values for writable/enumerable/configurable and the field value via struct.get. No runtime metadata needed for statically-known types.

Commit: 8aa2ff7d
