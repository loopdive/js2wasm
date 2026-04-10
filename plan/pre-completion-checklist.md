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
7. [ ] File locks removed from `plan/file-locks.md`
8. [ ] Branch pushed to `origin`
9. [ ] PR opened against `main`
10. [ ] PR is the canonical place for full validation — wait for GitHub Actions `test262` results there

## Signal completion

11. [ ] Final integration check: `git merge main` — no-op if nothing changed, catches main moving before push
12. [ ] Message tech lead: `"Completed #N (commit <hash>). PR: <url>. Scoped local checks pass; waiting on CI."`

## What NOT to do

- Do NOT signal completion before merging main into your branch
- Do NOT use `git rebase` — use `git merge main` instead
- Do NOT ask tech lead/tester to resolve conflicts — you own them
- Do NOT leave uncommitted changes on your branch
- Do NOT treat local full `test262` as part of the normal developer workflow — use the PR workflow instead
