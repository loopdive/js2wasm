# Pre-Merge Checklist (Tech Lead)

**Read this before every merge to main.**

## Before merging

1. [ ] Run `pwd && git branch --show-current` — must be `/workspace` on `main`
2. [ ] Verify agent branch is rebased: `git log --oneline main..<branch> | head -5` — commits should be on top of current main
3. [ ] Merge with `git merge --ff-only <branch>`
   - If ff-only fails: do NOT use `--no-ff` or cherry-pick. Tell the agent to rebase.
4. [ ] **Never** run `git checkout HEAD -- <file>` to restore files after a merge — this is how fixes get silently reverted

## After merging

5. [ ] Run `git diff HEAD~1 --stat` — verify no unexpected deletions or reversions
6. [ ] Check that no `tests/issue-*.test.ts` files were deleted
7. [ ] Check that shared files (runtime.ts, expressions.ts) don't have reverted changes
8. [ ] Run equivalence tests: `npm test -- tests/equivalence.test.ts`
9. [ ] Broadcast to agents: `"Main updated with #N, rebase before next commit"`

## If something went wrong

- `git reset --hard HEAD~1` to undo the merge (only if not yet pushed)
- Tell the agent to fix their branch and re-signal
- **Never** manually patch files on main to fix a bad merge
