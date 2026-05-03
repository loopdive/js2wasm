---
id: 49
status: planning
created: 2026-05-03
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: false
---

# Sprint 49

**Planned**: 2026-05-03 — seeded from S48 analysis

## Goals

1. **test262 runner performance** — TS7 batch-parse via `@typescript/native-preview` (#1290, 132× cold speedup)
2. TBD — carry from S48 as issues complete

## Sprint issues

### Ready

| Issue | Title | Priority |
|---|---|---|
| #1290 | test262 runner: TS7 batch-parse via @typescript/native-preview (132× speedup) | high |

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1223 | TDZ async/gen: writer+reader fn-decl sharing via destructure-assign path (#1205 follow-up) | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1199 | perf: linear-memory backing for typed numeric arrays (`Array<number>` with i32-only ops → `i32.load`/`i32.store`) | medium | ready |
| #1241 | Untitled |  | ready |
| #1298 | Calling a function-typed value stored in a field/array/Map drops the call and returns null | high | ready |
| #1302 | Wasm validation: closure references invalid global index when compiling lodash flow.js | medium | ready |
| #1303 | Wasm validation: f64.trunc emitted on externref operand when compiling lodash partial.js | medium | ready |
| #1305 | Module-level var init leaks externref into bitwise op codegen (legacy path) | medium | ready |
| #1306 | ElementAccessExpression call on closure-typed array drops call: mws[idx](c, next) emits ref.null | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | in-progress |
| #1301 | Closure environment field-type mismatch: struct.new[0] expected f64, got anyref | medium | in-progress |
| #1304 | typeof on externref-wrapped JS function returns 'object' instead of 'function' | medium | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1290 | perf: test262 runner — TS7 batch-parse via @typescript/native-preview (132× cold speedup) | high | done |
| #1296 | Dogfood: compile dashboard/landing page JS to Wasm using js2wasm | medium | done |
| #1297 | Hono Tier 5 — Application class: route registration + middleware dispatch + Context | medium | done |
| #1299 | Virtual dispatch through abstract-base-typed dict values returns first stored subclass's method | medium | done |
| #1300 | Closure capturing outer parameter inside an inline lambda passed as a Next callback null-derefs at call time | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
