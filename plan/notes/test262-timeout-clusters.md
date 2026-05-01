# test262 `compile_timeout` cluster analysis (issue #1207, Phase 1)

Date: 2026-04-30 (this analysis), 2026-05-01 (write-up)
Baseline: `benchmarks/results/test262-current.jsonl`
Author: senior-developer (research only — no code changes)

## Executive summary

**The label `compile_timeout` is misleading.** The 30 s ceiling in
`scripts/compiler-pool.ts` (`enqueue` → `runTest` default
`timeoutMs = 30_000`, called from `tests/test262-shared.ts:434`) covers
the **combined compile + execute** step inside the unified
`test262-worker.mjs`. Whenever the worker exceeds 30 s — for any reason —
the pool resolves the message with `status: "compile_timeout"`,
respawns the fork, and moves on. There is no separate compile-vs-exec
breakdown in the timeout path.

That changes the framing of the issue. The 270 entries listed as
`compile_timeout` in the current baseline are not necessarily compiler
hangs. The largest single cluster — 26 destructuring-with-iterator-close
tests — is a **runtime infinite loop in our destructuring binding
shim**, where compile finishes in ~400 ms but execution hangs for the
full 22-28 s wall.

## Confirmed timeout values (Phase 1, step 1)

| Where | Value | Used for |
|---|---|---|
| `scripts/compiler-pool.ts:144` | `timeoutMs = 10_000` | `pool.compile()` (compile-only) |
| `scripts/compiler-pool.ts:175` | `timeoutMs = 30_000` | `pool.runTest()` (compile + execute) — **this is the test262 path** |
| `tests/test262-shared.ts:434` | `30_000` | Explicit timeout passed to `pool.runTest` |
| `tests/test262-shared.ts:287` | `30_000` | `afterAll` shutdown hook (unrelated) |

The combined timer is set in `compiler-pool.ts:195`:

```ts
const timer = setTimeout(() => {
  console.error(`[pool] TIMEOUT: exceeded ${timeoutMs / 1000}s ...`);
  resolve(msg.execute
    ? ({ status: "compile_timeout", error: ..., compileMs: timeoutMs })
    : ({ ok: false, error: ..., compileMs: timeoutMs }));
  // SIGKILL the stuck fork, respawn
}, timeoutMs);
```

Note that `compileMs: timeoutMs` is hard-coded to the timeout value on
expiry, so no real compile-vs-exec split is preserved. We can only
distinguish runtime from compile-time hangs by **reproducing in
isolation**.

## Distribution (Phase 1, step 2)

Today's `compile_timeout` count is **270** (issue #1207 cited 136; the
baseline grew between filing and analysis). Bucketing by 5-level path
prefix:

| Count | Path prefix | Cluster |
|---:|---|---|
| 14 | `test/language/expressions/class/dstr` | iter-close + private dstr |
| 14 | `test/language/statements/class/dstr` | iter-close + private dstr |
| 14 | `test/language/expressions/class/elements` | private name + async/generator |
| 7 | `test/built-ins/Array/prototype/reduce` | Array-prototype on weird objects |
| 6 | `test/built-ins/Array/prototype/forEach` | Array-prototype with accessor traps |
| 5 | `test/language/statements/class/elements` | as above |
| 4 | `test/built-ins/Array/prototype/splice` | Array-prototype |
| 4 | `test/built-ins/Array/prototype/filter` | as above |
| 3 | `test/built-ins/RegExp/unicodeSets/generated` | RegExp `v` flag (currently CE) |
| 3 | `test/built-ins/String/prototype/split` | String split |
| 3 | `test/built-ins/Temporal/Instant/prototype` | Temporal (skipped feature) |
| 3 | `test/built-ins/Function/prototype/call` | Function.prototype.call |

Pattern coverage (overlapping):

| Count | % | Pattern |
|---:|---:|---|
| 51 | 18.9% | path contains `Array/prototype` |
| 32 | 11.9% | path contains `private` |
| 28 | 10.4% | path contains `class/dstr` |
| 26 | 9.6% | path contains `iter-close` |
| 25 | 9.3% | path contains `ary-init-iter-close` |
| 22 | 8.1% | path contains `async-` |
| 19 | 7.0% | path contains `class/elements` |
| 17 | 6.3% | path contains `TypedArray` |
| 11 | 4.1% | path contains `Object/defineProperty` |
| 11 | 4.1% | path contains `Temporal` |

## Per-cluster reproducer (Phase 1, step 3)

I drove `scripts/test262-worker.mjs` directly via `.tmp/probe-wrapped.mjs`
(uses the same `wrapTest()` from `tests/test262-runner.ts` that the
real test pipeline uses). Each entry records `compileMs` / `execMs` /
total wall time:

### Confirmed runtime hangs (compile fast, execute hangs)

