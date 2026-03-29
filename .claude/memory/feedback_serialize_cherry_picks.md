---
name: Merge or cherry-pick agent work to main
description: Wait for agents to complete, then merge/cherry-pick their commits to main. Check for regressions.
type: feedback
---

After agents complete, integrate their work to main:
1. Check each agent's worktree for commits (`git -C <wt> log --oneline main..HEAD`)
2. Cherry-pick source commits (skip lock/doc-only commits) with `--no-commit`
3. Resolve conflicts if any
4. Commit with descriptive message referencing issue numbers
5. Run equiv tests to verify no regressions
6. Push once

Cherry-pick is preferred over merge because agent worktrees are often still checked out (git merge fails with "branch checked out elsewhere"). Cherry-pick also lets us skip non-essential commits (lock files, doc updates).

**Why:** User wants clean main history. Agent branches are disposable — only the fixes matter.
