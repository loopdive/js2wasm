---
id: 1294
sprint: 48
title: "test262 worker: reclassify WebAssembly.Exception compile-errors as fail + restart fork"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: test-infrastructure
language_feature: test262-runner
goal: conformance
related: [1221, 1160]
---
# #1294 — test262 worker: reclassify WebAssembly.Exception as fail + restart fork

## Background

`benchmarks/results/test262-current.jsonl` shows ~942 tests with `status:
compile_error` and `error: "[object WebAssembly.Exception]"`. These cluster
around `String.prototype` methods (replaceAll, search, slice, etc.).

**Root cause**: when a test installs a Wasm-throwing function as a
`String.prototype` method, the next test's `doCompile()` call triggers it
internally during TypeScript parsing/codegen. The `WebAssembly.Exception`
propagates out of `doCompile` and hits the outer catch at line 857 of
`scripts/test262-worker.mjs`:

```js
} catch (err) {
  incrementalCompiler = null;
  createFreshCompiler();
  process.send({
    id,
    status: "compile_error",
    error: err.message || String(err),   // ← WebAssembly.Exception has no .message
    ...
  });
```

`WebAssembly.Exception` has no `.message` property, so `String(err)` gives
`"[object WebAssembly.Exception]"`. The test is misclassified as a compiler
error, and — worse — the fork's poisoned state persists, infecting subsequent
tests in the same fork.

## Fix

In `scripts/test262-worker.mjs`, in the outer `catch` around `doCompile`
(lines ~857-869), detect `WebAssembly.Exception` and:

1. Send a `fail` result (not `compile_error`) with a clear error message
2. Call `process.nextTick(() => process.exit(1))` AFTER sending, so the pool
   respawns the fork with clean state for the next test

```js
} catch (err) {
  incrementalCompiler = null;
  createFreshCompiler();
  if (err instanceof WebAssembly.Exception) {
    // Poisoned String.prototype (or similar built-in) — Wasm throw escaped
    // from the TS compiler. Send a fail (not compile_error) and restart the
    // fork so subsequent tests get a clean environment.
    process.send({
      id,
      status: "fail",
      error: "wasm exception during compile (poisoned built-in)",
      isException: true,
      compileMs: performance.now() - compileStart,
    });
    postCompileCleanup();
    process.nextTick(() => process.exit(1));
    return;
  }
  process.send({
    id,
    status: "compile_error",
    error: err.message || String(err),
    compileMs: performance.now() - compileStart,
  });
  postCompileCleanup();
  return;
}
```

The `process.nextTick` ensures the `process.send` is flushed before exit.
The pool's existing `proc.on("exit")` handler calls `respawnFork()` which
gives subsequent tests a clean fork.

## Acceptance criteria

1. `compile_error` category in test262 no longer contains
   `"[object WebAssembly.Exception]"` entries
2. The ~942 tests that were misclassified should now appear as `fail`
   (or possibly `pass` if they were correct after all — depends on whether
   the test's own assertion was about the string method behavior)
3. No regression in existing passing tests

## Files

- `scripts/test262-worker.mjs` — outer catch around `doCompile` (~line 857)

## Expected impact

- ~942 fewer `compile_error` rows
- ~942 more `fail` rows (or possibly some converting to `pass` if the fork
  restart gives clean state)
- Net test262 pass rate: neutral (these were already not passing)
- Fork poisoning cascade eliminated: currently each poisoned test may corrupt
  subsequent tests in the same fork; after fix the fork restarts cleanly
