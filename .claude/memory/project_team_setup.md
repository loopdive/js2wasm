---
name: Team Setup
description: All agents spawn as teammates (not subagents) for inter-agent messaging. Details in plan/team-setup.md.
type: project
---

All agents (PO, tester, developers) run as **teammates** in a single team via `TeamCreate`. This enables `SendMessage` between devs for file conflict coordination, dev→tester for test requests, and tester→tech lead for cherry-pick readiness.

Full config, memory budget, communication protocol, and workflow: `plan/team-setup.md`
Agent definitions: `.claude/agents/{product-owner,developer,tester}.md`

Key structural decisions:
- Devs broadcast file/function claims on start
- Tester serializes all test runs (one at a time)
- PO only touches `plan/` directory
- Tech lead is the orchestrator, cherry-picks to main
