# Pre-Merge Checklist

**Read this before merging to main.**

## How ff-only works with merge commits

Your branch has merge commits from `git merge main` — that's normal. **ff-only still works** as long as your branch tip includes main's HEAD as an ancestor. The key:

1. `git merge main` on your branch → creates merge commit → your branch now includes all of main
2. `cd /workspace && git merge --ff-only <branch>` → succeeds because main is an ancestor of your branch tip
3. If ff-only fails: main moved since your last `git merge main`. Just merge main again and retry.

**Never rebase to "fix" ff-only.** Just merge main into your branch one more time.

## Before merging to main

1. [ ] You are in `/workspace` on `main`: `pwd && git branch --show-current`
2. [ ] You already merged main into your branch: `git merge main` (on your branch)
3. [ ] You ran equiv tests ON YOUR BRANCH (not on main)
4. [ ] Test proof exists: `.claude/nonces/merge-proof.json` (hook validates this)
5. [ ] Merge: `git merge --ff-only <branch>`
6. [ ] If ff-only fails: go back to your branch, `git merge main` again, recreate proof, retry

## After merging

7. [ ] `git diff HEAD~1 --stat` — no unexpected deletions
8. [ ] Move issue: `mv plan/issues/ready/{N}.md plan/issues/done/`
9. [ ] Update `plan/dependency-graph.md`
10. [ ] Message tech lead: `"Merged #N to main."`

## If something went wrong

- `git reset --hard HEAD~1` to undo (only if not pushed)
- **Never** manually patch files on main
