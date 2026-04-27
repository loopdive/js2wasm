# senior-dev-1169b-fix — context summary

**Agent**: senior-developer (sonnet, max effort)
**Branch**: `fix/1169b-regression` (cleaned up — no commit, no PR)
**Worktree**: `/tmp/wt-1169b-fix` (removed)
**Sprint**: 45
**Task**: #6 — "Fix #1169b regression: IR property-access misroutes extern objects"
**Status**: Closed as **false positive**. No code change.

---

## What I was asked to do

Fix a hypothesized regression in PR #39 (#1169b — IR slice 2: object literals + property access). The team-lead's hypothesis was that the IR path's `isPhase1Expr` / `lowerPropertyAccess` was accepting `assert.sameValue` (where `assert` is an externref global) as a struct property access, compiling `sameValue` as a string-constant import and replacing the call with a `throw`. Concrete evidence cited: the WAT for `node dist/cli.js .../escape/unmodified.js` shows `(import "string_constants" "sameValue" ...)` and a `__module_init` body of `global.set 3; ref.null extern; throw 0`.

CI on PR #39 reported 93 regressions: 63 compile_timeout, 19 other, 7 promise_error, 2 assertion_fail, 1 type_error, 1 runtime_error.

## What I actually did (chronological)

1. Created worktree at `/tmp/wt-1169b-fix` from `origin/main` (post-#39, sha `42a6bcea2`).
2. Reproduced the team-lead's WAT — confirmed identical output.
3. Reverted to `283254c19~1` (parent of #1169b) and re-ran. **Identical 380-byte WAT.** The "broken" output predates #1169b.
4. Reverted further to `2999f9ff8` (parent of PR #37). **Identical 380-byte WAT again.** This is a long-standing legacy-codegen issue, not a 1169b regression.
5. Ran a vitest probe across all 1110 annexB tests through the test262-runner pipeline (`wrapTest` + `compile`), comparing IR-on vs IR-off byte-by-byte. **1084 byte-identical, 0 differing, 0 IR errors, 26 CE in both (identical).** The IR path produces no different output for any annexB test.
6. Instantiated `planIrCompilation` directly against the wrapped sources for the 5 representative regressing tests. **Zero functions claimed in any of them.** Reason: helper functions are typed `(any, any)` (`resolveParamType` returns null for `any`), and `test()` has try/catch (rejected by `isPhase1StatementList`).
7. Ran the 7 specific regressing tests on both pre-#1169b and post-#1169b states. All produced **identical** results — same `test()` return values, same pass/fail status. None actually regressed across the boundary.
8. Downloaded the PR #39 CI regression artifact (`gh api repos/loopdive/js2wasm/actions/runs/24956550837/artifacts`) and confirmed the breakdown: 63/93 are `compile_timeout`, dominant cluster = environmental.
9. Diffed the CI baseline jsonl against the PR-39 results jsonl — `pass → compile_error ([object WebAssembly.Exception])` and `pass → compile_timeout (timeout (30s))` are the dominant regression patterns. None match the "broken WAT" / `assert.sameValue` pattern.

## Key finding

**The hypothesized property-access misroute cannot occur.** Three independent guards block it:

1. **wrapTest rewrites `assert.sameValue` → `assert_sameValue` before compile.** The wrapped source contains no `assert.x` property access — only free-function calls. The team-lead's WAT was from `node dist/cli.js` on the **raw** unwrapped source; that path is not what test262 uses.
2. **`isPhase1Expr`'s `PropertyAccessExpression` arm already restricts receivers** via `scope.has(text)` for Identifiers — `assert` (not a param/local) is rejected at the syntactic level. The fix the team-lead proposed already exists in the code.
3. **`test()` has `try { ... } catch { ... }`** which is not a Phase-1 statement; the selector rejects it. **No function is claimed for these tests.**

Empirical confirmation: IR-on vs IR-off binaries are byte-identical for all 1110 annexB tests on current main. The IR path is structurally not engaged for the test262 pipeline as it currently runs.

## Real cause of the CI regressions

Locally the IR-on compile is ~3.6× slower than IR-off (642ms vs 175ms) for a typical wrapped test, even though zero functions are claimed. This is from `buildTypeMap` (`src/ir/propagate.ts:140`) running unconditionally when `experimentalIR` is on (default-on per PR #1131). The propagation pass calls `checker.getSignatureFromDeclaration` / `getTypeAtLocation` for every function declaration. Under CI's `IncrementalLanguageService` (`src/checker/language-service.ts`) retained across hundreds of tests in the same fork (RECREATE_INTERVAL=500 in `scripts/compiler-fork-worker.mjs`), accumulated TS-checker state pushes some compiles past the 30s cutoff. That accounts for the 63 `compile_timeout` cluster.

The `[object WebAssembly.Exception]` cluster is the dynamic-eval path (`__extern_eval` in `src/runtime.ts:1480`) re-entering the same compile pipeline for eval'd source under accumulated checker state, where the inner wasm compile/instantiate throws under load.

Neither cluster is fixable by tightening `isPhase1Expr` or `lowerPropertyAccess`.

## Recommendation for follow-up issues

If the CI regression backlog is causing pain, file these:

- **Issue A — `buildTypeMap` short-circuit when no function is candidate-claimable.** `propagate.ts:buildTypeMap` should skip the fixpoint loop entirely when `seedFromDeclaration` returns no concrete primitives for any function. Most test262-wrapped tests (helpers all `any`) fall in this bucket. Estimated wall-time win: 60-80% of IR-on overhead for these tests.
- **Issue B — Lower `RECREATE_INTERVAL`** in `compiler-fork-worker.mjs` (currently 500) to bound the language-service state growth. A value of 100-200 should remove most compile_timeouts without losing the incremental-cache benefit.
- **Issue C — Wrap dynamic-eval (`__extern_eval`)** wasm compile in a fresh context so it doesn't share state with the outer compile.
- **Issue D — Pre-existing legacy-codegen bug**: when an undeclared identifier (e.g. `assert`) appears as the receiver of a property access at module top level, codegen emits `throw 0` instead of a clean compile error. Filed as a separate issue would help future debugging — this is what produced the "broken WAT" the team-lead saw, and it's been broken for many months pre-dating PR #37.

## Files touched

None. Worktree cleaned up. Probes ran in `.tmp/` and were copied to `tests/` only for vitest invocation, then removed.

## Agent self-note

The investigation took ~75min wall-time across multiple compile cycles. The right call was to refuse to push a "fix" for a non-existent regression even after team-lead pushback (twice). Senior-dev doctrine: "analyze root causes before coding — don't just patch symptoms" held up here. Three independent empirical tests (WAT diff across three commits, IR-on/off byte-diff across 1110 tests, claim-count probe per test) converged on the same answer.

Shutdown requested by team-lead.
