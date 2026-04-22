---
id: 43
status: planned
---

# Sprint 43

**Date**: 2026-04-20 →
**Baseline**: TBD (pending sprint 42 consolidation)
**Target points**: TBD (pending velocity calibration from #1133)

## Carry-over from Sprint 42

All issues below were not started in sprint 42 and carried over. Issues with open PRs from sprint 42 remain in sprint 42 until merged.

## Issues

**Top priority**: #1131 — Middle-end SSA IR: implementation plan (phase 2 of #1124 audit)

<!-- populated from plan/issues/sprints/43/*.md -->

## Results

TBD

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1119 | Incremental compiler state leak — CompilerPool fork produces ~400 false CEs | high | ready |
| #1127 | Nested rest patterns fail to decode even with explicit args — [...[x,y,z]], [...{length}], [...[,]] | medium | ready |
| #1131 | Middle-end SSA IR: implementation plan | high | ready |
| #1131 | Middle-end SSA IR: implementation plan | high | ready |
| #1148 | Investigate skip:103 regression — Annex B eval-code skip filter | high | ready |
| #1152 | Array.prototype higher-order methods fail with 'object is not a function' after PR #195 __get_builtin change (~217 test262 regressions) | high | ready |
| #1160 | Array.from codegen error — property of first arg must be integer (730 tests) | high | ready |
| #1161 | Cannot destructure null/undefined in private class method params (~429 dstr tests) | high | ready |
| #1162 | yield* async — unexpected undefined AST node in compileExpression (~161 tests) | high | ready |
| #1163 | Static eval inlining — compile eval(\"fixed string\") at compile time (~208 tests) | high | ready |
| #1167 | SSA IR Phase 3 — optimization passes (meta issue — see 1167a/b/c) | high | ready |
| #1167a | IR Phase 3a — hygiene passes: constant-fold, dead-code, simplify-cfg | high | ready |
| #1167b | IR Phase 3b — inline-small: inline direct IR calls before lowering | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1008 | Add mobile-first layout support to the playground | medium | in-progress |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | in-progress |
| #1149 | Fix null_deref:32 — eval-code direct methods with arguments declare | high | in-progress |
| #1150 | Fix runtime_error:26 + type_error:7 + oob:5 — async destructuring regressions | high | in-progress |
| #1153 | Compiler-internal crashes block ~3,585 test262 tests: commentDirectiveRegEx.exec, constructSigs.reduce, cache.set | critical | in-progress |
| #1156 | Array.prototype method-as-value called with non-function arg produces 'number N is not a function' (~164 tests) | medium | in-progress |

### Review

| Issue | Title | Priority | Status |
|---|---|---|---|
| #825 | Null dereference failures (2,295 runtime failures) | high | review |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #826 | Illegal cast failures (1,276 runtime failures) | high | done |
| #1127 | Class method param destructuring: nested array pattern + initializer throws spurious TypeError | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
