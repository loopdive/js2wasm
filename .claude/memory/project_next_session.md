---
name: Next session state
description: 100 issues committed, vitest migration done, 140x compile speedup
type: project
---

## Session 2026-03-19/20 Summary

**100 issues committed in one session.**

### Test262 Results (last complete run)
- Pass: 13,226 (31.7%) — up from 9,270 (23.4%)
- CE: 6,894 (16.5%) — down from 14,950 (37.7%)
- Total: 41,694

### Major achievements
- Vitest migration (#694): test262 runs via vitest with per-test disk cache
- Compiler pool (#699): 4 esbuild-bundled worker threads
- skipSemanticDiagnostics: 140ms → 1ms per compile (100x speedup)
- Lib SourceFile caching (#700): additional 35% speedup
- 48K tests cold cache: ~5 min (was 80 min)
- Re-runs with cache: ~2 min

### Build status: WORKING
- abstract-classes.test.ts: 6/6 pass
- #678 (dynamic prototype) reverted — __proto__ field breaks struct layout when string_constants import needed
- #699 compiler pool working via esbuild bundle (no tsx in workers)

### Key files
- `tests/test262-vitest.test.ts` — vitest runner with pool + cache
- `scripts/compiler-pool.ts` — async compiler worker pool
- `scripts/compiler-worker.mjs` — bundled worker (loads compiler-bundle.mjs)
- `scripts/compiler-bundle.mjs` — esbuild bundle of compiler (rebuild: `npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=scripts/compiler-bundle.mjs --external:typescript`)
- `.test262-cache/` — disk cache for compiled .wasm binaries

### Known issue
- vitest `--pool=forks` buffers appendFileSync writes — JSONL doesn't update until fork exits
- Fix: use afterAll to write batch results, or switch to shared file descriptor

### Open issues (20)
See plan/issues/backlog/backlog.md for full list.
Top priority: #695 (TypeError exceptions), #696 (classify runtime errors), #687 (live report), #688 (refactor into modules)
