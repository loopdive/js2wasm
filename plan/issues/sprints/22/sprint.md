# Sprint 22

**Date**: 2026-03-26 (morning)
**Goal**: Compile-away principle, new issues, memory files
**Baseline**: 15,410 pass / 49,663 total

## Issues
- #494 — Previously blocked fix
- #766 — Symbol.iterator protocol + const-in-for-of fix
- #770 — Additional fix
- #778 — Guard ref.cast with ref.test to prevent illegal cast traps
- #789-#801 — Large batch:
  - #789 — Null guard only throws TypeError for genuinely null refs
  - #790-#796 — Various fixes
  - #797-#799 — Runtime improvements
  - #800, #801 — Additional fixes
- #811-#813, #815 — Additional issues

## Results
**Final numbers**: 15,579 pass / 49,833 total
**Delta**: +169 pass

## Notes
- Test262 run at 13:36: 15,579 pass / 49,833 total
- "Compile-away" principle established — resolve JS semantics statically, zero runtime overhead
- New issues created, memory files updated, analysis from session
- 80 commits on this date

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #494 | Remove stale skip filters (194 tests) | medium | done |
| #636 | Extract createCodegenContext() factory (fixes WASI multi-module bug) | high | done |
| #647 | Residual null pointer dereferences (1,374 FAIL) | high | done |
| #655 | - Stack fallthrough errors (671 CE) | high | done |
| #693 | Safe compilation speed optimizations | medium | done |
| #770 | - propertyHelper.js verifyProperty not implemented (~1,219 tests) | critical | done |

<!-- GENERATED_ISSUE_TABLES_END -->
