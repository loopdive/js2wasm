---
id: 45
status: planned
created: 2026-04-23
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 45

**Date**: TBD (follows sprint 44)
**Baseline**: TBD (inherits from sprint 44 close-out)
**Source**: Triaged out of sprint 44 on 2026-04-23 to keep the week-long sprint
focused on the IR Phase 3/4 critical path, #1153 compiler crashes, and the
highest-impact spec-completeness fixes.

## Goal

Absorb the overflow from sprint 44. Headline themes:

1. **Drain the performance / numeric-inference queue** — #1120, #1121, #1122,
   #1126 form a coherent int32-fast-path block; pair them with benchmarking
   infrastructure (#1005, #1125) so improvements are measurable.
   - **Crash bucket surfaced by #1125 verification (added 2026-04-27, high
     priority):** #1173 (array-sum: 'exact' ref types reject by wasmtime 44),
     #1174 (object-ops: `string_constants` host import leaks on `--target
     wasi`), #1175 (string-hash: `__str_flatten` / `concat` type-mismatch in
     wasm-validator). All three are basic JS patterns (array fill, object
     literals, string concat) that crash js2wasm today and block the
     competitive-benchmark `js2wasm → Wasmtime` lane on 3 of 5 programs.
   - **Follow-ups from the post-fix benchmark refresh (added 2026-04-27,
     high priority):** #1178 (string-hash hits `wasm trap: call stack
     exhausted` at runtime after #1175 — fix is correct as compile-time
     type fix but introduces deep recursion at runtime), #1179 (array-sum
     hot runtime is ~9× slower than Node and ~14% slower than Javy —
     need to investigate WasmGC array element-type / bounds-check / growth
     overhead).
2. **CI baseline-drift hardening** — the 5-issue set (#1076, #1077, #1078,
   #1079, #1080) that was held back from sprint 44 because the IR work could
   not tolerate CI turbulence.
3. **Platform / host surfaces** — WASI, Node builtins, DOM globals, CJS, the
   standalone Wasmtime demo. Grouped because they share the host-import
   architecture.
4. **Second tier spec buckets** — #862, #906, #907, #1025, #1111, #1128. High
   cost / lower per-issue return than what stayed in sprint 44.
5. **Contributor-readiness / maintainability chores** — issue-metadata
   normalization, `as unknown as Instr` cleanup, patch-layer audit, docs page.

Secondary: pick up eval host-import + dynamic-eval (#1006, #1164) once the
static-eval fast path (#1163, staying in sprint 44) lands.

## How this sprint was built

Sprint 44 was groomed on 2026-04-22 from 15 sprint-43 carry-overs plus the IR
Phase 3 chain and fresh spec-completeness work. By 2026-04-23 it had grown to
74 issue files — too many for a single week of agent token budget.

Sprint 45 is the overflow. Sprint 44 keeps 21 issues:

- The IR chain: #1153 (crash-free), #1166, #1167, #1167a, #1167b, #1167c, #1168, #1169
- The ES2015 SingleNameBinding quick win: #1119
- Top-impact spec fixes: #825, #854, #1016, #1148, #1149, #1150, #1152, #1156, #1160, #1161, #1162, #1163

Everything else that was tagged `sprint: 44` but did not fit this week was
moved here. No issues were rescoped, rejected, or deleted — only relocated.

## Triage rules applied (sprint 44 → 45)

- **Blocked, off the sprint-44 IR critical path** → moved: #742
- **Superseded monomorphization issues (rolled into #1167c + #1168)** → moved:
  #744, #773
- **30-second compiler-timeout bucket** → moved as a group to tackle together:
  #991, #992, #993, #994, #995, #996
- **Pure performance / benchmark work** → moved: #1001, #1004, #1005, #1058,
  #1120, #1121, #1122, #1125, #1126
- **CI baseline-drift hardening (5-issue set best done together, not during
  the heavy IR sprint)** → moved: #1076, #1077, #1078, #1079, #1080
- **Contributor-readiness + maintainability chores** → moved: #1000, #1003,
  #1086, #1095, #1096, #1098, #1147
- **npm-library / Node / DOM / WASI platform work** → moved: #1035, #1043,
  #1044, #1045, #1067, #1073, #1075, #1099, #1109
- **Wrapper-object and large remaining spec buckets (high cost, lower
  per-issue return this week)** → moved: #862, #906, #907, #1025, #1111, #1128
- **Eval runtime infrastructure (kept static inlining #1163 in sprint 44)**
  → moved: #1006, #1164
- **Landing page / docs / component work** → moved: #1123, #1147, #1008
- **Large architectural audits (hard+max, need dedicated attention)** → moved:
  #1093, #1094
- **Make-iterable destructuring bug (high priority, but not in-flight and no
  room this week)** → moved: #1135

## Results

**Interim (2026-04-27)** — Baseline: 25802/43168 pass (59.8%)

| Issue | Status | PR |
|-------|--------|----|
| #1169f (IR slice 7b — generators/async) | merged | #73 (+1202 net, admin-merged at 10.8%) |
| #1169e (IR slice 6 — iterators/for-of) | done | earlier |
| #1185 (IrLowerResolver refactor) | merged | #72 (+1398 net) |
| #1186 (for-of string charAt fix) | merged | #75 (+1234 net) |
| #1177 (TDZ closure captures) | open | #76 (14.7% regr, snapshot_delta=-31, held for S46 investigation) |
| #1173, #1174, #1175, #1178, #1179 | done | earlier sprints |
| #1120, #1121, #1125, #1128, #1164 | done | earlier |

9 unstarted issues deferred to S46: #1080, #1126, #1169, #1169g/h/i, #1180, #1187, #1188.
6 new perf issues (#1195–#1200) staged for S47 by dev-1125-bench.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1192 | ci(self-merge): exclude compile_timeout transitions from regression count (runner noise) | medium | in-progress |
| #1193 | tooling: ci-status-watcher.sh hook doesn't push notifications to dev agents (uses gh @me which resolves to human, not agent) | medium | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #862 | Iterator protocol missing on function-declaration binding-pattern params | medium | done |
| #906 | Compile away TDZ tracking for definite-assignment top-level numeric locals | high | done |
| #907 | Replace __init_done runtime guards with start/init entry semantics | high | done |
| #991 | Iterator helper generator-reentrancy tests hit 30s compiler timeout | high | done |
| #992 | Iterator.prototype.take limit-less-than-total hits 30s compiler timeout | medium | done |
| #993 | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compiler timeout | high | done |
| #994 | Class static-private-getter test hits 30s compiler timeout | medium | done |
| #995 | String.prototype.localeCompare 15.5.4.9_CE hits 30s compiler timeout | low | done |
| #996 | Array.prototype.toSorted comparefn-not-a-function hits 30s compiler timeout | low | done |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | done |
| #1025 | BindingElement array-pattern default guards still use ref.is_null | high | done |
| #1035 | WASI hello-world: compile console.log + node:fs write to a standalone native executable | high | done |
| #1035 | WASI hello-world: compile console.log + node:fs write to a standalone native executable | high | done |
| #1043 | Compile-time `process.env.NODE_ENV` substitution + dead-branch elimination | high | done |
| #1043 | Compile-time `process.env.NODE_ENV` substitution + dead-branch elimination | high | done |
| #1076 | CI: split merge job into merge-report + regression-gate so push-to-main always refreshes baseline | critical | done |
| #1076 | CI: split merge job into merge-report + regression-gate so push-to-main always refreshes baseline | critical | done |
| #1077 | CI: PR CI should fetch fresh baseline from origin/main at runtime, not read branch-tip copy | high | done |
| #1077 | CI: PR CI should fetch fresh baseline from origin/main at runtime, not read branch-tip copy | high | done |
| #1078 | CI: emergency baseline-refresh workflow_dispatch — discoverable and unconditional promotion | medium | done |
| #1078 | CI: emergency baseline-refresh workflow_dispatch — discoverable and unconditional promotion | medium | done |
| #1079 | CI: baseline age stamp + SHA on landing page — make drift observable before crisis | medium | done |
| #1086 | codegen: dedup and memoize bodyUsesArguments to eliminate #96's O(N²) re-walk | medium | done |
| #1096 | Isolate environment adapters — remove top-level await and browser/Node probing from core modules | medium | done |
| #1096 | Isolate environment adapters — remove top-level await and browser/Node probing from core modules | medium | done |
| #1109 | lodash-es clamp: Wasm validation error in typeof/RegExp codegen path | medium | done |
| #1111 | Wrapper object constructors: new Number/String/Boolean (648 tests) | medium | done |
| #1120 | Add int32 fast path for bitwise-coerced numeric loops in hot benchmarks | high | done |
| #1121 | Infer numeric recursive fast path without JSDoc hints on exported entrypoints | high | done |
| #1125 | Add ComponentizeJS-based StarlingMonkey benchmark setup with Wizer and Weval | high | done |
| #1128 | Destructuring TDZ and AnnexB B.3.3 function-in-block hoisting (≥211 tests) | medium | done |
| #1135 | `__make_iterable` breaks Wasm-to-Wasm vec→externref destructuring after setExports | high | done |
| #1164 | Dynamic eval via JS host import — compile eval string to ad-hoc Wasm module (~416 tests) | medium | done |
| #1169a | IR Phase 4 Slice 1 — strings, typeof, null/undefined checks through the IR path | high | done |
| #1169b | IR Phase 4 Slice 2 — object literals and property access through IR path | high | done |
| #1169c | IR Phase 4 Slice 3 — closures (captures, ref cells, transitive captures) through the IR path | high | done |
| #1169c | IR Phase 4 Slice 3 — closures (captures, ref cells, transitive captures) through the IR path | high | done |
| #1169d | IR Phase 4 Slice 4 — class instantiation and method calls through the IR path | high | done |
| #1169d | IR Phase 4 Slice 4 — class instantiation and method calls through the IR path | high | done |
| #1169e | IR Phase 4 Slice 6 — iterators and for-of through the IR path | high | done |
| #1169f | IR Phase 4 Slice 7 — generators and async/await through the IR path | high | done |
| #1169f | IR Phase 4 Slice 7 — generators and async/await through the IR path | high | done |
| #1169g | IR Phase 4 Slice 8 — destructuring and rest/spread through the IR path | high | done |
| #1169h | IR Phase 4 Slice 9 — try/catch/finally and throw through the IR path | high | done |
| #1169i | IR Phase 4 Slice 10 — remaining builtins (RegExp, TypedArray, DataView) through the IR path | high | done |
| #1170 | Move test262 baselines out of Git LFS — eliminate LFS dependency from CI | high | done |
| #1171 | Fix test262 timeout non-determinism — raise testTimeout to 30s, bust CI cache on config change | high | done |
| #1173 | js2wasm output uses 'exact' reference types that wasmtime 44 rejects (array-sum benchmark crash) | high | done |
| #1174 | js2wasm emits `string_constants` host import on `--target wasi` builds (object-ops benchmark crash) | high | done |
| #1175 | String concatenation emits type-mismatched call args (`__str_flatten`, `concat`) failing wasm-validator | high | done |
| #1177 | TDZ propagation through closure captures — fix ReferenceError on pre-declaration capture | high | done |
| #1177 | TDZ propagation through closure captures — fix ReferenceError on pre-declaration capture | high | done |
| #1178 | string-hash benchmark hits `wasm trap: call stack exhausted` at runtime after #1175 fix | high | done |
| #1179 | Improve js2wasm `array-sum` hot-runtime perf — currently ~9× slower than Node and behind Javy | high | done |
| #1179-followup | i32 fast path for `*` is not spec-faithful when true product exceeds 2^53 | medium | done |
| #1181 | IR Phase 4 Slice 6 part 2 — AST→IR bridge for vec for-of (#1169e follow-up) | high | done |
| #1181 | IR Phase 4 Slice 6 part 2 — AST→IR bridge for vec for-of (#1169e follow-up) | high | done |
| #1182 | IR Phase 4 Slice 6 part 3 — host iterator protocol through the IR (`iter.*` instrs, Map/Set/generator iteration) | medium | done |
| #1182 | IR Phase 4 Slice 6 part 3 — host iterator protocol through the IR (`iter.*` instrs, Map/Set/generator iteration) | medium | done |
| #1183 | IR Phase 4 Slice 6 part 4 — string fast path through the IR (`for (c of \"hello\")`) | medium | done |
| #1183 | IR Phase 4 Slice 6 part 4 — string fast path through the IR (`for (c of \"hello\")`) | medium | done |
| #1185 | IR Phase 4 — refactor: thread `IrLowerResolver` through `LowerCtx` (retire per-feature shortcuts) | medium | done |
| #1185 | IR Phase 4 — refactor: thread `IrLowerResolver` through `LowerCtx` (retire per-feature shortcuts) | medium | done |
| #1186 | fix(legacy): re-resolve native-string helpers post-shift in compileForOfString (stale __str_charAt funcIdx) | high | done |
| #1186 | fix(legacy): re-resolve native-string helpers post-shift in compileForOfString (stale __str_charAt funcIdx) | high | done |
| #1202 | credibility: Architecture Decision Records — document the 8 core design choices that define js2wasm | high | done |
| #1202 | credibility: Architecture Decision Records — document the 8 core design choices that define js2wasm | high | done |
| #1208 | landing: surface ADRs — rename 'How it works' to 'Approach', add Architecture section with ADR HTML renderings | high | done |
| #1208 | landing: surface ADRs — rename 'How it works' to 'Approach', add Architecture section with ADR HTML renderings | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
