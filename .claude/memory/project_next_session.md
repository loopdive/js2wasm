---
name: project_next_session
description: 2026-03-21 session state — 19 issues done, pass regression to fix, HTTP server for source maps next
type: project
---

## Current state (end of 2026-03-21 session)

**Test262**: 14,731 pass / 48,097 total (30.6%), 4,712 CE, 27,655 fail, 999 skip
**Baseline was**: 15,232 pass — net -501 pass regression from #695/#706 interaction
**CE improved**: 5,496 → 4,712 (-784)

**Git**: main branch, ~30 commits ahead of origin. All changes committed.

## Session accomplishments (19 issues)
#695 (TypeError throws), #702 (null derefs), #703 (negative test validation),
#704 (immutable global), #705 (stack underflow), #706 (illegal cast guards),
#707 (Date class), #708 (func index OOB), #709 (array OOB), #710 (unreachable),
#711 (new Function), #712 (import.meta), #713 (destructuring), #715 (crash fix),
#716/#718 (null-guard regression), #717 (import stub regression),
#719 (stack-balance), #720 (IIFE returnType), #721 (early errors),
#722 (hasOwnProperty), #723 (TDZ)

#697 and #698 were reverted — caused regressions, need rework.

## Priority for next session

### 1. Fix pass regression (-501)
#695/#706 interaction: ref.cast guard returns ref.null → property access gets default instead of real value. Trace specific failing tests.

### 2. Implement #725 — Local HTTP server for wasm source maps
Key to line numbers in ALL runtime errors (13k tests). Serve wasm from `test262-out/` mirroring input structure. V8 resolves source maps from URL. Integrates with playground (#644).

### 3. Rework #697/#698
Struct type widening and call type mismatch — caused regressions, need careful approach.

### 4. Continue issue work
- #721 (partially done) — more negative test early errors
- #724 — Object.defineProperty TypeError
- #714 — conformance progress graph

## Key architecture
- Test runner: `tests/test262-vitest.test.ts` — pool + source maps + error reporting
- Pool: `scripts/compiler-pool.ts` (4 async workers, skipSemanticDiagnostics, sourceMap)
- Worker: `scripts/compiler-worker.mjs` (loads compiler-bundle.mjs)
- Bundle rebuild: `npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=scripts/compiler-bundle.mjs --external:typescript`
- ALWAYS run test262 in a worktree, not main wc
- ALWAYS commit runner changes before launching agents
- ALWAYS check worktree diffs before cleanup
