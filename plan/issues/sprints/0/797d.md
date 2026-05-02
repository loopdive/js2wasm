---
id: 797d
title: "#797d -- Object.freeze/seal/preventExtensions compile-away"
status: done
created: 2026-03-26
updated: 2026-04-14
completed: 2026-03-26
priority: high
feasibility: medium
goal: error-model
depends_on: [797a]
subtask_of: 797
commit: 2c91aa49
---
# #797d -- Object.freeze/seal/preventExtensions compile-away

## Implementation summary

Object.freeze, Object.seal, and Object.preventExtensions are compiled away at compile time. When the compiler detects these calls on a known struct type, it updates the static descriptor table (#797a) and emits TypeError throws for subsequent writes to frozen/sealed fields. Zero runtime overhead -- no flags checked at runtime. Key principle: compile away, don't emulate.

Commit: 2c91aa49
