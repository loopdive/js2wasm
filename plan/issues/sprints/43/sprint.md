---
id: 43
status: planned
---

# Sprint 43

**Date**: 2026-04-20 →
**Baseline**: 24,483 / 43,172 pass (from 2026-04-22 sharded run)
**Triaged**: 2026-04-22 — 55 issues moved to sprint 44 to keep the week focused
on IR Phase 3a/3b + critical regressions + highest-impact spec fixes.

## Goal

1. Land IR Phase 3a (constant-fold + dead-code + simplify-cfg) and 3b
   (inline-small) on top of the Phase 2 SSA IR from #1131.
2. Complete #1166 (closed-world integer specialization) so the IR critical
   path delivers the integer fast-path end to end.
3. Drain the in-flight spec-regression cluster (#1148, #1149, #1150, #1152,
   #1153, #1156) that is already active from prior sprints.
4. Close the highest-impact standalone spec fixes now that the critical
   path is known (#1160 Array.from 730, #1161 destructure null 429,
   #1162 yield\* async 161, #1163 static eval inlining 208, #1152 +217 prop).

## Scope (20 issues)

### In-progress / review / done (carried through)

| Issue | Title | Priority | Status |
|---|---|---|---|
| #825  | Null dereference failures (2,295 runtime failures) | high | review |
| #826  | Illegal cast failures (1,276 runtime failures) | high | done |
| #1008 | Add mobile-first layout support to the playground | medium | in-progress |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | in-progress |
| #1127 | Class method param destructuring — nested array pattern + initializer throws | high | done |
| #1148 | Investigate skip:103 regression — Annex B eval-code skip filter | high | in-progress |
| #1149 | Fix null_deref:32 — eval-code direct methods with arguments declare | high | in-progress |
| #1150 | Fix runtime_error:26 + type_error:7 + oob:5 — async destructuring regressions | high | in-progress |
| #1153 | Compiler-internal crashes block ~3,585 test262 tests (prototype poisoning) | critical | in-progress |
| #1156 | Array.prototype method-as-value called with non-function arg (~164 tests) | medium | in-progress |

### IR critical path — Phase 3a/3b + closed-world int spec

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1131 | Middle-end SSA IR: implementation plan (Phase 1 + Phase 2) | high | hard/max |
| #1166 | Closed-world integer specialization from literal call sites | high | hard/max |
| #1167  | SSA IR Phase 3 — meta (split into 1167a/b/c; kept as reference) | high | split |
| #1167a | IR Phase 3a — hygiene passes: constant-fold + dead-code + simplify-cfg | high | medium |
| #1167b | IR Phase 3b — inline-small (depends on #1167a) | medium | medium |

### High-impact spec-completeness (ready, clear fix paths)

| Issue | Title | Priority | Tests |
|---|---|---|---|
| #1152 | Array.prototype higher-order methods 'object is not a function' after #195 | high | ~217 |
| #1160 | Array.from codegen error — property of first arg must be integer | high | 730 |
| #1161 | Cannot destructure null/undefined in private class method params | high | ~429 |
| #1162 | yield\* async — unexpected undefined AST node in compileExpression | high | ~161 |
| #1163 | Static eval inlining — compile eval("fixed string") at compile time | high | ~208 |

## Moved to Sprint 44 (55 issues)

See [plan/issues/sprints/44/sprint.md](../44/sprint.md) for the full list and
triage rationale. Summary:

- **Blocked / prerequisite**: #742, #1167c, #1168
- **Superseded by IR 3c**: #744, #773
- **Eval runtime**: #1006, #1164
- **30s compiler timeouts**: #991–#996
- **Performance / benchmarking**: #1001, #1004, #1005, #1058, #1120–#1122,
  #1125, #1126
- **CI baseline drift**: #1076–#1080
- **Contributor / maintainability**: #1000, #1003, #1086, #1095, #1096, #1098,
  #1147, #1067, #1123
- **Platform / host**: #1035, #1043–#1045, #1073, #1075, #1099, #1109
- **Large spec buckets**: #854, #862, #906, #907, #1025, #1111, #1128
- **Other**: #1093, #1094, #1119, #1135

## Results

TBD

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun
`node scripts/sync-sprint-issue-tables.mjs`._

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1131 | Middle-end SSA IR: implementation plan | high | ready |
| #1152 | Array.prototype higher-order methods fail with 'object is not a function' after PR #195 __get_builtin change (~217 test262 regressions) | high | ready |
| #1160 | Array.from codegen error — property of first arg must be integer (730 tests) | high | ready |
| #1161 | Cannot destructure null/undefined in private class method params (~429 dstr tests) | high | ready |
| #1162 | yield* async — unexpected undefined AST node in compileExpression (~161 tests) | high | ready |
| #1163 | Static eval inlining — compile eval("fixed string") at compile time (~208 tests) | high | ready |
| #1166 | Closed-world integer specialization from literal call sites | high | ready |
| #1167a | IR Phase 3a — hygiene passes: constant-fold, dead-code, simplify-cfg | high | ready |
| #1167b | IR Phase 3b — inline-small: inline direct IR calls before lowering | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1008 | Add mobile-first layout support to the playground | medium | in-progress |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | in-progress |
| #1148 | Investigate skip:103 regression — Annex B eval-code skip filter | high | in-progress |
| #1149 | Fix null_deref:32 — eval-code direct methods with arguments declare | high | in-progress |
| #1150 | Fix runtime_error:26 + type_error:7 + oob:5 — async destructuring regressions | high | in-progress |
| #1153 | Compiler-internal crashes block ~3,585 test262 tests | critical | in-progress |
| #1156 | Array.prototype method-as-value called with non-function arg (~164 tests) | medium | in-progress |

### Review

| Issue | Title | Priority | Status |
|---|---|---|---|
| #825 | Null dereference failures (2,295 runtime failures) | high | review |

### Split

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1167 | SSA IR Phase 3 — optimization passes (meta; see 1167a/b) | high | split |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #826 | Illegal cast failures (1,276 runtime failures) | high | done |
| #1127 | Class method param destructuring: nested array pattern + initializer throws | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
