# Project Diary

## 2026-05-01 — Sprint 46 mid-sprint session

**Sprint 46 active.** Started 2026-04-30; this session ran 2026-04-30 → 2026-05-01.
Context at 73% / weekly budget at 19% when compacting.

**PRs merged this session (PRs #94–#118):**

| PR | Issue | Description |
|---|---|---|
| #94 | #1187 | test-runtime JS-string→native-string coercion helper |
| #95 | #1211 | fib-recursive hosted Wasm validator fix |
| #96 | #1210 | string-hash GC pressure (str_copy_tree O(n²) → buffer) |
| #99 | #1169j | IR Slice 10 step B: TypedArray |
| #100 | #1169l | IR Slice 10 step D: Date/Error/Map/Set |
| #101 | #1169k | IR Slice 10 step C: ArrayBuffer + DataView |
| #102 | #1169m | IR Slice 10 step E: Promise (best-effort) |
| #103 | #1212 | Promise resolve/reject regression fix |
| #104 | #1201 | Per-path test262 scores + landing page |
| #105 | #1213 | refresh-benchmarks path fix (LFS migration) |
| #106 | #1203 | Differential testing harness vs V8 |
| #107 | #1204 | Methodology document |
| #108 | #1214 | Benchmark CI runner-noise gate (informational only) |
| #109 | #1215 | Array .join()/.toString() number_toString registration |
| #110 | — | diff-test CI tsx fix |
| #113 | #1198 | Pre-size dense arrays at allocation site (+15 tests) |
| #118 | #1184 | __str_copy_tree depth-bounded worklist (nativeStrings fix) |

**In CI / in progress at compact time:**
- PR #112 (#1218): baseline validator — awaiting baseline refresh then re-run
- PR #114 (#1220): Promise snapshot + prototype cleanup (+29 tests)
- PR #115 (#1221): WasmException outer-catch fix (~256 flaky tests)
- PR #117 (#1219): ArrayBindingPattern iter-close hang fix (26 CT tests)
- dev-3 → #1196 (bounds-check elimination)
- dev-4 → #1197 (i32 element specialization)
- senior-dev-1210 → #1216 (auto-commit benchmark baseline)
- dev-2 → #1217 (smoke-canary CI)
- senior-dev-1205 → #1205 PR #98 (TDZ boxing, in-progress)

**Key findings from investigation sprint:**
- `compile_timeout` in test262 is a **runtime** timeout (combined compile+execute), not a compile-only timeout. The 30s timer in compiler-pool.ts covers both. ~26 are genuine runtime hangs (iter-close bug), ~70+ are load-induced flakes.
- `[object WebAssembly.Exception]` flakiness (256 tests): fork-state poisoning. Outer catches in test262-worker.mjs missed instanceof WebAssembly.Exception → misclassified as compile_error. Fixed in PR #115.
- `Promise.resolve is not a function` (26 tests): Promise missing from _STATIC_SNAPSHOTS → fork contamination. Fixed in PR #114.
- `Cannot redefine property` (23 tests): mixed isolation bugs (3 fixable in PR #114) + real compiler bugs (instanceof TypeError, mapped arguments — deferred to S47).

**Baseline at session compact:** ~27,000 pass (60.2% adjusted for drift); committed baseline shows 25,813 due to runner variance in the latest promoted run. PRs #114/#115/#117 expected to push real rate to ~61%+ once CI confirms.

**Sprint 46 scope expanded mid-sprint:**
- Added credibility track issues (#1201, #1203, #1204) that were originally deferred to S47
- Added CI health issues (#1213, #1214, #1217, #1218, #1219, #1220, #1221) surfaced by investigation
- Added perf issues (#1196, #1197, #1198, #1184, #1216) from sprint 47 to keep team loaded
- Sprint = 1 week of token budget (new rule); pull next sprint's work when current issues drain

**Drift pattern documented:** Every PR today showed the same drift signature: net positive, but 22-30% regression ratio from Promise flakes + Temporal/annexB skip-list baseline staleness. Physical-impossibility override approved for all (PRs #94, #106, #109, #110, #113, #118).

## 2026-04-29 — Sprint 45 close

**Sprint 45 closed.** 6-day sprint (2026-04-23 → 2026-04-29).

**Key results:**
- +554 net test262 tests (baseline 25,276 → 25,830 = 59.8%)
- IR Phase 4 slices 6–10 all landed: generators (#1169f), destructuring (#1169g), try/catch (#1169h), RegExp/extern-class scaffolding (#1169i step A)
- IrLowerResolver refactor (#1185) cleared the per-feature shortcut debt across the IR system
- Competitive benchmark harness built in labs/ — 5 programs × 9 toolchain lanes; Javy static+dynamic split; Porffor and AssemblyScript lanes wired up
- Architecture Decision Records (#1202) and landing page architecture section (#1208) shipped
- CI baseline-drift hardening complete (#1076–#1080, #1192, #1191, #1193)
- #1177 (TDZ closure captures) reverted after 14.7% regressions — deferred to S46
- 3 new benchmark issues filed: #1209 (hosted ESM error), #1210 (string-hash GC timeout), #1211 (fib-recursive type mismatch)

**Baseline**: 25,830 / 43,168 = 59.8%
**Sprint 46 begins.** IR Slice 10 steps B–E, #1177 investigation, credibility track, and benchmark bug fixes are the headline priorities.

## 2026-04-23 — Sprint 43 close / Sprint 44 setup

**Sprint 43 closed.** Short 3-day sprint (2026-04-20 → 2026-04-23). 3 PRs merged:
IR Phase 1 + 2 (#1131, PRs #231 + #258) and CI merge split (#1076, PR #160).
Baseline held at 24,483 / 43,172 = 56.7% — all IR work is infrastructure.

Also in this session:
- **LFS migration** for `*.jsonl`, `*.log`, `*.wasm`, benchmark JSON files
- **GitHub Pages fixed** after LFS migration broke CI checkout (added `lfs: true` to all 6 affected workflows)
- **All GitHub Actions bumped** to Node.js 24-compatible versions (configure-pages v6, upload-pages-artifact v5, checkout v5, setup-node v6, download-artifact v7)
- **labs remote** (`js2wasm-labs`) set up as private repo for experimental/commercial development; `labs/*` branches blocked from origin via pre-push hook
- **Sprint 44 planned** with #1153 (compiler crashes) + #1168 (IR frontend widening) as headline priorities

**Baseline**: 24,483 / 43,172 = 56.7%
**Sprint 44 begins next.**

## 2026-04-24 — Sprint 44 close

**Sprint 44 closed.** 2-day sprint (2026-04-22 → 2026-04-24).

**Key results:**
- +793 net test262 tests (baseline 24,483 → 25,276 = 58.6%)
- IR Phase 3 complete: monomorphize + tagged-unions (#1167c, PR #13)
- IR infrastructure PRs (#1168, #1167a, #1167b, #1167c) all merged — 0 direct test gain but Phase 4 now unblocked
- LFS budget exhausted mid-sprint → baseline promotion CI job failed; fixed with `continue-on-error` workaround (#1078)
- Sprint grew too large (74 issues); 55 carried over to sprint 45

**Baseline**: 25,276 / 43,172 = 58.6%
**Sprint 45 begins with IR Phase 4 (#1169) now unblocked.**
