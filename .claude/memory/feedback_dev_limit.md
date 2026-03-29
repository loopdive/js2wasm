---
name: Developer agent limits and team setup
description: Max 4 devs as teammates (not subagents). Always use TeamCreate + SendMessage for coordination.
type: feedback
---

## Key rules

- **Max 4 dev agents** — each ~2GB RSS, need headroom for test runs
- **Always spawn as teammates** (TeamCreate + Agent with team_name), NOT bare subagents
  - Teammates can coordinate test runs (only 1 runs equiv tests at a time)
  - Teammates can message each other about file conflicts
  - Team lead merges work, not agents
- Each dev writes tests to `tests/issue-{N}.test.ts`, NOT `equivalence.test.ts`
- Diagnostic-only issues — batch in one commit, no dev agent needed
- Devs update their own issue file but NOT `plan/backlog.md`
- Merge worktree branches to main (not cherry-pick)
- PO agents: spawn on demand for analysis, no worktree needed

**Why:** Subagents can't coordinate, causing OOM from concurrent test runs and duplicate work. Teammates solve this via messaging.
