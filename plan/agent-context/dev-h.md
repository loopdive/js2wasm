# dev-h context — 2026-04-25

## Session summary

Worked one task under team-lead direction in sprint-45-ci.

### Task #14 / #1086 — Dedup + memoize bodyUsesArguments (merged)

Pure import-only refactor that completed the dedup pass started by
#1085's emergency rewrite.

**Starting state on origin/main**:
- Helper file `src/codegen/helpers/body-uses-arguments.ts` already existed
  (iterative DFS + module-level `WeakMap<ts.Node, boolean>` memo).
- `function-body.ts` already imported from the helper and re-exported via
  `export { bodyUsesArguments };`.
- `nested-declarations.ts` already imported from the helper (no duplicate).
- `statements.ts` re-export already pointed at the helper.
- The 3 remaining call sites (`class-bodies.ts`, `declarations.ts`,
  `literals.ts`) still imported via `function-body.ts`'s re-export.
- `tests/issue-1085.test.ts` imported from `function-body.ts` directly.

**Changes (5 lines, all single-line edits)**:
1. `src/codegen/class-bodies.ts:20` — import path → helper
2. `src/codegen/declarations.ts:25` — split named imports, route
   `bodyUsesArguments` to helper, keep `compileFunctionBody` /
   `registerInlinableFunction` from `function-body.ts`
3. `src/codegen/literals.ts:26` — import path → helper
4. `src/codegen/function-body.ts` — removed unused `export { bodyUsesArguments };`
5. `tests/issue-1085.test.ts` — import path → helper (caught after first push;
   was a dangling import from the old re-export site)

**Branch**: `issue-1086-body-uses-arguments-dedup`
**Final HEAD**: `73ead9b7843e01a8ecef5a1c6a1d9d15d972b834`
**PR**: https://github.com/loopdive/js2wasm/pull/26 (merged by team-lead)

### CI noise diagnostic — useful precedent for future refactors

PR #26's first CI run reported `pass=25,352`, `compile_error=2,568`,
`snapshot_delta=-63`. Team-lead initially flagged this as a regression.
Investigation showed it was **stale-baseline drift**:

1. Cross-PR signature: PR #27 (unrelated, dynamic-eval) showed the same
   negative-delta + elevated-CE pattern. Two unrelated PRs both regressing
   against the same baseline = baseline staleness.
2. Local equivalence-test cross-check on the same SHA: branch and origin/main
   both produced **identical** failures (105 failed | 1186 passed, same
   files, same cases). Refactor had zero behavioral surface.
3. Refactor was genuinely import-only. The WeakMap cache was already in
   place pre-refactor (helper file pre-existed); ESM resolves
   `export { x } from "./y"` and `import { x } from "./y"` to the same
   module instance and same binding — no semantic delta.
4. Baseline was refreshed (`7be9e506a`) AFTER my CI ran. Re-ran CI on
   fresh baseline: net **+24 pass**, with high symmetric churn (322
   regressions + 346 improvements + 532 fail-mode→fail-mode transitions
   = ~1,500 tests flipped on a 5-line import refactor). That symmetric
   flip pattern is test262 timing-flake (compile_timeout, promise_error,
   "other" catch-all), not a real regression cluster.

**Lesson**: For pure-refactor PRs, equiv-test cross-check on origin/main
HEAD is faster and more reliable evidence than waiting on test262 CI.
Cross-PR drift signature (multiple unrelated PRs all showing the same
direction of drift) is a strong tell.

This is what `feedback_baseline_drift_cross_check.md` already calls out
— this session is a clean instance of that protocol working.

## Notes for future agents

- The `bodyUsesArguments` helper at `src/codegen/helpers/body-uses-arguments.ts`
  is the canonical location now. All 6 call sites + the `statements.ts`
  re-export reach it directly. Module-level WeakMap memo, iterative DFS.
- The helper imports ONLY from `typescript` — safe to import from any
  codegen module without circular-import risk.
- LFS budget exhaustion is currently affecting merges:
  `public/benchmarks/results/test262-editions.json` and
  `public/benchmarks/results/test262-report.json` smudge-fail.
  Workaround: `GIT_LFS_SKIP_SMUDGE=1 git merge ...`.

## Status

- Worktree: `/workspace/.claude/worktrees/issue-1086` (can be removed by
  team-lead during cleanup)
- Branch: merged, can be deleted
- Task #14: completed (PR #26 merged)
- No remaining work.
