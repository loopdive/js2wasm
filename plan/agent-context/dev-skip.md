# dev-skip — context summary at shutdown

**Date**: 2026-04-21 03:05 UTC
**Shutdown reason**: Context window saturation after long session.

## Sessions summary

Worked through issues #1152, #1155, #1156 in sequence. All PRs merged to main except #1156 (PR #250) which is awaiting CI.

### #1152 — Array.prototype higher-order methods on array-like receivers (MERGED)
- PR #247 → commit d4b539f2 (2026-04-21 02:43 UTC)
- Fix: narrow bailout in `compileArrayLikePrototypeCall` to `__vec_*`/`__arr_*` only; add `__is_truthy` late import; NaN-safe f64 truthy conversion.

### #1155 — test262-worker exception classification (MERGED)
- PR #248 → commit 9de58651 (2026-04-21 02:51 UTC)
- Fix: distinguish `WebAssembly.CompileError`/`LinkError` (real compile failures) from `WebAssembly.Exception`/generic Error (runtime throws) in `scripts/test262-worker.mjs` and `scripts/wasm-exec-worker.mjs`. Added `extractWasmExceptionMessage`/`extractWasmExceptionInfo` helpers that inspect `__exn_tag`/`__tag` for payloads.
- Team-lead approved self-merge at 10.3% reg/imp (runner-only, no codegen impact).

### #1156 — void-callback validation error in reduce/reduceRight/map (PR #250 PENDING CI)
- PR URL: https://github.com/loopdive/js2wasm/pull/250
- Branch: `issue-1156-arr-proto-numeric-init`, HEAD SHA **93dd3488**
- Worktree: `/workspace/.claude/worktrees/issue-1156-arr-proto-numeric-init`

**Root cause (post-#1152)**: `compileArrayLikePrototypeCall` in `src/codegen/array-methods.ts` for `reduce`, `reduceRight`, and `map` built a `*ResultToExternref` coercion block with a fall-through `[]` branch that handled `returnType.kind === "externref"` AND `returnType === null` (void) the same way. The externref case is fine (`call_ref` leaves a value); the void case is invalid Wasm (`call_ref` leaves nothing, `local.set accTmp/mappedTmp` needs 1 value → "not enough arguments on the stack for local.set (need 1, got 0)").

**Fix**: split the cases. Push `ref.null.extern` for void callbacks; keep empty fall-through for externref. Applied to reduce (lines ~912-919), reduceRight (lines ~997-1005), and map (lines ~794-801) in `src/codegen/array-methods.ts`.

**Validation**:
- `tests/issue-1156.test.ts` — 3/3 pass (reduce, reduceRight, map with void callbacks on array-likes)
- 3 sample test262 tests from issue PASS (15.4.4.21-9-b-10.js, 15.4.4.21-9-c-ii-29.js, 15.4.4.22-3-1.js); 15.4.4.21-9-b-25.js still fails on prototype-walk assertion (unrelated)
- Sampled 40/164 baseline targets: 9 recover to PASS, 0 validation errors; 31 remaining failures are ArrayBuffer/BigInt/DataView/Function/Iterator — separate clusters misclassified into the same "number 1 is not a function" baseline bucket
- Equivalence suite: 2 pre-existing failures (pop, shift) unchanged

## Next agent — what to do

1. Monitor `.claude/ci-status/pr-250.json` — wait for SHA to match HEAD `93dd3488`.
2. Self-merge criteria:
   - `net_per_test > 0` (or `== 0` with no cluster >50)
   - `reg/imp < 10%`
   - no single error-bucket > 50
3. Clean → `gh pr merge 250 --admin --merge`.
4. Regressions >10 or bucket >50 → escalate to team-lead.
5. Post-merge: issue file already at `plan/issues/ready/1156.md` (status: in-progress, test results added). Team-lead handles move to done/.
6. Claim next task from TaskList. Task #8 (#1157 RegExp flags='undefinedy') is in_progress and unowned — probably next.

## Useful paths

- Worktree: `/workspace/.claude/worktrees/issue-1156-arr-proto-numeric-init`
- Fix commit: 19a893a5 (on branch `issue-1156-arr-proto-numeric-init`)
- Merge commit: (merged origin/main on top, HEAD 93dd3488)
- Probe scripts (gitignored): `.tmp/probe-1156-broader.ts`, `.tmp/probe-1156-sample.ts`
- CI status path: `.claude/ci-status/pr-250.json`

## Known caveats

- The issue title says "~164 regressions" but post-#1152, only ~9-40 of those actually belong to this bug. The baseline "number 1 is not a function" error bucket was a catch-all that covered ArrayBuffer/BigInt/DataView/Function/Iterator regressions too. Net test262 delta from this PR is expected to be moderate (~10-40), not 164.
- Baseline file used: `public/benchmarks/results/test262-results.jsonl` (timestamp 2026-04-20T20:44, sha pre-#1152).
