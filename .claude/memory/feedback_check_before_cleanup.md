---
name: feedback_check_before_cleanup
description: Always check worktrees for uncommitted useful changes before cleaning them up
type: feedback
---

Always check worktree diffs for useful uncommitted changes BEFORE removing them.

**Why:** Agent worktrees can contain uncommitted improvements (test runner setup, skip filters, error reporting) that aren't in any commit. Deleting without checking loses work — happened when agent-abf03722 had the full test runner with pool/source maps/line numbers that took hours to build.

**How to apply:** Before `git worktree remove`, run `git -C <worktree> diff --stat` and ask the user if anything looks worth keeping. Never bulk-delete worktrees without inspection.
