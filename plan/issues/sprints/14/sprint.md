# Sprint 14

**Date**: 2026-03-20 (early)
**Goal**: Dual-mode backends, compiler infrastructure
**Baseline**: 9,560 pass / 47,983 total

## Issues
- #1110, #333 — Previously blocked issues
- #490 — Additional fix
- #635-#638 — Compiler improvements
- #649 — Additional fix
- #652-#665 — New issues including:
  - #679 — Dual string backend
  - #682 — Dual RegExp backend
- #668-#670 — Additional fixes

## Results
**Final numbers**: 10,444 pass / 47,773 total
**Delta**: +884 pass

## Notes
- Test262 run at 02:11 UTC: 10,444 pass
- Dual-mode architecture pattern established (#679 strings, #682 RegExp)
- This became an architecture principle documented in CLAUDE.md

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #333 | - Dynamic import modifier syntax errors | low | done |
| #490 | Function/class .name property (576 tests) | high | done |
| #635 | Add missing Instr opcodes to IR types (158 unsafe casts) | high | done |
| #638 | Add reverse typeIdxToStructName map (8 O(N) → O(1)) | medium | done |
| #649 | Residual stack underflow (876 CE) | medium | done |
| #665 | Native Wasm Date implementation | high | done |
| #668 | 'String literal not registered' for empty string (43 CE) | medium | done |
| #670 | Proxy trap execution (beyond pass-through) | critical | done |
| #679 | Dual string backend: js-host mode vs standalone mode | high | done |
| #1110 | Wrapper object constructors: new Number/String/Boolean (648 tests) | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->