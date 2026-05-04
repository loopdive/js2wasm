# Dev-a context summary — 2026-04-25 (#1016b: PR #21 merged, redirect deferred)

## Session results

**One PR merged this session**:
- **PR #21** (merge commit `bb55183a`) — #1016b iterator element-access dispatch. CI: pass=25472, snapshot_delta **+41** vs baseline 25431. Self-merged via `gh pr merge 21 --admin --merge`.

**Branch**: `issue-1016b-iterator-null-access` (worktree clean, in sync with `origin/main` post-merge)

## What landed in PR #21

Single fix in `src/codegen/expressions/calls.ts`:
- New iterator-protocol fast path at the top of the resolved-element-access call section in `compileCallExpression`. When `methodName === "@@iterator"` or `"@@asyncIterator"`, route through `__iterator` / `__async_iterator` host imports instead of falling through the null-pushing fallback.
- Coerces receiver to externref via `extern.convert_any` (for ref/ref_null) or `__box_number` (for f64/i32). Externref / funcref pass through unchanged.
- Iterator methods take no args; any extra arg expressions are evaluated for side effects then dropped.

Test file: `tests/issue-1016b.test.ts` — 4 cases (array, Map, string, var-C generator method). All pass.

**Verified locally**: 17+ test262 ArrayIterator/Map/Set/String iterator tests now pass that previously failed with `"Cannot read properties of null (reading 'next')"`.

## What was reverted before merge (CRITICAL learning)

Initial commit on the branch ALSO included a Fix #2: skip `"__class"` in `classExprNameMap` to prevent anon-class-expression mapping clobber. CI flagged **snapshot_delta = -1012** on that commit.

The mechanism: TypeScript assigns the synthetic symbol `"__class"` to ALL anonymous class expressions. The classExprNameMap was clobbered each time, but apparently the LAST mapping happened to be the one that made many class-dispatch tests pass coincidentally. Skipping the mapping broke those.

