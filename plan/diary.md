# Project Diary

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
