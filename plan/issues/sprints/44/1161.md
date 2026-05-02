---
id: 1161
title: "Cannot destructure null/undefined in private class method params (~429 dstr tests)"
status: done
created: 2026-04-21
updated: 2026-04-28
completed: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
language_feature: destructuring
goal: crash-free
closed: 2026-04-23
pr: 12
net_improvement: 396
---
# #1161 — Destructure null/undefined in private class method params (429 tests)

## Problem

429 test262 `dstr` failures report:

```
Cannot destructure 'null' or 'undefined' [in C___priv_method()]
Cannot destructure 'null' or 'undefined' [in __anonClass_N___priv_method()]
Cannot destructure 'null' or 'undefined' [in C_method()]
```

The test intent is to verify that destructuring `null`/`undefined` throws a `TypeError`. But instead of a conformant TypeError, the compiler throws its own internal "Cannot destructure" error — meaning the check fires at compile time or at the wrong layer.

## Root cause hypothesis

The `RequireObjectCoercible` check in the destructuring param path (`destructureParamArray` / `destructureParamObject`) is implemented as an early throw rather than emitting a Wasm TypeError trap. Private method params go through a slightly different codegen route than public methods.

## Investigation

1. Find the "Cannot destructure" throw site in `src/codegen/destructuring-params.ts`
2. Check if private method params route through the same `RequireObjectCoercible` emission as public methods (see PR #225 which fixed this for regular destructuring)
3. Verify the fix extends to private method contexts (`#method`)

## Acceptance criteria

- `class C { #m([x]) {} }; new C().#m(null)` throws `TypeError`
- 429 `Cannot destructure` errors in test262 drop to 0
- No regressions in equivalence tests
