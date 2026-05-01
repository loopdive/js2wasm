# `[object WebAssembly.Exception]` flakiness — root cause + fix

**Date:** 2026-05-01
**Author:** senior-developer (research mode)
**Related:** #1155 (open, partially fixed), #1217 (canary), #1218 (PR-baseline validation)

## TL;DR

The 256 tests that flipped `pass → compile_error: "[object WebAssembly.Exception]"` between two no-op CI runs are **victim tests poisoned by prior tests in the same fork**. The "[object WebAssembly.Exception]" string is emitted by **two surviving leaks** in the worker error-classification logic:

1. `scripts/test262-worker.mjs` **outer catch (L970–978)** — `error: outerErr.message ?? String(outerErr)` → `"[object WebAssembly.Exception]"`
2. `scripts/wasm-exec-worker.mjs` **outer catch (L139–144)** — same pattern, plus marks `instantiateError: true` which the legacy harness records as `compile_error`

The inner instantiate catches were already fixed for #1155 (route `WebAssembly.Exception` to `status: "fail"` via `extractWasmExceptionMessage`). The **outer catches were missed**.

The non-determinism comes from **fork-state poisoning**: a "poisoner" test mutates a builtin (e.g. `Array.prototype[Symbol.iterator]` set to a callable Wasm thrower), `restoreBuiltins()` fails to restore it (or restores it but a related iterator-protocol slot remains poisoned), and the next test that calls `for...of` inside `restoreBuiltins`, `buildImports`, or any TS-compiler internal triggers a `WebAssembly.Exception`. Order-dependence comes from chunk-distribution + concurrent fork pool: which fork sees the poisoner first determines which subsequent tests flip.

---

## How `[object WebAssembly.Exception]` appears as `compile_error`

### Path A (most entries — 1,176 of 1,215, plain string)

`scripts/test262-worker.mjs` paths emitting `compile_error` with `error: <maybe-WebAssembly.Exception-stringified>`:

| Line | Trigger | Error string when err is `WebAssembly.Exception` |
|------|---------|---------------------------------------------------|
| 723–738 (doCompile catch) | `doCompile()` throws | `err.message \|\| String(err)` → `"[object WebAssembly.Exception]"` |
| 970–978 (outer catch) | anything between `buildImports` and `testFn()` invocation throws and isn't caught by inner try | `outerErr.message ?? String(outerErr)` → `"[object WebAssembly.Exception]"` |

