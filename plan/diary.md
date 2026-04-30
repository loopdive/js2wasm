# Project Diary

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
