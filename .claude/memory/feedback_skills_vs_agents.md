---
name: Skills vs dedicated agents — when to use which
description: Prefer skills for short tasks, spawn agents for sustained/concurrent work. Skills save RAM by avoiding idle agents.
type: feedback
---

**Skills** (`.claude/skills/*.md`): on-demand protocols any agent reads and follows. No new process, no RAM cost.
**Agents**: dedicated teammates with their own context and memory. ~800MB-1.5GB each.

Use **skills** when:
- Task is short (< 5 min)
- Only one agent needs the capability
- RAM is tight
- Examples: test-and-merge, smoke-test-issue, create-issue

Use **dedicated agents** when:
- Multiple tasks need the role concurrently (3 devs)
- Sustained back-and-forth with user (PO planning, SM retro)
- The role accumulates context hard to capture in a file
- Examples: devs during sprint, PO during planning session

**Lifecycle**:
- Planning agents (PO, architect, SM): write context summary → terminate after planning, unless user is talking to them
- Devs: keep alive between tasks (claim next from TaskList). Terminate at sprint end.
- Tester: prefer `/test-and-merge` skill on devs. Only spawn if multiple merges are queued and you want parallel test runs.

**Why:** Sprint-30 had 6 agents (4 dev + PO + SM) eating 7GB RAM, leaving no room for test262. Skills let 2 devs do the work of 6 agents.
