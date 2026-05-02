---
id: 667
title: "'hint is not defined' in toPrimitive coercion (71 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: compilable
test262_ce: 71
files:
  src/codegen/type-coercion.ts:
    breaking:
      - "fix hint variable scope in toPrimitive dispatch"
---
# #667 — "hint is not defined" in toPrimitive coercion (71 CE)

## Status: open
71 tests fail with "Internal error: hint is not defined". The toPrimitive dispatch in type-coercion.ts references a `hint` variable that's not in scope in some code paths.
## Complexity: S
