---
name: feedback_team_setup_with_tester
description: Use team with centralized tester agent to prevent OOM from parallel test runs
type: feedback
---

When dispatching multiple developer agents, always include a dedicated tester agent that serializes test runs.

**Setup:**
1. TeamCreate with team name matching the goal (e.g. "compilable")
2. Spawn developer agents with `isolation: "worktree"`, each assigned to non-conflicting files
3. Spawn ONE tester agent (subagent_type: "tester") — no worktree isolation needed
4. Developers do NOT run tests — they commit and message tester when ready
5. Tester runs equivalence tests on each worktree ONE AT A TIME
6. Tester reports results back to developer and team lead

**Why:** 3 agents running vitest simultaneously uses ~8GB and causes OOM kills at 15GB total. Centralizing tests in one agent keeps memory under control.

**How to apply:**
- In developer prompts: "Do NOT run vitest or npm test — message tester when ready"
- In tester prompt: "Only run ONE test suite at a time, never parallel"
- Team lead merges via `cd /workspace && git merge <agent-branch> --no-ff`
- Wave size: max 3 developers + 1 tester = 4 agents
