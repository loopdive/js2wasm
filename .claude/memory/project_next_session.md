---
name: project_next_session
description: Session state: 15,246 pass, honest baseline after exception tag fix
type: project
---

## Final state (2026-03-31)

**Git:** main at 465be3eb
**Test262:** 15,246 pass / 48,174 total (31.7%) — honest baseline, no cache, no inflated negative tests

### Why the number dropped from 18,284
1. Sprint-31 fixes were reverted (accounted for ~2,100 pass loss)
2. Old runner bug: both if/else branches in negative test handling said "pass" — inflated count by ~900
3. This is the **true baseline** — old numbers were wrong

### Test infrastructure (unified fork architecture, #889)
- 16 chunk files, 1 vitest fork, CompilerPool with 9 child_process.fork workers
- Each fork compiles AND executes tests (unified mode)
- Peak 113MB per worker, ~1.7GB total, 15GB+ available
- Results now written to timestamped files (`test262-results-YYYYMMDD-HHMMSS.jsonl`)
- Shell script passes `RUN_TIMESTAMP` env var; code generates its own if not set

### Speed issue (20 min vs 8 min)
- Script ran chunks sequentially (for loop), 16 × startup overhead
- Fixed: now runs all chunks in one vitest invocation
- Expected: ~8 min with parallel chunk execution

### Error categories (current)
- type_error: 9,835 (biggest)
- assertion_fail: 8,195
- other: 3,121
- null_deref: 1,799
- wasm_compile: 1,169
- negative_test_fail: 914
- illegal_cast: 920

### Sprint-31 redo still pending
- Branches `issue-839-redo` and `issue-866-redo` ready
- Issues #826 and #862 need architect-guided redesign
- Sprint 32 (STF presentability): issues #883-#888
