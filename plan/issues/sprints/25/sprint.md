# Sprint 25

**Date**: 2026-03-27 (afternoon)
**Goal**: Wave 4 merge, class/elements unblocking, worker thread execution
**Baseline**: 14,616 pass / 49,880 total

## Issues
- #761 — Rest elements in 5 destructuring paths
- #763 — RegExp exec/match/replace/split host imports
- #766 — Symbol.iterator protocol + const-in-for-of fix
- #778 — Guard ref.cast with ref.test
- #789 — Null guard TypeError only for genuinely null refs
- #793 — Removed class/elements hang workaround (~3,000 tests unblocked)
- #815 — Removed fixStructNewUnderflow (field corruption)
- #817 — Additional fix
- #818-#823 — Multi-file compilation, binding null guards, unbox coercion, destructuring init

## Results
**Final numbers**: 15,197 pass / 49,881 total (+1,028 session gain)
**Delta**: +581 from sprint start, +1,028 from session start (14,169)

## Notes
- Test262 progression during sprint:
  - 06:29: 14,877 (String/prototype skipped for clean measurement)
  - 06:53: 14,878
  - 07:25: 15,144 (+975 session gain, depth fix working)
  - 08:24: 15,197 (+1,028 session gain)
- Worker thread Wasm execution pool replaced direct testFn() + watchdog hack
- class/elements and String/prototype tests now run (previously skipped)
- Session finalized at 09:33

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #761 | - Rest/spread elements silently dropped in destructuring (5 codegen paths) | high | done |
| #778 | - RuntimeError: illegal cast (135 tests) | medium | done |
| #789 | - TypeError null/undefined guard over-triggering (15,630 tests) | critical | done |
| #793 | - Infinite compilation loop on private-methods class expressions (5 tests) | medium | done |
| #815 | - Regression: -617 pass from patch-rescue commits | critical | done |
| #817 | let/const in loop and try/catch bodies leak into outer scope | high | done |
| #818 | Internal error: fctx is not defined during compilation | medium | done |
| #823 | Destructuring initializer not evaluated | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
