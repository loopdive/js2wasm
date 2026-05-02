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

| Issue | Title | Priority | Agent |
|---|---|---|---|
| #1234 | Array.prototype getter/setter fallback in object literals (PR #144, investigating 28 regressions) | medium | dev-1222 |
| #1231 | perf: struct field type inference Phase 2 — gate graduation, test coverage, WAT snapshot guard | high | dev-1231 |
| #1235 | ci: baseline drift fix — workflow_run trigger on refresh-committed-baseline.yml | high | dev-1118 |
| #1229 | perf: eval/RegExp LRU cache + peephole rewrite (7 compile_timeouts) | medium | queued |

### Blocked

| Issue | Title | Why blocked |
|---|---|---|
| #1177 Stage1 | TDZ Stage 1 — re-land capture-index correction | PR #125 closed: fix causes 59 new compile_timeout + 81 real regressions (net=-16). Stage 1 is still unsafe despite Stages 2&3 landing. Needs deep investigation. |
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign | Blocked on #1177 Stage1 |

### Ready

| Issue | Title | Priority | Blocked by |
|---|---|---|---|
| #1238 | IR Phase 4 Slice 13b — pseudo-ExternClassInfo registration for String + Array | high | — (1169o/p done) |
| #1232 | IR Phase 4 Slice 13c — String fixed-signature methods through IR | high | #1238 |
| #1229 | perf: eval/RegExp LRU cache + peephole rewrite (7 compile_timeouts) | medium | — |
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign | medium | #1177 |
| #1244 | npm stress test: compile Hono web framework to Wasm — Tier 1 (router math primitives) lands; Tier 2+ blocked on #1247 (typed `string[]` struct mismatch) + #1248 (typeof-string narrowing) + class private-field semantics | medium | — |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1228 | IR selector widening: void return + any params — PR #142 merged (admin, drift-proven by #143 cross-check) | high | done |
| #1231 Phase 1 | perf: struct field type inference Phase 1 — PR #143 merged; TypeMap seam documented; env-gated JS2WASM_IR_OBJECT_SHAPES=1 | high | done |
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

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign path (#1205 follow-up) | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1229 | perf: eval(literal) and new RegExp(literal) re-compile every iteration in 65k-loop tests | medium | ready |
| #1232 | IR Phase 4 Slice 13c — String fixed-signature methods through IR | high | ready |
| #1235 | ci: prevent baseline drift false-positive regressions after admin-merges | high | ready |
| #1238 | IR Phase 4 Slice 13b — pseudo-ExternClassInfo registration for String + Array | high | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1231 | perf: struct field type inference — eliminate boxing in object properties | high | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1118 | Worker/timeout exits and eval-code null deref (182 tests) | medium | done |
| #1157 | RegExp constructor called with flags='undefinedy' from String.prototype method paths (~288 test262 regressions) | high | done |
| #1169n | IR Phase 4 Slice 11 — switch statements + missing binary/unary operators through IR | high | done |
| #1169o | IR Phase 4 Slice 12 — dynamic element access + array literals through IR | high | done |
| #1169p | IR Phase 4 Slice 13 — String + Array prototype methods through IR | medium | done |
| #1169q | IR Phase 4 Slice 14 — retire legacy codegen: delete expressions.ts, statements.ts, repair passes | high | done |
| #1195 | perf: escape-analysis scalarization for non-escaping arrays (eliminate array allocation in array-sum) | high | done |
| #1196 | perf: bounds-check elimination via SSA on monotonic indexed array loops | high | done |
| #1197 | perf: i32 element specialization for `number[]` arrays under `\| 0` / `& mask` / `>> n` patterns | high | done |
| #1198 | perf: pre-size dense arrays at allocation site (`const a = []; for ... a[i] = ...` → `new Array(n)`) | high | done |
| #1207 | perf(test262): root-cause and fix the 136 compile_timeout tests (~7.6 min wall-clock cost per run) | high | done |
| #1216 | ci: auto-commit playground benchmark baseline on push-to-main (architectural follow-up to #1214) | medium | done |
| #1222 | ci: wasm-hash noise filter — exclude byte-identical regressions from PR gate | high | done |
| #1224 | class method dstr-parameter defaults: Cannot destructure null/undefined — guard fires before default is applied (408 failures) | high | done |
| #1225 | Nested destructuring from null/undefined: missing TypeError (~244 tests in for-of/dstr, assignment/dstr, class/dstr) | high | done |
| #1226 | class/elements: static async private method produces invalid Wasm — call missing argument (~104 tests) | high | done |
| #1227 | fix(runner): compiler-pool timeout starts at enqueue time, not dispatch time — causes 156 false compile_timeouts | high | done |
| #1228 | IR selector widening: accept void return + any params | high | done |
| #1234 | Array.prototype.{unshift,reverse,forEach,…} on non-Array receivers iterate [0, length) instead of defined props | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
