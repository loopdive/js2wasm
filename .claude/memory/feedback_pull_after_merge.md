---
name: Always pull after merging PRs
description: After merging PRs via gh pr merge, immediately git pull to sync the working copy
type: feedback
---

Always `git pull` after merging PRs via `gh pr merge` — the local working copy falls behind origin and shows stale data (e.g. old test262 report showing 0% pass).

**Why:** Merged PRs trigger CI promote steps that commit new data to main. Without pulling, the local dev server serves stale files.

**How to apply:** After every `gh pr merge`, run `git pull origin main` (or `git pull --rebase origin main`) before doing anything else on main.
