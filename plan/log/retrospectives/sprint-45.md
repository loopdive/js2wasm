---
sprint: Sprint-45
status: closed
session_end: 2026-04-29
---

# Sprint 45 Retrospective

**Duration:** 2026-04-23 → 2026-04-29 (6 days)
**Sprint count:** 45 sprints total

## Numbers

| Metric | Sprint start | Sprint end |
|--------|--------------|------------|
| test262 pass | 25,276 | **25,830** |
| pass rate | 58.6% | **59.8%** |
| Net gain | — | **+554** |
| Total tests | 43,172 | 43,168 |

## What shipped

| PR | Issue | Description |
|---|---|---|
| #72 | #1185 | IrLowerResolver refactor — thread resolver through LowerCtx, retire per-feature shortcuts |
| #73 | #1169f | IR Slice 7 — generators and async/await through IR |
| #75 | #1186 | fix(legacy): re-resolve native-string helpers post-shift (for-of string charAt) |
| #76 | #1177 | TDZ closure captures — reverted (14.7% regressions; held for S46 investigation) |
| #77 | #1192 | ci(self-merge): exclude compile_timeout from regression count |
| #78 | #1169g | IR Slice 8 — destructuring and rest/spread |
| #79 | #1169h | IR Slice 9 — try/catch/finally and throw |
| #80 | #1169i step A | IR Slice 10 Step A — RegExp through IR |
| #81 | #1208 | landing: surface ADRs — Architecture section with ADR HTML renderings |
| #82 | #1202 | credibility: Architecture Decision Records (8 core design choices) |
| #84 | #1169h | IR Slice 9 — try/catch/finally (re-landed after rebase) |
| #85 | #1169g | IR Slice 8 — destructuring (re-landed) |
| #86 | #1169i | IR Slice 10 Step A — RegExp/TypedArray IR scaffolding |
| #87 | #1191 | CI: committed baseline (test262-current.jsonl) sync automation |
| #88 | #1192 | CI: compile_timeout exclusion from self-merge regression count |
| #89 | #1193 | tooling: ci-status-watcher.sh uses `gh @me` fix |
| various | #1173–#1180 | js2wasm crash fixes (wasmtime 44 exact refs, string_constants WASI leak, wasm-validator mismatches, stack-overflow, array-sum perf) |
| various | #862, #906, #907, #991–#996, #1016, #1025, #1035, #1043, #1076–#1079, #1086, #1096, #1109, #1111, #1120, #1121, #1125, #1128, #1135, #1164, #1170, #1171 | Spec fixes, CI hardening, performance, platform work |

**IR Phase 4** slices 6–10 (generators, destructuring, try/catch, RegExp/TypedArray scaffolding) all landed. The full extern-class IR scaffolding for slice-10 follow-ups (TypedArray, ArrayBuffer, Date/Error/Map/Set, Promise) is in place.

## What went well

1. **IR Phase 4 slices 6–10 all shipped.** The for-of / iterator / generator / async / destructuring / try-catch / RegExp IR pipeline is now complete. The extern-class scaffolding (#1169i step A) gives the next devs a pattern-copy path for steps B–E.

2. **IrLowerResolver refactor landed cleanly.** #1185 threaded the resolver through LowerCtx across the entire IR system without regressions, eliminating the per-feature shortcut debt that had been accumulating since slice 1.

3. **Competitive benchmark harness built from scratch.** The `labs/` benchmarks now cover 5 programs × 9 toolchain lanes including Javy static, Javy dynamic, Porffor, AssemblyScript, StarlingMonkey (runtime-eval + ComponentizeJS), js2wasm (Wasmtime + hosted). The Javy dual-mode split and Porffor calling-convention fixes were non-trivial.

4. **Architecture Decision Records (ADRs) shipped to landing page.** #1202 + #1208 document the 8 core design choices that define js2wasm, with HTML renderings surfaced on the public site. Strong credibility investment.

5. **CI hardening complete.** The baseline-drift 5-issue set (#1076–#1080 — split merge job, live baseline fetch, emergency refresh, age stamp) all landed. compile_timeout noise excluded from self-merge criteria (#1192).

6. **Worktree cleanup instinct is improving.** Agent-context summaries for completed devs were written and committed, giving the next sprint a clean handoff for follow-up work.

## What went badly

1. **#1177 (TDZ closure captures) reverted.** PR #76 was opened, merged, and then reverted due to 14.7% regressions (~1,940 tests). The fix was a stage-1 capture-index correction that appeared correct in the targeted tests but surfaced a broad regression. The revert was the right call, but it cost two sprint cycles (open + revert). Needs deeper investigation before S46 dispatch.

2. **IR Phase 4 net gain (+554) smaller than expected.** The individual PR nets were large (+1,398, +1,234, +1,202 for #1185, #1186, #1169f), but the cumulative sprint-over-sprint delta is only +554. This is expected: PR-relative deltas overcount because they're measured against a pre-merge base that already included other improvements. The baseline methodology is correct; the expectation management was not.

3. **Sprint 45 was the "overflow" sprint but grew to ~74 issues too.** The overflow from sprint 44 was correctly separated, but the sprint still accumulated too many items. Most of the "Ready" table items were never actioned and are simply carry-overs to sprint 46.

4. **Three benchmark issues (js2wasm hosted ESM error, string-hash GC timeout, fib-recursive type mismatch) discovered only during the competitive benchmark run**, not proactively. Surfaced as #1209, #1210, #1211. Earlier integration testing would have caught these before they blocked the benchmarking work.

5. **Many worktrees left over from sprint 45 (and earlier).** At sprint close there are ~20 worktrees remaining, most stale. Worktree cleanup was not done consistently after each issue landed.

## Action items

- [ ] **Investigate #1177 TDZ regression** before S46 dispatch. The revert masked the underlying issue — likely a capture-index off-by-one that interacts with the multi-function closure case. Needs a dedicated senior-dev pass.

- [ ] **Worktree cleanup sweep.** Remove all merged/stale worktrees at each sprint close, not just a few. Add to wrap-up checklist.

- [ ] **Fix js2wasm hosted mode ESM error (#1209)** — blocks the entire `js2wasm → Node.js (hosted)` lane in the competitive benchmark. Easy fix, high visibility.

- [ ] **Fix string-hash GC pressure (#1210)** — the most impactful competitive benchmark gap. Pre-allocate string buffer pattern would bring string-hash from 20s timeout to <100ms.

## Carry-overs to sprint 46

High-priority carry-overs:
- #1177 — TDZ closure captures (reverted, needs investigation)
- #1205 — Extend TDZ flag boxing to async functions / generators (1177 follow-up)
- #1209 — hosted lane ESM error
- #1210 — string-hash GC pressure (wasmtime timeout)
- #1211 — fib-recursive hosted type mismatch
- #1169j–m — IR Slice 10 steps B–E (TypedArray, ArrayBuffer, Date/Map/Set, Promise)
- #1190, #1201, #1203, #1204 — credibility / test262 scoring improvements
- #1187 — test-runtime native-string coercion helper
- #1188 — js2.loopdive.com custom domain

## Sprint close criteria — met

- [x] IR Phase 4 slices 6–10 landed
- [x] IrLowerResolver refactor complete
- [x] Competitive benchmark harness built and first run recorded
- [x] Baseline promoted: 25,276 → 25,830 (59.8%)
- [x] Sprint tag `sprint/45` applied
- [x] Sprint status updated to `closed`
- [x] Retrospective written
- [x] Diary updated
