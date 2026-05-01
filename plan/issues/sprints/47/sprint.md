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
  begin_tag_pushed: false
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

| Issue | Title | Priority | Agent | PR |
|---|---|---|---|---|
| #1177 | TDZ Stage 1 — re-land capture-index correction (fix + revert = net zero on PR #76) | high | tech-lead | #125 |
| #1222 | ci: wasm-hash noise filter — exclude byte-identical regressions from PR gate | high | dev-1222 | pending |
| #1224 | class method dstr-parameter defaults: null-guard fires before default is applied (408 failures) | high | dev-1224 | pending |
| #1169n | IR Phase 4 Slice 11 — switch statements + missing binary/unary operators | high | dev-1169n | pending |

### Ready

| Issue | Title | Priority | Blocked by |
|---|---|---|---|
| #1169o | IR Phase 4 Slice 12 — dynamic element access + array literals | high | #1169n |
| #1169p | IR Phase 4 Slice 13 — String + Array prototype methods | medium | #1169o |
| #1169q | IR Phase 4 Slice 14 — retire legacy codegen | high | #1169n, #1169o, #1169p |
| #1195 | perf: escape-analysis scalarization for non-escaping arrays | high | — |
| #1207 | perf(test262): root-cause and fix the 136 compile_timeout tests | high | — |
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign | medium | #1177 |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1196 | perf: bounds-check elimination (landed in S46) | high | done |
| #1197 | perf: i32 element specialization (landed in S46) | high | done |
| #1198 | perf: pre-size dense arrays (landed in S46) | high | done |
| #1216 | ci: auto-commit playground benchmark baseline (landed in S46) | medium | done |

## Retrospective

TBD

<!-- GENERATED_ISSUE_TABLES_END -->
