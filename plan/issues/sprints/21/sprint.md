# Sprint 21

**Date**: 2026-03-25
**Goal**: Mutable closure captures, assertion failures, type errors
**Baseline**: ~15,997 pass / 49,642 total

## Issues
- #729-#732 — Compiler fixes
- #734, #738 — Additional fixes
- #771, #775 — Additional improvements
- #779 — Box captures written in outer scope for correct mutable closure semantics
- #780-#788 — Large batch of issues:
  - Assertion failure patterns
  - Type error patterns
  - Compile error reductions

## Results
**Final numbers**: 15,410 pass / 49,663 total
**Delta**: -587 from peak (expanded test coverage exposing new failures)

## Notes
- Test262 run at 2026-03-25 17:32: 15,410 pass / 49,663 total
- Session state: "20+ commits landed, PO updates, memory notes"
- 69 commits on this date
- Mutable closure semantics (#779) was a key architectural fix

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #405 | Internal compiler errors on unexpected AST shapes (64 CE) |  | done |
| #428 | Expected ReferenceError but succeeded (6 fail) | low | done |
| #431 | Math.pow/min/max conditional expressions produce fallthru type mismatch (27 CE) | medium | done |
| #432 | new keyword on non-constructor builtins causes stack underflow (42 CE) | medium | done |
| #433 | Equality operators with mixed types produce i32/f64 type mismatch (10 CE) | medium | done |
| #434 | BigInt remaining failures across expression operators (27 fail) | low | done |
| #464 | Array bounds check elimination for loops with known bounds | medium | done |
| #466 | Local reuse / register allocation to reduce local section bloat | medium | done |
| #468 | Run test262 benchmark and create issues from results | high | done |
| #474 | delete operator support (229 skipped tests) | medium | done |
| #477 | propertyHelper.js harness support — 647 tests | medium | done |
| #501 | Complete test262 baseline run and pin results | critical | done |
| #507 | Run benchmark suite and generate latest.json | high | done |
| #520 | Delete operator: operand must be optional (80 CE) | medium | done |
| #559 | Addition/subtraction result not coerced to externref before call (10 CE) | high | done |
| #561 | Math.hypot closure captures ref instead of f64 (1 CE) | medium | done |
| #563 | Unsupported call expression (826 CE remaining) | critical | done |
| #566 | Null pointer dereference (853 FAIL) - local index shift not recursive | critical | done |
| #567 | Wasm validation: struct.get on null ref type (860 CE) | high | done |
| #568 | - Wasm validation: local.set type mismatch (198 CE) | high | done |
| #572 | Internal compiler errors (152 CE) | medium | done |
| #574 | Worker crashed -- 180 tests lost to worker process crashes | medium | done |
| #576 | TEST_CATEGORIES covers only 10,501 of ~23,000 previously-tested tests | high | done |
| #577 | - Run test262 in a worktree to avoid mid-run code changes | high | done |
| #589 | ref.as_non_null on ref.null always traps (expressions.ts:16596) | high | done |
| #650 | Stack fallthrough errors — addUnionImports double-shift | high | done |
| #1115 | Fix illegal cast when closures are passed as callable parameters | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
