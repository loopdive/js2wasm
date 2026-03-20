# ts2wasm Backlog

## Current — Test262 Full Suite (March 2026)

*Full run in progress (48,104 tests). Previous: 9,270 pass (23.4%), 14,950 CE, 39,687 total.*
*Sprint 2026-03-19: 53 issues committed. Full run pending with all fixes.*

### Open issues

| # | Feature | Type | Priority |
|---|---------|------|----------|
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | Feature | High (merge conflicts, branch preserved) |

### Recently completed (2026-03-19 session — 53 issues)

See `plan/issues/done/log.md` for the full list (#74-#634).

### Backlog — JS runtime features

| # | Feature | Tests | Priority |
|---|---------|-------|----------|
| [123](./123.md) | Wrapper constructors (new Number/String/Boolean) | 648 | High (merge conflicts) |

### Future — architecture improvements (from deep review)

| Priority | Improvement | Impact |
|----------|-------------|--------|
| High | Add missing Instr opcodes to IR types | Eliminates 158 unsafe `as unknown as Instr` casts |
| High | Extract createCodegenContext() factory | Fixes WASI multi-module bug, eliminates duplication |
| Medium | Create walkInstructions utility | Eliminates 5 duplicate instruction walkers |
| Medium | Add reverse typeIdxToStructName map | 8 O(N) scans → O(1) |
| Medium | Split expressions.ts further | 24K lines → focused modules |

### Future — platform support

| Priority | Feature | Impact |
|----------|---------|--------|
| Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon, Cosmonic |
| High | WASI HTTP handler | Unlocks serverless edge platforms |
| Medium | Shopify Functions template | Best adoption opportunity |
| Low | Deno/Cloudflare loader plugins | Developer experience |

## Complexity legend

- XS: < 50 lines, one file
- S: < 150 lines, 1-2 files
- M: < 400 lines, 2-3 files
- L: > 400 lines, multiple files

## Completed (630+ issues)

See `plan/issues/done/log.md` for the full completion log.

Key milestones:

- React reconciler compiles to WasmGC, 2.3x faster than JS (1000-node tree)
- 98-99% pass rate on supported test262 categories
- 53 issues completed in single session (2026-03-19)
- WASI target, native strings, WIT generator, tail calls, SIMD
- 95% TypeScript compiler pattern compatibility
- Deep architecture review with actionable improvements