For an instance of `WebAssembly.Exception`:
- `.message` is `undefined` (it's not an `Error` subclass)
- `String(err)` returns `"[object WebAssembly.Exception]"` (default Object → String tag)
- `err.message ?? String(err)` therefore yields the literal class-tag string

### Path B (39 entries — `[fail]` prefix)

`tests/test262-shared.ts` **FIXTURE branch (L354–417)** — only fires for tests with `_FIXTURE.js` static imports (e.g. `test/language/module-code/export-expname-binding-index.js`):

```ts
try {
  // ... inline compile + execute ...
  recordResult(relPath, category, "fail", String(execErr), undefined, scopeInfo);  // ← THROWS ConformanceError("fail", "[object WebAssembly.Exception]")
} catch (e: any) {
  recordResult(relPath, category, "compile_error", e.message ?? String(e), ...);   // ← double-records as "[fail] [object WebAssembly.Exception]"
}
```

`recordResult()` writes the JSONL row **and then throws** `new ConformanceError(status, error)` whose `.message` is `[${status}] ${detail}`. The outer catch swallows that and re-records as `compile_error`. **This is a harness bug** — every `recordResult("fail")` call in the FIXTURE branch produces a duplicate `compile_error` row.

### Empirical confirmation

```
grep "object WebAssembly.Exception" benchmarks/results/test262-current.jsonl
```
- **1,215 total entries**
- **1,176 plain** (Path A — surface from the unified worker)
- **39 with `[fail]` prefix** (Path B — FIXTURE double-record)
- **compile_ms median = 0** in Path A — strongly suggests `doCompile()` threw immediately (sub-ms), i.e. `restoreBuiltins()` itself triggered the throw, which is the very first step of `doCompile()` (L547–548).

Distribution by category (Path A+B): Temporal 518, TypedArray 173, String 112, annexB 104, TypedArrayConstructors 79, language/module-code 46, language/import 32, …

These are **victim categories** — none are "poisoner" patterns. They're all tests that just happened to land in a fork *after* a poisoner.

---

## Why fork-state poisoning still leaks past `restoreBuiltins`

`scripts/test262-worker.mjs` has substantial defence-in-depth (#1153/#1154/#1160) but two gaps remain:

### Gap 1: callable-but-throwing poison passes the typeof check

```js
// L410–418
const cur = Array.prototype[Symbol.iterator];
if (typeof cur !== "function") {
  console.error(`...FATAL: ...exiting for restart (#1160)`);
  process.exit(1);
}
```

This catches *non-callable* poison (e.g. `Array.prototype[Symbol.iterator] = 42`). It does **not** catch *callable* poison — e.g. `Array.prototype[Symbol.iterator] = wasmInstance.exports.thrower`, where `thrower` is a Wasm function whose body is a single `throw` instruction. `typeof` returns `"function"`; the check passes; then later `for...of` calls it and the Wasm `throw` propagates.

The very next loop in `restoreBuiltins` (L421) is:
```js
for (const key of Object.getOwnPropertyNames(Array.prototype)) {
```
which calls `Array.prototype[Symbol.iterator]` on the result. If that's the poisoned thrower (because the simple `=` restore at L394 silently failed against a non-writable descriptor, AND the `defineProperty` fallback at L400 silently failed against a non-configurable descriptor), the for-of throws `WebAssembly.Exception`. It propagates out of `restoreBuiltins` → out of `doCompile` → caught at L727 → emitted as `compile_error: "[object WebAssembly.Exception]"`.

### Gap 2: outer catch doesn't extract Wasm exception payload

The inner instantiate catch (L870–902) was fixed for #1155 — it routes `WebAssembly.Exception` through `extractWasmExceptionMessage(err, instance)` which returns useful text like `"wasm exception during module init"` or the actual `Error.message` from the Wasm-side `throw new Error(...)`. The outer catch (L970–978) was **missed** during the fix and still does the naive `outerErr.message ?? String(outerErr)`.

The same gap exists in `scripts/wasm-exec-worker.mjs` (L139–144).

---

## Determinism analysis

**Order-dependent** — given a fixed test order in a fixed fork, same outcome every time. Non-determinism comes from:
- **Chunk distribution**: 16 chunks via `i % totalChunks === chunkIndex` (test262-shared.ts L273) — which test goes to which chunk is fixed.
- **Concurrent fork dispatch**: Within a chunk, `describe.concurrent` + `CompilerPool` (4–7 forks) means tests are dispatched to whichever fork is free first. **This is racy across runs** — same chunk, different fork assignment, different victim set.
- **Worker recreation interval** (`RECREATE_INTERVAL = 100`): the incremental TS compiler is recycled, but **the JS process and its mutated globals are not**. Poisoning persists for ~100s of subsequent tests.

So: `compiler bug` = no, `harness isolation bug` = yes.

---

## Reproduction (negative result is informative)

```sh
node --experimental-strip-types /tmp/repro-poison2.mjs
```
A standalone single-test repro fails to trigger `WebAssembly.Exception` because:
- The Wasm thrower needs the test262-emitted exception tag setup
- The poison would have to be a function that throws via a tag, not a plain `throw new Error()` (which V8 turns into a regular `Error` not a `WebAssembly.Exception`)

This explains why **the bug is invisible in isolated `node /tmp/test.wasm` runs** but fires in CI: only an ordered run-of-many-tests inside the same fork can build up the cross-test state needed.

---

## Recommended fix (fastest path)

### Patch 1 — fix `compile_error: "[object WebAssembly.Exception]"` stringification (5 minutes)

Move the existing `extractWasmExceptionMessage()` helper outside the message handler and call it from the **outer** catch in both workers. Reclassify if the error is `WebAssembly.Exception` (it's a runtime throw, not a compile failure):

`scripts/test262-worker.mjs` L970–978:

```js
} catch (outerErr) {
  if (outerErr instanceof WebAssembly.Exception) {
    // Wasm runtime exception escaped the inner try — treat as runtime fail,
    // not compile error. Stringify via the dedicated helper.
    process.send({
      id,
      status: "fail",
      error: extractWasmExceptionMessage(outerErr, instance ?? null),
      isException: true,
      compileMs,
      execMs: performance.now() - execStart,
    });
  } else {
    process.send({
      id,
      status: "compile_error",
      error: outerErr.message ?? String(outerErr),
      compileMs,
      execMs: performance.now() - execStart,
    });
  }
  postCompileCleanup();  // ALSO MISSING in current code!
}
```

`scripts/wasm-exec-worker.mjs` L139–144: same change, using `extractWasmExceptionInfo` already in that file.

### Patch 2 — fix FIXTURE double-record (5 minutes)

`tests/test262-shared.ts` L406–415: the inner `recordResult("fail", ...)` throws `ConformanceError`, which is then caught by the outer catch and re-recorded as `compile_error`. Solution:

```ts
} catch (execErr: any) {
  if (isRuntimeNegative) {
    recordResult(relPath, category, "pass", undefined, undefined, scopeInfo);
  } else {
    recordResult(relPath, category, "fail", String(execErr), undefined, scopeInfo);
  }
  return;  // ← prevent the outer catch from re-recording
}
```

Or, hoist the inner success/fail flow out of the outer try entirely so `ConformanceError` propagates to vitest as it does in the non-FIXTURE path.

### Patch 3 — close the iterator-poisoning gap (10 minutes, defence-in-depth)

After the existing typeof check at L410–418, add a **callability probe**:

```js
{
  const cur = Array.prototype[Symbol.iterator];
  if (typeof cur !== "function") { /* existing FATAL exit */ }
  // NEW: if poison is a function but throws when called, also FATAL.
  try {
    const probe = cur.call([]);
    probe.next?.();
  } catch (probeErr) {
    console.error(
      `[unified-worker pid=${process.pid}] FATAL: Array.prototype[Symbol.iterator] throws when called (${probeErr?.constructor?.name}) — exiting for restart`,
    );
    process.exit(1);
  }
}
```

A worker-exit on detection lets the pool respawn cleanly (OS reclaims memory + globals reset). The pending in-flight test will time out at 30s but **no further tests are corrupted**. Far better than the current behaviour where one poisoner can flip ~256 tests.

Apply the same probe for any other restored iterator (`Object.prototype` symbols, `String.prototype[Symbol.iterator]`, etc.) — but iterator alone is the high-value one because every `for...of` hits it.

### Patch 4 — bound the blast radius (medium-term, follows from the canary in #1217)

Reduce `RECREATE_INTERVAL` (currently 100 in the unified worker) to **respawn the entire fork** (not just the incremental compiler) periodically. A fresh fork = fresh JS globals = poisoning gone. Trade-off: spawn overhead per ~50 tests vs. drift containment. Combined with #1217's flip-rate canary we can tune empirically.

---

## Answers to the three explicit questions

> **Q1. Why does `[object WebAssembly.Exception]` appear as compile_error not runtime_error?**

Two surviving outer-catch leaks (Path A above) classify any uncaught throw-during-instantiate-or-execute as `compile_error` and stringify the `WebAssembly.Exception` via the default `Object.prototype.toString` tag. The inner instantiate catches were fixed for #1155 to route through `extractWasmExceptionMessage` and emit `status: "fail"`; the outer catches were missed.

> **Q2. Is this truly non-deterministic or is it order-dependent?**

**Order-dependent** within a fork (deterministic given fixed test order). Non-deterministic across runs because of chunk distribution + concurrent fork-pool dispatch — same test can land in a clean fork or a poisoned fork between runs. The 256 flips between two no-op CI runs match this exactly: the poisoner-test-set landed differently in the two runs.

> **Q3. What is the fastest fix — harness change or compiler change?**

**Harness change.** All three patches above are harness-only, total ≤ 30 min of work. The compiler emits valid Wasm; the test262 worker just mis-classifies and mis-handles `WebAssembly.Exception` in two specific code paths. No codegen change is needed for this cluster.

Recommended order: Patch 1 (eliminates the misclassification — converts the 1,176 plain entries to either `fail` or `pass`) → Patch 3 (eliminates the flake source itself — cuts the per-fork blast radius to 1 test) → Patch 2 (eliminates the FIXTURE double-record — clean accounting) → Patch 4 (long-term containment, depends on canary measurements).

---

## Files referenced

- `scripts/test262-worker.mjs` — unified compile+execute worker (forks via `compiler-pool.ts`, used by `test262-shared.ts` for chunked vitest run)
- `scripts/wasm-exec-worker.mjs` — execute-only worker (worker_threads, used by legacy `test262-vitest.test.ts`)
- `scripts/compiler-pool.ts` — fork-pool manager (CompilerPool)
- `scripts/runtime-bundle.mjs` — `buildImports` / `setExports` (host import wiring)
- `tests/test262-shared.ts` — chunked vitest runner (current main path)
- `tests/test262-vitest.test.ts` — legacy vitest runner (still loaded but the chunk runner is what the CI shards exercise)
- `plan/issues/backlog/1155.md` — original bug report (filed 2026-04-21, partial fix landed for inner catch only)
- `plan/issues/sprints/46/1217.md` — flip-rate canary (will catch regressions in this code post-fix)
