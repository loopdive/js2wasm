---
name: project_next_session
description: 2026-03-27 session — 17 commits, ~12 issues addressed, test262 cache stale (needs recheck)
type: project
---

## Final state (2026-03-27 ~13:15 UTC)

**Git:** main at b3df56f2, pushed
**Test262:** 15,197 pass (STALE — cached from previous session, needs fresh run with `--recheck`)
**Session start:** 15,197 → 17 commits, multiple fix categories

## 17 commits this session

### Compiler fixes (10)
1. `52e57082` — Global index stale ref + finally-stack inlining (rescued patches)
2. `d39fcd86` — Null guard only throws TypeError for genuinely null refs (#789)
3. `5d4c70f1` — Implement rest elements in 5 destructuring paths (#761)
4. `3318efa1` — Add recursion depth guard to resolveWasmType (#701)
5. `e4534716` — Remove overly broad String/prototype skip filter, re-enabling 1,073 tests (#816)
6. `65ca0061` — Remove fixStructNewUnderflow that corrupted struct fields (#815)
7. `38d3d955` — Emit JS undefined (not null) for missing args, uninit vars, hoisted vars (#737)
8. `5b1921ca` — Remove invalid drop in toString radix validation + expand RangeError tests (#733)
9. `e36eaff9` — Guard ref.cast with ref.test to prevent illegal cast traps (#778)
10. `b3df56f2` — Add RegExp exec/match/replace/split host imports (#763)

### Infrastructure fixes (4)
11. `4820306b` — Classify test262 runtime errors into 14 categories (#696)
12. `81b0bee4` — Reduce compiler pool to 1 worker per vitest fork
13. `cd539e5b` — Debug logging for compiler pool timeout
14. `8a2f44e1` — Restart compiler worker every 500 compilations

### New tests (3)
15. `be1d308c` — Equivalence tests for RegExp, Promise, Proxy, WeakMap/WeakSet (#767)
16. `12afad14` — Verify closure capture type preservation (#686)
17. `d2c5debd` — Extend SyntaxError detection with 12 new early error checks (#736)

## Perf improvement
18. `5561e431` — Reverse typeIdxToStructName map for O(1) lookups (#638)

## Known blockers

### Test262 can't complete a full fresh run
- **Runtime hang**: Some compiled Wasm modules have infinite loops that block the vitest fork
- `testFn()` is synchronous — no way to interrupt it from JS
- The vitest testTimeout doesn't help because the event loop is blocked
- **Fix needed**: Run Wasm execution in a worker thread with timeout, OR add loop counters at compile time
- Partial run (24K/50K tests) showed 8,521 pass in language/ category

### Stale cache
- Test262 disk cache (~1.3GB in .test262-cache/) has entries from the old compiler bundle
- The cache hash is based on compiler-bundle.mjs content
- Need to either clear cache or run with `--recheck`

### Still blocking
- class/elements hang (#793) — ~3,073 skipped (private class element compilation)
- 48 open issues in plan/issues/ready/
