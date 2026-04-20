# Sprint 26

**Date**: 2026-03-27 (evening) to 2026-03-28 (early)
**Goal**: Exception tag fix, honest baseline, multi-file compilation
**Baseline**: 15,197 pass / 49,881 total (stale cache)

## Issues
- #819 — Multi-file compilation for _FIXTURE tests via compileMulti
- #820 — Arguments object in class/object methods + guarded coercion
- #779 — NaN sentinel defaults, for-in vec enum, class null deref
- #822 — externref→f64 coercion (added then reverted — regression)

## Results
**Final numbers**: 13,289 pass / 36,828 total (fresh run with worker threads)
**Delta**: Honest baseline established — previous 15,197 was stale cache

## Notes
- Exception tag fix revealed stale cache was inflating numbers
- Fresh complete run: 13,289 pass / 36,828 total
- Previous stale cache: 15,197 pass / 49,881 total
- Difference: unblocked ~4,000 previously-skipped tests which mostly fail
- Error categories: assertion_fail 9,259, type_error 3,730, wasm_compile 2,904
- This became the honest baseline for future sessions

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #705 | Wasm validation: not enough arguments on the stack (361 CE) | medium | done |
| #706 | Residual illegal cast: 248 runtime failures | high | done |
| #707 | Unknown extern class: Date (220 CE) | medium | done |
| #708 | Fix: function index out of bounds in Wasm validation (167 CE) |  | done |
| #709 | RuntimeError: out of bounds array access (174 FAIL) | medium | done |
| #714 | Conformance progress graph: track pass/fail/CE over time | medium | done |
| #719 | Wasm validation: stack fallthrough mismatch (310 CE) | high | done |
| #722 | Class private methods: hasOwnProperty check fails (484 FAIL) | high | done |
| #724 | Object.defineProperty: throw TypeError for invalid operations (150 FAIL) | medium | done |
| #769 | - Missing RegExp_new import after lib.d.ts refactoring (~600 CE) | critical | done |
| #819 | Multi-file compilation: resolve imports and compile module graphs | critical | done |

<!-- GENERATED_ISSUE_TABLES_END -->
