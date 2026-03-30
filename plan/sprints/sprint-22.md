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
