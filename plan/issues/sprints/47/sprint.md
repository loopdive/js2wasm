---
id: 47
status: active
created: 2026-05-01
groomed: 2026-05-01
started: 2026-05-01
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 47

**Date**: 2026-05-01 → TBD
**Baseline**: 27,104 / 46,632 = 58.1% pass (at S46 close, after #1177/#1219/#1220/#1221)
**Created**: 2026-05-01 — seeded from S46 analysis + failure landscape review
**Groomed**: 2026-05-01 — tech lead + PO session

## Goals

1. **IR migration completion** — advance IR slices 11–14 to cover switch, missing operators, element access, array literals, and prototype methods; retire legacy codegen
2. **Test262 conformance** — fix class/dstr default parameter ordering (408 failures), TDZ destructure-assign writer+reader
3. **CI quality** — wasm-hash noise filter to eliminate symmetric flip false positives
4. **Performance** — escape-analysis scalarization for array-sum benchmark (9× gap vs V8)

## Sprint issues

### In Progress

_(none)_

### Blocked

| Issue | Title | Why blocked |
|---|---|---|
| #1177 Stage1 | TDZ Stage 1 — re-land capture-index correction | PR #125 closed: fix causes 59 new compile_timeout + 81 real regressions (net=-16). Stage 1 is still unsafe despite Stages 2&3 landing. Needs deep investigation. |
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign | Blocked on #1177 Stage1 |

### Ready

| Issue | Title | Priority | Blocked by |
|---|---|---|---|
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign | medium | #1177 |
| #1229 | perf: struct field type inference — eliminate boxing in object properties | high | needs architect spec |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1225 | Nested dstr from null/undefined: missing TypeError — fixed in PR #130 (net +32, ~244 tests) | high | done |
| #1169q | IR Phase 4 Slice 14 — telemetry landed (PR #141); deletion deferred (0% claim on untyped corpus — selector needs any/void widening first) | high | done |
| #1222 | ci: wasm-hash noise filter — exclude byte-identical regressions from PR gate | high | done |
| #1169o | IR Phase 4 Slice 12 — dynamic element access + array literals (PR #132) | high | done |
| #1118 | obj-literal methods: callable closure refs + struct-dedup by signature (PR #140) | high | done |
| #1169p | IR Phase 4 Slice 13 — arr.length on vec receivers through IR (PR #138) | medium | done |
| #1169n | IR Phase 4 Slice 11 — switch + missing binary/unary operators | high | done |
| #1207 | perf(test262): root-cause 156 compile_timeouts — all queue-wait noise (#1227 fixes) | high | done |
| #1224 | class/dstr defaults: investigation done, 2 root causes found, tests added | high | done |
| #1226 | class/elements: static async private method — tests added (bug already fixed) | high | done |
| #1195 | perf: array-reduce-fusion — eliminate temp array in fill+reduce shape | high | done |
| #1227 | fix(runner): pool timer fires at dispatch, not enqueue — 156 false CTs fixed | high | done |
| #1196 | perf: bounds-check elimination (landed in S46) | high | done |
| #1197 | perf: i32 element specialization (landed in S46) | high | done |
| #1198 | perf: pre-size dense arrays (landed in S46) | high | done |
| #1216 | ci: auto-commit playground benchmark baseline (landed in S46) | medium | done |

## Retrospective

TBD

<!-- GENERATED_ISSUE_TABLES_END -->

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | ready |
| #1169q | IR Phase 4 Slice 14 — retire legacy codegen: delete expressions.ts, statements.ts, repair passes | high | ready |
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign path (#1205 follow-up) | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1118 | Worker/timeout exits and eval-code null deref (182 tests) | medium | in-progress |
| #1169p | IR Phase 4 Slice 13 — String + Array prototype methods through IR | medium | in-progress |
| #1195 | perf: escape-analysis scalarization for non-escaping arrays (eliminate array allocation in array-sum) | high | in-progress |
| #1225 | Nested destructuring from null/undefined: missing TypeError (~244 tests in for-of/dstr, assignment/dstr, class/dstr) | high | in-progress |

### Review

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1169o | IR Phase 4 Slice 12 — dynamic element access + array literals through IR | high | review |
| #1207 | perf(test262): root-cause and fix the 136 compile_timeout tests (~7.6 min wall-clock cost per run) | high | review |
| #1227 | fix(runner): compiler-pool timeout starts at enqueue time, not dispatch time — causes 156 false compile_timeouts | high | review |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1157 | RegExp constructor called with flags='undefinedy' from String.prototype method paths (~288 test262 regressions) | high | done |
| #1169n | IR Phase 4 Slice 11 — switch statements + missing binary/unary operators through IR | high | done |
| #1196 | perf: bounds-check elimination via SSA on monotonic indexed array loops | high | done |
| #1197 | perf: i32 element specialization for `number[]` arrays under `\| 0` / `& mask` / `>> n` patterns | high | done |
| #1198 | perf: pre-size dense arrays at allocation site (`const a = []; for ... a[i] = ...` → `new Array(n)`) | high | done |
| #1216 | ci: auto-commit playground benchmark baseline on push-to-main (architectural follow-up to #1214) | medium | done |
| #1222 | ci: wasm-hash noise filter — exclude byte-identical regressions from PR gate | high | done |
| #1224 | class method dstr-parameter defaults: Cannot destructure null/undefined — guard fires before default is applied (408 failures) | high | done |
| #1226 | class/elements: static async private method produces invalid Wasm — call missing argument (~104 tests) | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
