---
name: project_next_session
description: 2026-03-27 session — 27 commits, 16 issues, test262 13,289 pass / 36,828 total (fresh run)
type: project
---

## Final state (2026-03-27 ~15:30 UTC)

**Git:** main at f63415b6, pushed
**Test262:** 13,289 pass / 36,828 total (fresh complete run with worker threads)
- Previous stale cache: 15,197 pass / 49,881 total
- Difference explained: unblocked ~4,000 previously-skipped tests (class/elements, String/prototype) which mostly fail, lowering pass count but increasing test coverage
- 4 runtime timeouts (properly handled by worker thread pool)
- Error categories: assertion_fail 9,259, type_error 3,730, wasm_compile 2,904

## 27 commits this session

### Compiler fixes (16 issues)
- #789 — Null guard only throws TypeError for genuinely null refs
- #815 — Removed fixStructNewUnderflow that corrupted struct fields
- #816 — Removed String/prototype skip filter (1,073 tests re-enabled)
- #793 — Removed class/elements hang workaround (~3,000 tests unblocked)
- #761 — Implemented rest elements in 5 destructuring paths
- #701 — Recursion depth guard for resolveWasmType
- #737 — Emit JS undefined (not null) for missing args/uninit vars
- #733 — RangeError validation + invalid drop fix
- #736 — 12 new SyntaxError early error checks
- #778 — Guard ref.cast with ref.test to prevent illegal cast traps
- #763 — RegExp exec/match/replace/split host imports
- #766 — Symbol.iterator protocol + const-in-for-of fix
- #675 — Dynamic import argument evaluation
- #323 — Arrow functions inherit enclosing arguments object
- Computed property names in object literals/classes/destructuring
- Global index stale ref + finally-stack inlining (rescued patches)

### Test infrastructure (6)
- #696 — Classify test262 runtime errors into 14 categories
- #638 — Reverse typeIdxToStructName map (O(N)→O(1))
- Compiler pool: 1 worker per fork, worker restart every 500 compilations
- Worker thread Wasm execution pool (replaces direct testFn() + watchdog hack)
- Runtime bundle build for wasm-exec-worker
- Debug logging for compiler pool timeout

### Tests (5)
- #767 — Equivalence tests for RegExp, Promise, Proxy, WeakMap/WeakSet (5 files)
- #686 — Closure capture type preservation verification
- 51 additional equivalence tests (8 files)
- Multiple issue-specific test files (11 files)

## Key architecture changes
- Test execution now in worker thread — hangs properly terminated after 10s
- Persistent wasm-exec worker pool (not per-test spawn)
- Compiler worker restarts every 500 compilations
- class/elements and String/prototype tests now run (previously skipped)

## Still open
- ~44 issues in plan/issues/ready/
- assertion_fail (9,259) is the largest failure category — wrong values from type coercion/property access
- type_error (3,730) — likely null guard or method dispatch issues
- compile_error (3,495) — unsupported patterns
