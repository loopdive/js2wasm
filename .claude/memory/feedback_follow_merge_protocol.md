---
name: feedback_follow_merge_protocol
description: CRITICAL — follow the documented merge protocol exactly, don't shortcut by merging as tech lead
type: feedback
---

**Never merge branches yourself as tech lead.** Follow the CLAUDE.md merge protocol:

1. Dev signals "branch ready for test"
2. Tech lead spawns a **short-lived tester agent** (isolation: worktree) that runs equiv tests + test262 on the integrated branch
3. Tester creates merge proof and ff-only merges if pass count is stable
4. One tester at a time

**Why:** The tech lead was manually creating merge proofs and running quick equiv checks instead of spawning testers. This skips full test262 verification, which is how sprint 31 originally regressed (4 merges stacked without test262). The merge protocol exists because of that failure.

**How to apply:**
- When a dev says "branch ready", spawn: `Agent(subagent_type: "tester", isolation: "worktree", team_name: current_team)`
- Give the tester the branch name, commit hash, and worktree path
- The tester runs **BOTH equiv tests AND test262** (`pnpm run test:262`) on the integrated branch
- Tester creates merge proof with test262 pass count, does ff-only merge
- Tech lead does NOT touch merge-proof.json or run `git merge` directly
- **NEVER skip test262 in tester prompts** — equiv-only is how sprint 31 regressed
- Only exception: docs-only changes with zero compiler changes (README, ROADMAP, sprint files)
