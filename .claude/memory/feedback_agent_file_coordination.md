---
name: feedback_agent_file_coordination
description: Agents working in parallel must coordinate on shared files — check file overlap before launching
type: feedback
---

When launching parallel dev agents, verify they don't modify the same files. If they do, either:
1. Serialize them (run sequentially)
2. Have them work on different functions within the same file (Git 3-way merge handles separate hunks)
3. Send messages between agents to coordinate

**Why:** Parallel agents in worktrees can't see each other's changes. Conflicts appear at cherry-pick time and require manual resolution.

**How to apply:** Before launching parallel agents, list the files each will likely modify. If overlap exists, stagger the launches or scope the work more narrowly.
