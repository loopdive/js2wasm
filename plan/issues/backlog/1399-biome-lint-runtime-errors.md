---
id: 1399
sprint: null
title: "chore: fix 9 biome lint errors in src/runtime.ts"
status: ready
created: 2026-05-09
priority: low
feasibility: easy
reasoning_effort: low
task_type: chore
area: runtime
---
# #1399 — Fix biome lint errors in src/runtime.ts

## Background

`pnpm biome lint --diagnostic-level=error src/ tests/ scripts/` reports 9 errors,
all in `src/runtime.ts`. These cause the CI `quality` check to fail on every PR.
The auto-fixable ones were already applied (4 arrow-function conversions, S52 sprint-end).
The remaining 9 require manual fixes or suppression comments.

## Errors

| Line | Rule | Action |
|------|------|--------|
| 2042 | `complexity/noUselessCatch` | Remove the useless catch (it just rethrows) |
| 2092 | `style/noCommaOperator` | Rewrite to avoid comma operator |
| 2197 | `style/noCommaOperator` | Rewrite to avoid comma operator |
| 2092 | `security/noGlobalEval` | Add `// biome-ignore lint/security/noGlobalEval: intentional test262 runtime eval` |
| 2197 | `security/noGlobalEval` | Same suppression — intentional eval in test harness |
| 4528 | `suspicious/noDoubleEquals` | Change `==` → `===` (FIXABLE) |
| 4537 | `suspicious/noSelfCompare` | Likely `x !== x` NaN check — add suppression comment explaining intent |
| 4537 | `suspicious/noSelfCompare` | Same line, second instance |

## Acceptance criteria

- `pnpm biome lint --diagnostic-level=error src/ tests/ scripts/` exits 0
- CI `quality` check passes on PRs
- No functional changes — only structural rewrites or targeted `biome-ignore` suppressions
  where the pattern is intentional (eval in test harness, NaN self-compare)

## Notes

The `noGlobalEval` violations are in the test262 runtime harness where `eval()` is
legitimately needed. Use biome suppression comments, not removal.

The `noSelfCompare` at line 4537 is likely `x !== x` for NaN detection — standard JS
idiom. Add a suppression with an explanation.
