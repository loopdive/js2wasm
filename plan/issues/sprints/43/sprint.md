---
id: 43
status: done
---

# Sprint 43

**Date**: 2026-04-20 → 2026-04-23
**Starting baseline**: inherited from sprint 42
**Ending baseline**: 24,483 / 43,172 = 56.7% (unchanged — IR work is infrastructure, not test262 coverage)

## Carry-over from Sprint 42

All issues below were not started in sprint 42 and carried over. Issues with open PRs from sprint 42 remain in sprint 42 until merged.

## Issues

**Top priority**: #1131 — Middle-end SSA IR: implementation plan (phase 2 of #1124 audit)

<!-- populated from plan/issues/sprints/43/*.md -->

## Results

**3 PRs merged:**
- **PR #160** — #1076 CI merge split (merge-report + regression-gate jobs separated)
- **PR #231** — #1131 IR Phase 1 (SSA IR scaffold: nodes, builder, verify, emit stubs)
- **PR #258** — #1131 IR Phase 2 (interprocedural type propagation + call support)

**2 issues completed** (from issue tables): #826 illegal cast residuals, #1127 nested rest patterns

**Baseline held at 24,483** — IR phases are infrastructure; no new test262 coverage expected until IR path handles real workloads (#1168+).

**Most sprint 43 spec issues not reached** — #1152, #1160, #1161, #1162, #1163 and all IR Phase 3 work (#1167a/b/c, #1168) carried to sprint 44.

**Sprint 43 was short** (~3 days) and strategic: it laid the entire IR middle-end foundation that sprint 44's production-readiness work depends on.

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
