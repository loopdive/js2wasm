# Sprint 28

**Date**: 2026-03-28 (evening) to 2026-03-29 (early)
**Goal**: PO analysis, runtime fix wave, closure semantics
**Baseline**: 18,546 pass / 48,086 total

## Issues
- #848 — Class computed property and accessor correctness
- #850 — Prevent "Cannot convert object to primitive value" for WasmGC structs
- #851 — Iterator close protocol
- #852 — Safe externref destructuring with ref.test guard
- #857 — Wrap captured functions as closures when used as values
- #859 — Map forEach hang (mutable capture bug) — ref cells fix
- #860 — Promise race callback detection (created)
- #861 — Playground fs module externalized error (created)
- #862-#864 — PO analysis: new issues from test262 results

## Results
**Final numbers**: 18,117 pass / 47,835 total → 18,186 pass / 47,782 total
**Delta**: -360 to -429 from peak (but more honest/complete runs)

## Notes
- PO analysis committed at 02:34 — updated backlog with sprint priority
- Test262 runs during this period:
  - 20:40: 18,117 pass / 47,835 total
  - 09:20 (next day): 18,186 pass / 47,782 total
- Browser-compatible compiler fix + Map.forEach removed from HANGING_TESTS
- Early error detection via second compile pass
- Wasm function name + source line extraction for runtime traps

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

No issues currently assigned to this sprint.

<!-- GENERATED_ISSUE_TABLES_END -->
