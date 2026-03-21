---
name: feedback_test262_worktree
description: Run test262 in a worktree, not on main working copy — avoids stash conflicts with cherry-picks
type: feedback
---

Run test262 suite in a dedicated worktree, not the main working copy.

**Why:** When test262 runs on main wc, cherry-picks from agents conflict with unstaged test runner changes (pool config, skip filters, error reporting). This caused repeated loss of pool integration, hanging test skips, and source map improvements.

**How to apply:** Use `scripts/run-test262-vitest.sh` which creates a worktree, or manually: `git worktree add /tmp/ts2wasm-test262 HEAD` then run vitest there. Keep main wc clean for cherry-picks only.
