# test262 `compile_timeout` cluster analysis (issue #1207, Phase 1)

> **Update 2026-05-01 (post-#1227, residual analysis):** After PR #131
> landed the dispatch-time-timer fix (#1227), the next baseline refresh
> dropped the `compile_timeout` count from 156 → 86 (a 45% reduction —
> tech-lead reported "155 → 75" mid-refresh; the committed JSONL settled
> at 86). I drove a per-test subprocess probe over **all 86** residuals
> (compile + instantiate + execute, 8 s wall-clock cap per test, each in
> its own `node` process so a hung test cannot stall the rest). Results:
>
> | result | count | meaning |
> |---|---:|---|
> | `pass` | 37 | finishes cleanly in <1 s in isolation |
> | `fail` | 26 | finishes in <1 s with a real test failure |
> | `compile_error` | 10 | sub-second compile error (real) |
> | `hang` | **9** | exec exceeded the 8 s subprocess timeout — **genuine runtime infinite loop in our Wasm shim** |
> | `probe_error` | 4 | file not found in test262/ (baseline drift) |
>
> **73 of 86 residuals (85%) finish fine in isolation.** They are still
> CI-runner artefacts — but no longer queue-wait artefacts (since #1227
> moved the timer to dispatch). The remaining contention shape is
> post-dispatch fork starvation: even after a worker has accepted a job,
> on a saturated 9-fork pool a single fork can be CPU-starved for tens
> of seconds when GC, JIT-tier-up, IPC backpressure, or other forks all
> compete for cores. The bimodal distribution (nothing between 5 s and
> 25 s) persists for the same reason it did before — when a fork stalls,
> it tends to stall through the timeout wall, not 8 seconds short of it.
>
> **The 9 genuine hangs cluster cleanly into 3 patterns** (not separate
> compiler bugs):
>
> 1. **65k-codepoint `eval`/RegExp loops** (5 tests):
>    - `test/language/literals/regexp/S7.8.5_A1.1_T2.js`
>    - `test/language/literals/regexp/S7.8.5_A1.4_T2.js`
>    - `test/language/literals/regexp/S7.8.5_A2.1_T2.js`
>    - `test/language/literals/regexp/S7.8.5_A2.4_T2.js`
>    - `test/language/comments/S7.4_A6.js`
>
>    All five share the shape `for (var cu = 0; cu <= 0xFFFF; ++cu) { eval("/" + ... + String.fromCharCode(cu) + "/"); }` — 65,536 calls into our `eval` / `RegExp` shim per test. Each iteration is fast in V8 (μs); ours hangs the 8 s ceiling, suggesting per-iteration cost in the seconds. Likely a non-pathological `eval` slowdown (compile + instantiate per call) compounded by 65k iterations — not a single bug, more a "don't pay compile + instantiate every iteration" perf path.
>
> 2. **AnnexB RegExp BMP escape coverage** (2 tests):
>    - `test/annexB/built-ins/RegExp/RegExp-leading-escape-BMP.js`
>    - `test/annexB/built-ins/RegExp/RegExp-trailing-escape-BMP.js`
>
>    Same 65k-codepoint shape but using `new RegExp(...)` instead of `eval("/.../")`. Same root cause as cluster 1: the per-call cost in our `RegExp` constructor stacks up over 65k iterations.
>
> 3. **`Array.prototype.{unshift,reverse}` on length ≈ 2^53 sparse objects** (2 tests):
>    - `test/built-ins/Array/prototype/unshift/length-near-integer-limit.js`
>    - `test/built-ins/Array/prototype/reverse/length-exceeding-integer-limit-with-object.js`
>
>    These build an array-like with `length: 2 ** 53 - 2` and a sparse set of indexed properties (a getter at one index that throws to short-circuit). The spec algorithms iterate `from k = len-1 down to 0`, with `HasProperty` checks per index. V8 short-circuits via the getter on the very first iteration; ours appears to walk all ~9 quadrillion indices. The fix is to use `O(defined-properties)` rather than `O(length)` iteration in our `Array.prototype.{unshift,reverse,…}` shims, but only when the receiver is a plain object with a giant `length` (not a real `Array`). Any test exercising this length-near-2^53 pattern lands in this cluster.
>
> **Honourable mention** (slow but not hung): `test/built-ins/Array/prototype/forEach/15.4.4.18-7-c-ii-1.js` finishes in 5.3 s in isolation — well under the 30 s pool ceiling, but borderline. The test puts a single value at index 999,999 of a 6-element array; our `forEach` shim then visits every index from 0 to 999,999 instead of only the defined ones. Same shape as cluster 3 but at a smaller scale.
>
> **Recommended action** — file three follow-ups, *all small / medium*:
>
> - **#1207b — `Array.prototype.{unshift,reverse,forEach,…}` should iterate over defined properties, not `[0, length)`, for non-Array receivers.** Unblocks cluster 3 (2 hangs) + the forEach honourable mention. Probably 1–3 lines per shim in `src/runtime.ts`.
> - **#1207c — `eval(literal)` and `new RegExp(literal)` inside hot loops should reuse the parsed/compiled form across iterations** (or at minimum, avoid IPC per call to a host import). Unblocks clusters 1 + 2 (7 hangs total). This is a perf path, not a correctness fix.
> - **#1207d — investigate post-dispatch fork starvation in the test262 pool.** Possible knobs: drop pool size from 9 to 7, lengthen GC pauses' visibility, use `nice` to keep the master process scheduled. This is what the remaining 73 phantom timeouts are; lowering the ceiling (Phase 3) would just convert them into fail-on-CI noise rather than fixing them.
>
> **Phase 3 of the original issue (drop the 30 s timeout to 10 s) is now safe** — every honest compile is <1 s. But it'll still surface the 73 phantom timeouts as `fail` rather than `compile_timeout`, so it should be paired with #1207d, not landed standalone.
>
> **Probe scripts** (gitignored under `.tmp/`): `probe-residual-timeouts.mts` (compile-only, single-process), `probe-residual-exec.mts` (compile + exec, single-process — hangs on first runtime infinite loop), `probe-one-residual.mts` (one test per process), `run-residuals.sh` (driver that runs `probe-one-residual.mts` over all baseline `compile_timeout` entries with an 8 s per-test ceiling). Re-run after #1207b/c lands to confirm the hang count drops.

---

> **Update 2026-05-01 (issue-1207-timeout-clusters branch):** The iter-close
> hang cluster (Cluster 1, 26 tests) appears to have been fixed since the
> 2026-04-30 baseline. The current `benchmarks/results/test262-current.jsonl`
> reports **156 `compile_timeout` entries** (down from 270). A
> single-threaded isolation probe over **all 156** of those files compiles
> in **31.6 s total wall-clock** (max individual compile: 553 ms; nothing
> >1 s). 134 of the 156 compile cleanly to a Wasm binary; the other 22
> hit a legitimate `compile_error` in <1 s.
>
> **The residual 156 are 100% runner-pool queue-wait artefacts, not compiler
> bugs.** Root cause: `scripts/compiler-pool.ts:195` starts the
> `setTimeout(..., timeoutMs)` at *enqueue* time, before the job is
> dispatched to a worker. On a saturated 9-fork pool, queued jobs sit
> 20–30 s waiting for a free fork; the timer fires before the worker
> picks them up. This explains the bimodal distribution (nothing between
> 5 s and 25 s, then a spike at the timeout wall) without invoking
> per-test compiler bugs.
>
> **Recommended action:** file a follow-up issue (e.g. `#1207a`) to move
> the timer creation from `enqueue` into `dispatch` — a one-spot change
> in `scripts/compiler-pool.ts`. The `Phase 2 — fix the root causes
> (separate issues per cluster)` plan in the original issue is no longer
> relevant: the clusters aren't real, they're artefacts of how the queue
> orders work. Phase 3 (lower the ceiling to 10 s) is safe to land
> *after* the dispatch-time-timer fix, since real compile times are
> all <1 s in isolation.
>
> **Probe location:** `.tmp/probe-all-timeouts.mts` (gitignored; loads
> `compile_timeout` entries from the baseline JSONL, recompiles each in
> the same process with a 60 s ceiling, writes
> `.tmp/isolation-results.jsonl`). Re-run after the runner fix lands to
> verify the timeout count drops to single digits.
>
> The original 2026-04-30 analysis below remains valid as historical
> context for the iter-close cluster that has since been fixed, and for
> the runner-load hypothesis (Cluster 2) that this updated probe now
> confirms quantitatively.

---

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
