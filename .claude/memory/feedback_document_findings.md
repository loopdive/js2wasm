---
name: Document agent findings in issue files
description: Always write agent analysis/findings back to the issue file before moving to done/backlog
type: feedback
---

When an agent completes (success or failure), always document its root cause analysis, implementation plan, and findings in the issue file before moving it to done/ or backlog/.

**Why:** Agent #153 produced a detailed root cause analysis but the issue was moved to backlog without documenting it. This wastes the investigation work and forces future agents to re-discover the same findings.

**How to apply:** After every agent completion, read the agent's result summary and write key findings (root cause, fix plan, what worked/didn't) into the issue markdown file before changing its state.
