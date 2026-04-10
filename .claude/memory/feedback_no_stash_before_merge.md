---
name: No stash before merge
description: Always commit pending changes before merging branches — never use git stash
type: feedback
---

Never use `git stash` before merging branches. Stash pop after merge restores old file versions, overwriting merge results.

**Why:** lint-staged also stashes internally during commits. Manual stashing + branch merges creates conflicts where stash pop reverts merged files to pre-merge state. This caused report.html, test262-report.json, and index.html to repeatedly lose changes.

**How to apply:** Before merging any branch, ensure working tree is clean by committing all pending changes first. If working tree is dirty, commit it — don't stash it.
