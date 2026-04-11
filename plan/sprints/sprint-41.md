---
title: "Sprint 41 — Nullish long tail + 50% push"
status: planning
sprint: Sprint-41
---

# Sprint 41 — Nullish long-tail + 50% push

**Starting baseline**: ~20,711 pass / 43,164 total (47.98%) after Sprint 40 PR #67
**Target**: past 50% (21,582+)

## Context

Sprint 40 #1021 landed a **narrow** fix for the 5,989 "TypeError (null/undefined access)" bucket — it corrected destructuring default guards (`ref.is_null` → `__extern_is_undefined`) and promoted array literals containing a literal `null` token to preserve null vs undefined round-tripping.

Net impact was only ~+58 pass because the remaining ~5,900 failures in that bucket come from several distinct codegen paths that #1021 did **not** touch. This sprint files those sub-patterns as individual issues so they can land incrementally.

## #1021 Follow-up Sub-Issues

| # | Title | Estimated Impact | Pattern |
|---|-------|------------------|---------|
| [#1023](../issues/ready/1023.md) | `__unbox_number(null)` crashes — should apply ToNumber(null) = +0 | ~500-1500 FAIL | Unbox helpers crash on null |
| [#1024](../issues/ready/1024.md) | Destructuring rest elements + holes drop null vs undefined distinction | ~400-800 FAIL | `[a, ...rest]` / `[a, , b]` |
| [#1025](../issues/ready/1025.md) | `BindingElement` array-pattern default guards still use `ref.is_null` | ~300-900 FAIL | `function f([a = 1]) {}` and nested patterns |

Additional patterns to investigate (may become separate issues):
- for-of iterator protocol null vs undefined (overlaps #1016)
- Member/call receiver null access patterns that are not destructuring at all
- Spread `{...obj}` preserving null values distinctly

## Carry-in From Sprint 40

PRs still iterating at sprint boundary:
- PR #43 (#929 Object.defineProperty) — 56 regressions
- PR #59 (#1016 iterator) — awaiting CI re-check
- PR #64 (#983 opaque/ToPrimitive) — 33 regressions
- PR #65 (#1014 yield*) — 17 regressions
- PR #68 (#1022 Array methods) — 26 regressions
- PR #69 (#1017 class name binding) — 7 regressions
