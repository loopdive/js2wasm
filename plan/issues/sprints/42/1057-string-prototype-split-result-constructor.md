---
id: 1057
title: "String.prototype.split result constructor !== Array"
status: done
created: 2026-04-11
updated: 2026-04-12
completed: 2026-04-14
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: test262-harvest-cluster
goal: test-infrastructure
closed: 2026-04-12
pr: 130
es_edition: multi
---
## Implementation Summary

Fixed vec-struct constructor short-circuit in `src/runtime.ts`.
The `__extern_get` resolver now uses a `__vec_len` probe to positively
identify vec wrappers before returning Array as the constructor.
Only objects for which `__vec_len(obj)` returns a number are treated
as arrays; class instances and closures throw and fall through.

Result: +1 test262 pass, 0 regressions.
