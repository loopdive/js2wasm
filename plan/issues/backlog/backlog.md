# ts2wasm Backlog

These are sequential milestones — complete each section before moving to the next.

## 1. JS runtime features

| # | Priority | Feature | Tests |
|---|----------|---------|-------|
| [123](../ready/123.md) | High | Wrapper constructors (new Number/String/Boolean) | 648 |

## 2. Architecture improvements

| # | Priority | Improvement | Impact |
|---|----------|-------------|--------|
| [635](../ready/635.md) | High | Add missing Instr opcodes to IR types | Eliminates 158 unsafe casts |
| [636](../ready/636.md) | High | Extract createCodegenContext() factory | Fixes WASI multi-module bug |
| [637](../ready/637.md) | Medium | Create walkInstructions utility | Eliminates 5 duplicate walkers |
| [638](../ready/638.md) | Medium | Add reverse typeIdxToStructName map | 8 O(N) → O(1) |

## 3. Platform support

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon, Cosmonic |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience |

## Completed (630+ issues)

See `plan/issues/done/log.md` for the full completion log.
