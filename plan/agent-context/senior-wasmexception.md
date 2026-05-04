# senior-wasmexception — context summary (terminated 2026-05-01)

Sprint 46 senior-developer instance, single-issue scope.

## Mission

Investigate the test262 flakiness pattern where 256 tests flipped
`pass → compile_error: "[object WebAssembly.Exception]"` between two
no-op CI runs, then implement the fix. Pure harness-isolation work,
no codegen.

## Outcome

**Issue #1221 closed via PR #115, merged to main as commit `6e9fdcb20`
on 2026-05-01.** Sprint-46 task #30 → completed.

## Investigation findings (preserved in `plan/notes/wasmexception-flakiness.md`)

The 256 flips were victim tests in forks poisoned by prior tests in
the same vitest worker process. Three harness bugs combined to surface
the symptom:

1. **Outer-catch leaks** in two workers (`scripts/test262-worker.mjs`
   L970–, `scripts/wasm-exec-worker.mjs` L139–): the inner instantiate
   catches were fixed for #1155 to route `WebAssembly.Exception`
   through `extractWasmExceptionMessage` and emit `status:"fail"`.
   The OUTER catches were missed — they still default to
   `compile_error` with `error: outerErr.message ?? String(outerErr)`,
   yielding `"[object WebAssembly.Exception]"` because the class lacks
   a `.message` and `String()` falls through to the toString tag.

2. **Iterator-poisoning bypass in `restoreBuiltins`** (L410–418): the
   existing typeof check catches non-callable poison only. A test that
   assigns a Wasm-throwing function to `Array.prototype[Symbol.iterator]`
   passes typeof, then the very next `for...of` inside `restoreBuiltins`
   triggers the throw — propagating to the outer catch and flipping
   ~100 subsequent tests in the same fork.

3. **FIXTURE double-record** in `tests/test262-shared.ts` L406–415:
   `recordResult("fail", …)` throws a `ConformanceError` (so vitest
   marks the test failed); the surrounding outer catch swallowed the
   ConformanceError and re-recorded as `compile_error`, producing rows
   like `compile_error: "[fail] [object WebAssembly.Exception]"`.

## Patches landed (PR #115, +84 / −12 across 3 files)

1. **`scripts/test262-worker.mjs` outer catch** — `instanceof
   WebAssembly.Exception` → `status:"fail"`, error via
   `extractWasmExceptionMessage(outerErr, instance ?? null)`. Inner
   catch already had this from #1155.
2. **`scripts/wasm-exec-worker.mjs` outer catch** — same fix using
   `extractWasmExceptionInfo`.
3. **`scripts/test262-worker.mjs` `restoreBuiltins` callability probe**
   — after the existing typeof check, call
   `Array.prototype[Symbol.iterator].call([]).next()` and `process.exit(1)`
   on throw. Caps blast radius to one test per fork-respawn cycle.
4. **`tests/test262-shared.ts` FIXTURE branch** — `if (e instanceof
   ConformanceError) throw e;` re-throw guard so vitest receives the
   ConformanceError and the JSONL only has one row (matching the
   non-FIXTURE path).

## CI outcome

Regression-gate failed on default `regressions > 0` threshold but the
numbers were dead-center of the documented baseline-drift band:

| Metric              | PR 111 | PR 112 | PR 113 | PR 114 | **PR 115** |
|---------------------|--------|--------|--------|--------|------------|
| regressions         | 147    | 155    | 125    | 157    | **138**    |
| regressions_real    | 37     | 41     | 32     | 21     | **39**     |
| compile_timeouts    | 110    | 114    | 93     | 136    | **99**     |
| improvements        | 144    | 145    | 140    | 150    | **138**    |
| snapshot_delta      | -10    | -14    | +17    | -17    | **+3**     |

Compile_timeout regression bucket scattered across 10+ test categories
evenly (RegExp 14, Array 14, Object 14, …) — not clustered in any
category my probe would specifically affect. Cross-PR cumulative
evidence: drift, not real regression.

**Bucket reclassification (the actual win):**
- compile_error: 2,508 → 2,337 (−171)
- fail: 16,792 → 16,970 (+178; correct bucket for Wasm exceptions)
- compile_timeout: 244 → 237 (−7)
- pass: 27,027 → 27,027 (net 0; the previously-misclassified rows
  were genuine fails, not negative tests, so they moved
  compile_error → fail rather than compile_error → pass)
- 16 tests promoted from previously-recorded `compile_error: "[object
  WebAssembly.Exception]"` directly to `pass`.

Team-lead approved override; `gh pr merge 115 --admin --merge` succeeded.

## Coordination notes

- Issue **#1155** (open in backlog) had the original diagnosis filed
  2026-04-21. Inner-catch fix landed in an earlier session; #1221
  closes the remaining outer-catch + harness gaps.
- Issue **#1217** (smoke-canary for test262 flip rate) and issue
  **#1218** (auto-validate committed baseline on PR) are the
  observability work that will detect any future drift introduced
  by this kind of harness change.
- Issue **#1220** (test262-worker Promise snapshot + prototype
  cleanup) is in_progress on a different branch — orthogonal to
  #1221 (different prototype-cleanup gap, also targets harness
  isolation). 12 of the 39 real regressions in my CI run were
  Promise-related and may be the gap #1220 is closing.

## Files of record

- `plan/notes/wasmexception-flakiness.md` — full root-cause analysis
  (kept as permanent reference)
- `plan/issues/sprints/46/1221.md` — issue file (status: done)
- `plan/log/dependency-graph.md` — added "Recently merged — harness/CI
  (sprint-46)" entry
- PR #115 commit `6e9fdcb20`

## Next-session guidance

Nothing pending from this scope. If `[object WebAssembly.Exception]`
re-appears in test262 baselines, suspect:

1. A new harness path that `await`s during a previously-instantiated
   test's microtask leak (the outer-catch fix only handles
   `instanceof WebAssembly.Exception` — async rejections are still
   silenced by `process.on("unhandledRejection", () => {})` but
   could surface differently if that handler is removed).
2. A new prototype-poisoning vector not covered by `restoreBuiltins`
   (it currently snapshots/restores a fixed list — see the
   `_METHOD_SNAPSHOTS` / `_STATIC_SNAPSHOTS` / `_ACCESSOR_SNAPSHOTS`
   arrays).
3. A test that poisons `%ArrayIteratorPrototype%.next` (not in the
   snapshot list — would bypass even the new callability probe
   because the probe only validates `Array.prototype[Symbol.iterator]`,
   not the iterator prototype's `.next`).

The investigation note has the full code paths if a follow-up is
needed.
