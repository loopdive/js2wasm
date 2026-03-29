# Pre-Completion Checklist

**You MUST read this file and confirm each step before signaling task completion.**

## Before signaling completion

1. [ ] All work is committed to your branch (no uncommitted changes)
2. [ ] `git rebase main` — rebase your branch onto current main
   - If conflicts: resolve them, `git add`, `git rebase --continue`
   - If rebase goes wrong: `git rebase --abort` (your commits are safe), retry or ask for help
3. [ ] Re-run your scoped tests AFTER rebase (not before — rebase can introduce semantic conflicts)
4. [ ] Tests pass after rebase
5. [ ] Issue file updated with implementation notes
6. [ ] Issue status set to `review` in frontmatter
7. [ ] File locks removed from `plan/file-locks.md`

## Signal completion

Message tech lead: `"Completed #N (commit <hash>). Branch is rebased onto main, ready for ff-only merge."`

## What NOT to do

- Do NOT signal completion before rebasing
- Do NOT ask tech lead to resolve conflicts — you own them
- Do NOT leave uncommitted changes on your branch