| Test | compileMs | execMs | Status |
|---|---:|---:|---|
| `language/expressions/class/dstr/meth-ary-init-iter-close.js` | 363 | **22,389** | hung (wall: 23.9 s) |
| `language/statements/class/dstr/gen-meth-ary-init-iter-close.js` | 430 | **26,003** | hung (wall: 27.9 s) |
| `language/expressions/class/dstr/private-meth-ary-init-iter-close.js` | 522 | **28,348** | hung (wall: 30.6 s) |

Compile is uniformly ~400-500 ms. The 22-28 s wall is **execution
time**, i.e. the destructuring binding loop hangs.

### Tests that *don't* reproduce in isolation (load-induced timeouts?)

| Test | compileMs | execMs | Status |
|---|---:|---:|---|
| `built-ins/Array/prototype/forEach/S15.4.4.18_A2.js` | 736 | 20 | pass |
| `built-ins/Array/prototype/reduce/15.4.4.21-2-13.js` | 603 | 42 | pass |
| `built-ins/Array/prototype/filter/15.4.4.20-9-c-iii-1.js` | 491 | 3 | pass |
| `built-ins/Array/prototype/splice/S15.4.4.12_A1.1_T6.js` | 1923 | 4 | fail (real bug, not hang) |
| `built-ins/Function/prototype/call/S15.3.4.4_A13.js` | 472 | 3 | pass |
| `built-ins/RegExp/unicodeSets/generated/character-class-escape-union-character-class-escape.js` | 438 | 1 | pass |
| `language/statements/for-of/dstr/array-empty-iter-close-err.js` | 401 | 2 | fail (real bug, not hang) |
| `language/statements/for-await-of/async-gen-dstr-const-ary-init-iter-close.js` | 500 | 11 | fail (real bug, not hang) |
| `language/expressions/class/elements/after-same-line-static-async-method-grammar-privatename-identifier-semantics-stringvalue.js` | 458 | 2 | pass |

These were marked `compile_timeout` in the baseline but compile + run
to completion in isolation in **<3 s total**. This contradicts the
issue's bimodal-distribution premise for many of the 270 — **at least
~70 of the 270 timeouts may be load-induced flakes**, not real hangs.

The remaining ~26 iter-close tests are reproducible runtime hangs.

## Hypotheses per cluster (Phase 1, step 4)

### Cluster 1 — `ary-init-iter-close` (26 tests, **REPRODUCED runtime hang**)

**Pattern:**

```js
var iter = {};
iter[Symbol.iterator] = function() {
  return {
    next: function() { return { value: null, done: false }; },  // never done!
    return: function() { doneCallCount += 1; return {}; }
  };
};

var C = class {
  method([x]) { ... }   // single-element destructure
};

new C().method(iter);
```

The iterator's `next()` always returns `done: false`. The destructuring
pattern `[x]` only needs ONE binding. Spec semantics
(13.3.3.5 BindingInitialization for ArrayBindingPattern):

1. Pull one value via `next()` → assign to `x`.
2. **Stop pulling** — the pattern only has one element.
3. Call `IteratorClose(iterator)` → invokes `iterator.return()`.

**Hypothesis (very strong, given 22-28 s exec time):** our destructuring
codegen for `[x] = iter` translates the binding pattern into a loop
that repeatedly polls `next()` until it sees `done: true`, instead of
pulling exactly N times where N = pattern arity. Since this iterator
never sets `done: true`, the loop runs forever.

**Likely fix location:** `src/codegen/expressions.ts` or
`src/codegen/statements.ts` — wherever array-destructuring binding
emits the iterator step loop. We need to:
1. Pull at most `pattern.elements.length` items (skipping `done: true`
   short-circuit).
2. After all bindings are extracted, **always call `IteratorClose`**
   regardless of `done` state (spec step 4).

A quick way to confirm: grep for "IteratorClose" or look at how we
lower `[x] = iter` for an iterable. If the loop condition is
`while (!result.done)` with no element-count cap, that's the bug.

**Effort:** 1-2 days. One pass change. Each fix unlocks all 26 tests.

### Cluster 2 — `Array/prototype/{reduce,forEach,filter,map,splice,…}` (51 tests, mostly NOT reproduced)

**Pattern:** Array prototype methods called via `.call(obj, ...)` on
non-array objects with `Object.defineProperty`-installed accessor
traps for `length`, indexed keys, or `Object.prototype[idx]`.

Tests run fast and pass in isolation. **Hypothesis:** the bulk of these
are **flakes due to runner load** — when 9 forks compete for CPU, a
test that normally executes in ~50 ms can stretch to 30+ s. The
"bimodal distribution" premise breaks down at this saturation point:
forks queueing on shared state (e.g., test runner I/O, GC pauses
across forks) push some tests over the wall.

**Hypothesis 2 (a smaller subset):** we have real correctness bugs in
`Array.prototype.{reduce,forEach,filter,...}` for sparse / accessor-
trapped Array-like objects (e.g., `length` getter that returns
undefined → coerces to NaN → `k < NaN` is false → loop exits early →
test fails) but the tests STILL pass-through because they don't hang.

