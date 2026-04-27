# Senior Developer — Issue #1177 (TDZ propagation through closure captures)

**Status:** ✅ DONE — PR #53 merged 2026-04-27 03:25 UTC

## Final result

- **PR**: https://github.com/loopdive/js2wasm/pull/53 (MERGED)
- **Final commit**: `9ea4c82b6`
- **Net test262 delta**: **+30 pass** (26994 → 27024)
- **Canonical TDZ-throw cluster**: 100% fixed (3 newly passing + 4 stable)
- **Equivalence tests**: unchanged (32/138 files, 105/1190 tests)

Tech-lead confirmed remaining non-timeout regressions (other:15, promise:9, type:2) were **baseline drift** — identical pattern across two unrelated simultaneous PRs.

## Commits merged (6 total on top of origin/main)

1. `cd2c1ab70` — Original implementation (Stages 1, 2, 3 + 5 non-spec fixes)
2. `a0d6ab4e6` — Revert Stage 1 + Stage 3 C.2 (over-aggressive)
3. `4bbcf9ea0` — Fix `funcIdx` after late-import shift in calls.ts
4. `f6c5f35ea` — Route boxed-cap let-init through struct.set for no-init case
5. `9ea4c82b6` — `closureProvablyAfterLetDecl` helper to skip force-box when no TDZ risk
6. (3 merge commits from origin/main)

## Files changed

- `src/codegen/expressions/calls.ts` — TDZ check above mutable/non-mutable + funcIdx re-fetch
- `src/codegen/closures.ts` — Stage 3 C.1 + closureProvablyAfterLetDecl + boxed-flag accessor read
- `src/codegen/context/types.ts` — added `boxedTdzFlags` field
- `src/codegen/statements/tdz.ts` — `emitLocalTdzInit` routes through boxed flag
- `src/codegen/expressions/identifiers.ts` — `emitLocalTdzCheck` routes through boxed flag
- `src/codegen/statements/variables.ts` — let-init routes through `struct.set` for boxed locals (with-init + no-init branches)
- `src/codegen/statements/shared.ts` — `saveBlockScopedShadows` recognizes `using`/`await using`
- `src/codegen/index.ts` — `walkStmtForLetConst` + `walkStmtForVars` recognize `using`/`await using`
- `tests/issue-1177.test.ts` — 7 new tests

## Cleanup

- Worktree at `/workspace/.claude/worktrees/issue-1177` can be removed
- `.tmp/` files cleaned up
- Status file in `plan/issues/ready/1177.md` should be moved to `plan/issues/done/`
