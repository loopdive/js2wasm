# Pre-Completion Checklist

**You MUST read this file and confirm each step before signaling task completion.**

## Before signaling completion

1. [ ] All work is committed to your branch (no uncommitted changes)
2. [ ] `git merge main` — merge main INTO your branch (not rebase)
   - If conflicts: resolve them, `git add`, `git commit`
   - If merge goes wrong: `git merge --abort` (your commits are safe)
   - **Never rebase** — rebase rewrites SHAs and causes branch name churn

## Post-integration local checks

Local validation happens AFTER merging main into your branch, but **full test262 runs happen in CI on the PR**, not in your worktree.

3. [ ] Run issue-targeted local checks
   - Compile+run the specific sample tests from the issue description
   - Run any narrow local tests needed for confidence
   - Do **not** run local full `test262` as part of completion
4. [ ] Record local test results in the issue file

## Finalize

5. [ ] Issue file updated with implementation notes
6. [ ] Issue status set to `review` in frontmatter
7. [ ] File locks removed from `plan/method/file-locks.md`
8. [ ] Branch pushed to `origin`
9. [ ] PR opened against `main`
10. [ ] PR is the canonical place for full validation — wait for GitHub Actions `test262` results there

## Wait for CI and self-merge

11. [ ] Monitor `.claude/ci-status/pr-<N>.json` until it appears with SHA matching your branch HEAD (poll every 60s)
12. [ ] Read result: `net_per_test`, `regressions`, `improvements`
    - `net_per_test > 0`, ratio <10%, no bucket >50 → `gh pr merge <N> --admin --merge`
    - regressions: fix on branch, push, loop back to step 11
    - escalate to tech lead only if: regressions >10, bucket >50, or judgment call
13. [ ] After merge: mark task `completed` in TaskList, claim next task

## What NOT to do

- Do NOT open a PR before merging `origin/main` into your branch
- Do NOT move on to the next task while waiting for CI — wait, then self-merge
- Do NOT use `git rebase` — use `git merge origin/main` instead
- Do NOT resolve compiler source conflicts (`src/`) inline — create a `[CONFLICT]` priority task for a senior-developer (Opus)
- Do NOT leave uncommitted changes on your branch
- Do NOT treat local full `test262` as part of the normal developer workflow — use the PR workflow instead
