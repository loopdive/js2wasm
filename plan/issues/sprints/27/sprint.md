# Sprint 27

**Date**: 2026-03-28 (morning/afternoon)
**Goal**: Test262 infrastructure overhaul — precompiler, caching, vitest runner
**Baseline**: 13,289 pass (honest baseline)

## Issues
- #674 — Skip SharedArrayBuffer/Atomics tests (397 + 258 tests)
- #832 — Skip Unicode 16.0.0 identifier tests (TS 6.x upgrade needed)
- #833 — Skip octal escape tests (sloppy mode consideration)
- #834 — Skip ES2025 Set methods tests (low priority)
- #835 — Register Error types as full extern classes (created)
- #836 — Tagged templates with property access tag (created)
- #837 — Skip Map/WeakMap upsert tests (Stage 3)
- #838 — Skip BigInt typed array tests

## Results
**Final numbers**: 17,612 pass / 48,086 total → 18,546 pass / 48,086 total
**Delta**: +4,323 to +5,257 from honest baseline

## Notes
- Major test infrastructure work:
  - Standalone precompiler for cache warming
  - Two-phase compile-then-run with CPU-core-sized compiler pool
  - Batch JSONL writes (100 entries per flush)
  - JSONL split into compile vs run results
  - Compile-time profiling
  - Negative test early error detection via diagnostic codes
- Vitest-based runner with auto-worktree, disk cache, default 3 forks
- Multiple test262 runs showing steady improvement through the day
- Skip filters narrowed to avoid over-skipping passing tests

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #835 | Unknown extern class: Error types (32 CE) | low | done |

<!-- GENERATED_ISSUE_TABLES_END -->
