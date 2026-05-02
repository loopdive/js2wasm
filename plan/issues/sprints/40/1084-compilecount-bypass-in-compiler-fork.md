---
id: 1084
title: "compileCount bypass in compiler-fork-worker.mjs — RECREATE never fires when errors dominate a chunk"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-14
priority: critical
feasibility: easy
reasoning_effort: low
task_type: bugfix
goal: ci-hardening
parent: 1080
---
# #1084 — Fork worker counter bypass starves GC and RECREATE

## Problem

`scripts/compiler-fork-worker.mjs` runs each test262 shard as a long-lived
child process that reuses an `IncrementalLanguageService` across compiles.
The worker has three safety valves intended to keep state bounded:

1. `compileCount++` on every message
2. `globalThis.gc()` every `GC_INTERVAL = 25` compiles
3. `incrementalCompiler = null; createFreshCompiler()` every `RECREATE_INTERVAL = 200` compiles

All three are gated on `compileCount`. The bug: when the compile produces
errors (`!result.success || result.errors.some(...)`), the handler issues an
early `return` at the end of the error branch — **before** `compileCount++`
executes. Errors therefore never advance the counter. A chunk where errors
dominate (e.g. a dense early/syntax failure cluster) increments `compileCount`
rarely or not at all, so the 25-compile GC and 200-compile RECREATE boundaries
are never reached. The incremental compiler's `oldProgram` chain, lib
SourceFile cache, and checker state grow unbounded.

Second defect in the same region: at the RECREATE boundary the worker sets
`incrementalCompiler = null` **without calling `dispose()`**. The service's
`dispose` clears `oldProgram` explicitly; skipping it means the old Program
stays reachable through any closure the replacement path captures and through
V8's cached shapes, so "recreate" is not a clean reset.

## Self-reinforcing feedback loop

The two defects compose into a loop matching every observed symptom of the
2026-04-11 main-baseline drop (#1080):

1. A shard contains a cluster of errors → `compileCount` stops advancing.
2. State accumulates in the shared checker (`oldProgram` chain + lib cache).
3. Accumulated state triggers V8 stack overflow deep in a traversal.
4. Stack overflow surfaces as a compile error — another early return, another
   skipped `compileCount++`.
5. The poisoned compiler is never replaced. Every subsequent test in the
   chunk sees the same degraded state and emits stack-overflow errors with
   `compile_ms ≈ 0` (because the overflow fires before `compileExpression`
   even runs).

This matches the fingerprint dev-1031 and dev-1053 found on 2026-04-11:
cross-cutting failures, CI-state-dependent, ~compile_ms 0, and the
pathological 16×200 shape of the regression distribution.

## Proposed fix

Held locally in this worktree, not yet committed. Three changes in
`scripts/compiler-fork-worker.mjs`:

1. Wrap the message handler body in `try { ... } finally { compileCount++; ... }`
   so the counter advances regardless of success, error, or thrown exception.
2. Call `incrementalCompiler?.dispose?.()` before `incrementalCompiler = null`
   at the RECREATE boundary.
3. Add an observability log:
   `console.error(\`[fork-worker] RECREATE at compile ${compileCount}, heap=${heapMB}MB\`)`
   so CI logs show recycle boundaries landing in real shards.
4. Lower `RECREATE_INTERVAL` from 200 to 100 as defense in depth.

## Acceptance

- A chunk dominated by errors produces an observable `[fork-worker] RECREATE`
  log line every ~100 compiles in CI logs.
- dev-1053's chunk 1 reproduction: with current main, produces ~200 stack
  overflows. With the fix, produces 0 or ≤ the true per-test baseline (~19).
- No regression in the happy-path (successful compile) benchmark.

## Related

- #1080 — parent: main baseline collapse tracking issue
- #1081 — promote-baseline gating (frozen baseline)
- #1082 — ci-status-feed snapshot_delta vs net_per_test (merged as PR #111)
