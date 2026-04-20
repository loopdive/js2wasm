# senior-dev — Context Summary

**Last session**: 2026-04-19
**Status at shutdown**: idle, awaiting next task

## Recent completed work

### Task #49 — PR #221 iter-val-err fix (COMPLETED)
- **Branch**: `issue-1135-dstr-iterable-fallback`
- **Worktree**: `/workspace/.claude/worktrees/issue-1135-dstr-iterable`
- **Commits pushed**:
  - `8dbef528` fix(dstr): use Array.from to propagate iter-val-err in buildVecFromExternref CHECKLIST-FOXTROT
  - `d3fce24d` chore(planning-artifacts): regen CHECKLIST-FOXTROT
- **Fix**: `buildVecFromExternref` in `src/codegen/type-coercion.ts` now normalizes the externref source via `__array_from` (Array.from) before extracting length + indexed values. This drives the iterator protocol (Symbol.iterator + next() + .value reads), so a throwing `.value` getter propagates as required by ES §8.5.3 step 5.e.
- **Why it was broken**: Previously `__extern_length` on a custom iterable returned NaN and the loop silently produced an empty vec, swallowing the spec-required throw. 19 test262 regressions in `ary-ptrn-rest-id-iter-val-err.js` variants.
- **Verification**: All 6 real test262 `ary-ptrn-rest-id-iter-val-err.js` variants pass via bundled compiler. All 6 local `tests/issue-1135.test.ts` tests pass.
- **CI**: Test262 Sharded was manually dispatched (push alone didn't trigger) — `gh workflow run test262-sharded.yml --ref issue-1135-dstr-iterable-fallback`. Queued on SHA d3fce24d.

### Task #45 — PR #216 generator.next fix (COMPLETED, prior session)
- Commit `351aa525` on branch `issue-dstr-default-unresolvable`.

### Task #48 — PR #225 remaining 12 regressions (COMPLETED)
- Marked completed during task #49 work (investigation phase).

## Key patterns learned this session

1. **Local vs CI compile discrepancy**: `tsx` direct runs of the source hit TS 2345 strict errors; CI bundled compiler + `skipSemanticDiagnostics: true` bypasses them. When debugging test262-style probes locally, always pass `{ skipSemanticDiagnostics: true }` to mirror CI, OR build via `scripts/compiler-bundle.mjs`.
2. **`iter[Symbol.iterator] = fn` is silently dropped** when `iter` is declared as `var iter = {}` — separate compiler limitation, unrelated to rest-destructure. For synthetic iter-val-err tests, use a `class Iter { [Symbol.iterator]() { return this; } next() { throw ... } }` pattern instead.
3. **Push doesn't always trigger CI**: After pushing to an open PR branch, `gh run list` may show no new runs for the new SHA. Use `gh workflow run <workflow>.yml --ref <branch>` to manually dispatch.
4. **Baseline drift detection**: When a PR shows ~280 regressions, compare against other open PRs' regression paths — overlap (e.g., 261/280 identical paths in an unrelated PR) indicates baseline drift, not real regressions. The remaining 19 unique paths were the real issue.

## Task list status
- #48 completed
- #49 completed
- No pending assigned tasks

## Resume
Next session: check TaskList for new work. No in-flight files, no uncommitted changes in worktree beyond planning doc drift (`plan/goals/compilable.md`, `plan/goals/error-model.md`, `plan/issues/sprints/42/sprint.md`) which the tech lead manages.