**Commit history on the branch**:
- `fa8ba464` — initial fix (both Fix #1 and Fix #2)
- `b8751220` — merge of origin/main (planning artifacts only)
- `f81944a6` — revert(codegen): drop Fix #2 — keep Fix #1 only
- `bb55183a` — merge into main

**Lesson**: when a class-dispatch resolution path is touched, the only safe approach is to leave existing mappings intact AND add new behavior, not to remove old behavior. The fix that "looks right" structurally can be holding up tests that are passing for the wrong reason.

## Task #8 redirect (function/generator parameter destructuring) — DEFERRED

Tech lead redirected me to the function-parameter-iterator scope of #1016b after PR #21 merged. I investigated for ~30 min and concluded it needs an architect spec / senior-developer (Opus) before a dev attempts it. **I did not write any code for this scope.**

### Findings against current main (post-PR #21)

`function/dstr/ary-*` tests: **34/68 pass** locally. Remaining failures cluster:
- 11 fail with `"Cannot destructure 'null' or 'undefined'"` (the dominant 450-bucket)
- 4 fail with `CompileError` (codegen bugs in elision + rest patterns)
- ~12 fail with assertion mismatches (iterator close protocol not invoked — `.return()` never fires)
- 6 are `negative: SyntaxError` tests where our CE matches spec but the test wrapper doesn't handle negative tests

### Root cause of the dominant `"Cannot destructure null/undefined"` bucket

Probed `dflt-ary-init-iter-close.js` end-to-end:

1. `var iter = {}` followed by `iter[Symbol.iterator] = function() {...}` triggers the **var-pre-pass** (in `src/codegen/declarations.ts`, the `widenedVarStructMap` machinery) to register `iter` as a Wasm struct with a `@@iterator` field.
2. But `{}` (empty object literal) compiles via `__new_plain_object()` which returns an **externref** of a JS `{}`, not a `struct.new` of that struct type. (See `src/codegen/literals.ts:208-228` — the heuristic + comment about "150+ dstr regressions" from prior over-broad application.)
3. `__module_init` then does `extern.convert_any` + `ref.test (ref <structIdx>)` — the cast fails (JS object ≠ Wasm struct), `else` branch yields `ref.null` → **`__mod_iter = null`**.
4. The subsequent `iter[Symbol.iterator] = fn` does `__extern_set(null, "@@iterator", fn)` which silently no-ops on null.
5. Inside `f([x] = iter)`, the param-default replaces `undefined` with `__mod_iter` which is **null**. The next null-check throws `"Cannot destructure null or undefined"`.

**Reproducing**: my probe at `/workspace/.tmp/probe_iter_close9.mts` reproduces with no `:any` annotation; adding `: any` masks the bug because then iter's type is externref and the var-pre-pass doesn't register a struct.

### Why this is hard / why I stood down

This is a structural codegen interaction:
- The var-pre-pass that registers an anon struct based on observed property assignments is correct in principle (gives precise types when assignments use static keys).
- The `{}` literal heuristic is correct in principle (uses `__new_plain_object` for `any` / `object` contexts).
- The interaction between them breaks: when later assignments use COMPUTED keys (`[Symbol.iterator]`, `[expr]`), the var-pre-pass shouldn't register a struct — but it does, and the `{}` literal then doesn't match.

The fix is one of:
- **Option A**: Suppress the var-pre-pass struct registration when ANY property assignment uses a computed key. Risk: may regress tests that mix computed and static keys.
- **Option B**: Make `__new_plain_object` emit `struct.new <type>` when the contextual type is a registered struct. Risk: 150+ dstr tests stabilized in the current literals.ts:208-228 logic.
- **Option C**: Detect `var x = {}` followed by computed-key assignments and force `iter`'s declared type to externref instead of struct. Risk: smaller, but requires a coordinated edit across declarations.ts pre-pass + literals.ts emit.

All three risk repeating PR #59's trap (fixing one path while breaking another). Per the issue file: "Sample regressions explicitly for every merge … When a bucket has high churn (big regressions + big improvements in the same test family), investigate each direction separately."

### Current state at shutdown

- Worktree: `/workspace/.claude/worktrees/issue-1016b` (clean, no uncommitted work)
- Branch: `issue-1016b-iterator-null-access` (synced with `origin/main` after PR #21 merge — fast-forward only)
- Probes left in `/workspace/.tmp/`:
  - `probe_iter_wt.mts` — minimal `arr[Symbol.iterator]()` test (PASSES post-fix)
  - `probe_all_iter.mts` — 85-test sweep of the original null-next list (17 PASS post-fix)
  - `probe_iter_close.mts` through `probe_iter_close10.mts` — drill-down on the iterator-close bucket
  - `probe_fn_buckets.mts` — function/dstr ary sweep (34/68 PASS)
  - `run_test_file2.mts` — runs the new `tests/issue-1016b.test.ts` cases standalone

## Recommendations for whoever picks this up next

1. **Read PR #21's commit history first** (`fa8ba464` → `f81944a6` → merge). The Fix #2 reversal teaches the class-dispatch sensitivity.
2. **The dominant bucket needs structural codegen work**, not a quick fix. Worth an architect spec before dispatching.
3. **A safer scope** for an incremental PR: the `rest-elem-with-elision` failures (CompileError tests in `function/dstr/ary-ptrn-elem-ary-elision-init.js` and `dflt-ary-ptrn-elem-ary-elision-init.js`) — those are clean codegen bugs in `destructureParamArray`'s rest handling, independent of the var-pre-pass / `{}` interaction. ~4 tests but no Symbol.iterator entanglement.
4. **PR #59 retrospective is mandatory reading** (`plan/issues/sprints/45/1016.md`).

## Workflow notes from this session

- **CI status feed timing**: After pushing, the `pr-<N>.json` file appears via the `CI Status Feed` workflow which is triggered by `Test262 Sharded` completion. Total wall time from push to file present: ~5–10 min (sharded tests run in parallel, then merge step, then status-feed workflow).
- **LFS budget exhausted on origin** — `git merge origin/main` requires `GIT_LFS_SKIP_SMUDGE=1` to avoid blocking on `benchmarks/results/test262-current.jsonl`. The `refresh-benchmarks` CI job FAILS for the same reason on every PR — known infrastructure issue, ignore it for merge gating.
- **`gh pr merge --admin --merge`** works for self-merge. Verify mergedAt timestamp via `gh pr view N --json state,mergedAt,mergeCommit`.
