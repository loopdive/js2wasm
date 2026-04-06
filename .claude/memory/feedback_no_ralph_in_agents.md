---
name: feedback_no_ralph_in_agents
description: Dev/tester agents must NEVER run Ralph loops — only the tech lead controls loops
type: feedback
---

Dev and tester agents must NEVER start Ralph loops (`/ralph-loop`). Only the tech lead (orchestrator) controls iteration loops.

**Why:** A dev agent ran a Ralph loop autonomously, making repeated changes without tech lead approval. The user had to manually kill it. Agents in Ralph loops can't be stopped via SendMessage — they keep iterating.

**How to apply:**
- Never include Ralph loop instructions in agent prompts
- If an agent seems to be iterating without signaling, check for `.claude/ralph-loop.local.md` in its worktree and kill it
- Ralph loops are only for the tech lead conversation, controlled by the user