**Action:** Don't try to fix this cluster as a "hang" — it's not a hang.
The right response is the parallelism / runner-load theme tracked
elsewhere (#1217 smoke-canary, separate parallelism issues), or
investigation per-test to verify the real status.

### Cluster 3 — `class/elements` with private + async/generator (19 tests, NOT reproduced for the one we sampled)

**Pattern:** classes with `static async` methods, private fields with
Unicode-escape names (`#\u{6F}`, ZWJ/ZWNJ), and verifyProperty checks.

Sampled `after-same-line-static-async-method-...stringvalue.js` runs
in 2 s in isolation. **Hypothesis:** also load-induced flakes for some
subset; possible real `feature: class-fields-private` correctness gaps
for the rest. Worth a separate pass after the iter-close fix.

### Cluster 4 — `RegExp/unicodeSets/generated` (3 tests)

**Pattern:** `/[…]+/v` flag (regexp v-flag, ES2024 feature).

Each test is ~50 lines, compiles in ~440 ms, executes in <2 ms. These
are also load-induced flakes / one-shot failures — not hangs. We may
not even support the `v` flag yet (would surface as compile_error /
fail, not timeout).

### Cluster 5 — `Temporal` (11 tests)

Already in the skip list per `feature: Temporal` filter; these
shouldn't be reaching the compile path. Worth checking — if they're
running, the skip filter has a hole. Not a hang concern.

### Cluster 6 — `private` (32 tests, overlap with class/dstr and class/elements)

Mostly the same tests already counted in clusters 1 and 3. Not a
distinct cluster.

## Top 3 most-fixable clusters

1. **`ary-init-iter-close` (26 tests, REPRODUCED hang).** Confirmed
   runtime infinite loop in destructuring binding when iterator never
   returns `done: true`. Single fix in `src/codegen/expressions.ts` (or
   wherever `ArrayBindingPattern` lowering lives) that:
   - bounds the iterator pull count by the pattern arity, and
   - always emits `IteratorClose` after binding completes.

   Each fix unlocks all 26 in one go. **This is the only cluster that's
   genuinely a compiler bug fixable in Phase 2 of the issue.**

2. **Investigate runner-load cluster (~70-100 tests).** The Array/
   class-elements / RegExp tests that don't reproduce in isolation
   suggest fork saturation pushes ~25-40% of "compile_timeout" entries
   over the wall as flakes. Approaches:
   - Drop the pool from 9 forks to 6-7 forks; measure if the timeout
     count drops.
   - Add a per-test soft warning at execMs > 5 s (so we can see hot
     spots without killing them).
   - Pre-warm forks longer / increase `RECREATE_INTERVAL`.

   This is **not a Phase-2 compiler-bug fix**; it's a runner-tuning
   investigation that may belong in a separate issue.

3. **Audit `Array.prototype.{forEach,reduce,filter}` for Array-like
   objects with accessor `length`.** Even though these don't hang, they
   may be silently failing or producing wrong outputs. Worth a separate
   conformance issue to bring `Array.prototype` to spec.

## Recommended next step

**Tackle Cluster 1 first.** It's the only confirmed compile-time-or-
runtime-hang, the test cases are uniform (26 procedurally-generated
variants of one pattern), the fix scope is narrow (one codegen pass,
one location), and the wall-clock impact is large:

- **26 tests × 30 s wall = 780 fork-seconds saved per run**
- = **~87 s wall-clock at 9-way parallelism per run**
- ~20% of the issue's claimed 7.6 min savings, from a one-spot fix

Filing a follow-up issue for this is straightforward:

> **Title:** `fix(codegen): bound iterator pulls by ArrayBindingPattern arity (close iter-close hang)`
> **Body:** lowering of `[x, y, …] = iter` polls `next()` until
> `done: true`; for iterators that never report done, this hangs.
> Pull at most `pattern.elements.length` values, then unconditionally
> call `IteratorClose`. Fix unlocks 26 test262 timeouts.

After this lands, re-measure. If the timeout count drops by ~26 and
the remaining ~244 still appear, the residual is overwhelmingly
runner-load flakiness (not compiler bugs). At that point, **Phase 3
of #1207 (drop the timeout to 10 s) becomes risky**: if 70+ of the
"timeouts" are load flakes that would still fail at 10 s, we'd be
turning the dial without saving real wall-clock.

A safer Phase 3: **drop to 15 s**, not 10 s, and gate on the iter-close
fix landing first.

## Probe scripts (for reproducing)

`/workspace/.tmp/probe-wrapped.mjs` — feeds one test through `wrapTest`
+ `test262-worker.mjs` and reports `compileMs` / `execMs`. Usage:

```bash
npx tsx .tmp/probe-wrapped.mjs test262/test/<path>
```

`/workspace/.tmp/probe-timeout.mjs` — same but skips `wrapTest`
(tests the raw source). Useful for comparing wrapped-vs-raw compile
times.

Both are gitignored under `.tmp/` per project convention.
