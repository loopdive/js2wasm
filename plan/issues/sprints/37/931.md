---
id: 931
title: "Error location reporting: 83% of compile errors lack real line numbers"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
required_by: [985]
test262_ce: 2803
test262_fail: 21178
merged: 2026-04-04
commit: 86017274
---
# #931 -- Error location reporting: 83% of compile errors lack real line numbers

## Problem

Error messages from the compiler frequently lack useful source locations:

| Category | Total | Missing line info | Percentage |
|----------|-------|------------------|------------|
| Compile errors (CE) | 2,803 | L1:0 or no line: 2,354 | **84%** |
| Runtime failures (FAIL) | 21,178 | No location context: 12,338 | **58%** |

Users seeing `L1:0 unexpected undefined AST node` cannot locate the problem in their source code. This severely degrades the developer experience and makes debugging test262 failures much harder.

## Root cause analysis

### 1. Direct `ctx.errors.push` with `line: 0` (6 call sites)

These call sites hardcode `line: 0, column: 0` because they don't have access to the AST node:

| File | Line | Error message |
|------|------|---------------|
| `src/codegen/expressions.ts` | 530-534 | compilation depth exceeded |
| `src/codegen/expressions.ts` | 557-561 | unexpected undefined AST node |
| `src/codegen/expressions.ts` | 3931-3935 | Assignment: vec data is not array |
| `src/codegen/statements.ts` | 305-309 | unexpected undefined AST node in compileStatement |
| `src/codegen/statements.ts` | 2744-2748 | Cannot destructure string |
| `src/codegen/property-access.ts` | 2091 | Element access: vec data is not array |

### 2. `reportError` fallback when `getSourceFile()` returns null

`src/codegen/context/errors.ts:17-20` — when the AST node has no source file (synthetic nodes, detached nodes), `reportError` falls back to `line: 0`. This is correct behavior but happens more often than expected.

### 3. `compiler.ts` catch blocks (18 sites with `line: 0`)

`src/compiler.ts` has ~18 catch blocks that emit errors with `line: 0` — these catch unexpected exceptions during codegen, binary emit, and WAT generation. They have no AST node context.

### 4. Direct `ctx.errors.push` WITHOUT `reportError` (130 of 132 calls)

Only 2 of 132 `ctx.errors.push` calls in `src/codegen/` use the `reportError` helper. The other 130 manually extract line info from the AST node — but many pass nodes that lack source file context, resulting in `L0:0` or crash-to-fallback.

## Proposed fix

1. **Migrate all 130 direct `ctx.errors.push` calls to use `reportError`** — this centralizes the line-extraction logic and ensures consistent fallback behavior.

2. **Thread a "last known good node" through the context** — when entering a statement or expression, save the node. When an error occurs on a synthetic/detached node, use the last known good node's position instead of `line: 0`.

3. **For `compiler.ts` catch blocks** — wrap codegen calls with try/catch that captures the current function name and approximate source range, so catch-block errors at least report which function they occurred in.

## Acceptance criteria

- [ ] >=60% of CE errors include a real line number (currently 16%)
- [ ] The "unexpected undefined AST node" errors include the parent expression's line number
- [ ] All `ctx.errors.push` calls in `src/codegen/` use `reportError` or an equivalent that extracts line info
- [ ] No regression in test pass count

## Estimated impact

This is a developer-experience issue, not a correctness issue. It doesn't fix any tests, but it makes ALL other debugging significantly easier. Should be prioritized in a quality sprint.

## Bisect Results (2026-04-04)

### Summary: The 132 error-migrations are SAFE. The crash was caused by broken merge conflict resolutions.

**Tested**: Built branch `issue-931-error-lines` (commit `3bf9cb5b`) and compiled 2,000 test262 files — **zero crashes, zero compilation regressions** vs main. Memory stable at ~900MB.

**Also tested**: Compared compilation outcomes of 300 test262 files between branch and main — **identical results** (285/300 success on both). The `reportError()`/`reportErrorNoNode()` helpers are mechanically correct and don't alter compilation behavior.

### Root cause: Bad merge conflict resolutions

The branch has 5 commits:
1. `57b37ed2` — **The actual implementation** (132 error-push migrations across 13 codegen files). This commit is CLEAN.
2. `a6f744fb`, `29a13fc6`, `894c5000`, `3bf9cb5b` — Four merge commits (main → branch) that resolved conflicts by **reverting features from main**.

### What the merges broke

**runtime.ts** (31 lines reverted) — Deleted runtime handlers added by #797 and #945:
- `_vecToArray` helper for Promise combinators (Promise.all/race now receive raw WasmGC structs → TypeError)
- `Promise_allSettled`, `Promise_any`, `Promise_then2`, `Promise_finally` handlers — DELETED
- `__getOwnPropertyNames`, `__getOwnPropertySymbols`, `__getPrototypeOf` handlers — DELETED
- Object.keys/values/entries enumerability filtering via `_wasmPropDescs` — REMOVED
- `__getOwnPropertyDescriptor` WasmGC struct handling — DELETED (now just `Object.getOwnPropertyDescriptor`)

**index.ts** (98 lines reverted) — Deleted codegen features:
- `isPromiseHostCallExpr()` function — DELETED (Promise type inference)
- `i32_byte` boxing for TypedArray/DataView byte elements — REMOVED (#945 fix reverted)
- `Promise_allSettled`/`Promise_any`/`Promise_finally` import registration — REMOVED
- `Promise_then2` (two-callback .then) — REMOVED

**object-ops.ts** (67 lines reverted) — Deleted #797 property descriptor codegen:
- `enumUserFields` enumerability filtering — REMOVED (Object.keys/values/entries returns ALL fields)
- `isPropertyIsEnumerable` static checking via `definedPropertyFlags` — REMOVED

### Why it caused 1,879/48,174 completion

The reverted runtime handlers cause **runtime failures during Wasm module instantiation/execution**, not compilation crashes. Test programs that call Promise combinators, use property descriptors, or access TypedArray bytes would fail at runtime with missing import errors or TypeErrors. The test262 runner likely encountered cascading failures that killed worker processes.

### Recommendation

**Re-apply commit `57b37ed2` cleanly onto current main** — do NOT reuse the branch with its broken merges. The error-migration implementation is correct:
- `reportError(ctx, node, msg)` — extracts source location from AST node with `lastKnownNode` fallback
- `reportErrorNoNode(ctx, msg)` — uses `ctx.lastKnownNode` when no node is available
- `extractLocation()` has a bare `catch {}` — cannot throw even with detached/synthetic nodes
- `ctx.lastKnownNode` set on every expression/statement entry — cheap, safe, effective
