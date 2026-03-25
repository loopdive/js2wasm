---
name: project_next_session
description: 2026-03-25 verified baseline — 15,465 pass / 1,777 CE at 19cedca9, worker recycling fix applied
type: project
---

## Current state (2026-03-25)

**Test262 (verified, full clean run):** 15,465 pass (31.1%) / 1,777 real CE / 24,731 fail / 670 skip / 49,665 total
**Worker crashes:** 7,022 tests never ran (worker exited code 1) — counted as CE in raw report (8,799 total CE)
**Git:** main branch at 19cedca9
**Runner:** Use `pnpm run test:262` (vitest), not legacy standalone script

## Infrastructure fixes applied (uncommitted)
1. **Worker recycling** in `scripts/run-test262.ts`: sub-batches of 500 tests, pool of POOL_SIZE concurrent workers. Reduced crashes from 17,552 → 7,022.
2. **Worker memory** bumped to 4GB per worker, main process to 4GB
3. **Vitest runner** default workers: 8 → 2 in `scripts/run-test262-vitest.sh`
4. **Persistent cache** was poisoned with 17K "worker exited" entries — cleared
5. **Statusline** updated to detect tsx/vitest test262 processes

## Key lessons
1. **Post-processing fixup passes are fragile** — must fix at codegen time
2. **Worker OOM:** standalone runner sent 25K tests to one worker. Fixed with 500-test sub-batches.
3. **Persistent cache poisoning:** `--full` flag didn't clear the cache file, only the JSONL. Bad results got cached and replayed.
4. **Vitest runner preferred** — esbuild bundle is lighter per-fork than raw tsx workers

## Housekeeping done
- #723 (TDZ) moved to done/
- #728 (null pointer) closed as superseded by #775
- 58 ready issues remain

## Next steps
1. Commit infrastructure fixes (worker recycling, vitest defaults, statusline)
2. Sprint wave 1: #779 (8,700 wrong values — split), #771 (arguments), #730 (missing throws), #775 (null→TypeError)
3. Sprint wave 2: #770 (verifyProperty), #729 (class gaps), #761 (rest/spread)
