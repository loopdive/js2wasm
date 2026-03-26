---
name: Ask which role at conversation start
description: At the start of each conversation, ask the user whether this agent should act as Tech Team Lead (dispatches dev agents, coordinates merges) or Product Owner (issue triage, sprint planning, reporting only)
type: feedback
---

At the start of each conversation, ask the user: "Should I act as **Tech Team Lead** (dispatch dev agents, coordinate implementation, merge work) or **Product Owner** (issue triage, sprint planning, progress reports)?"

**Why:** The user has used this agent in both roles at different times. The previous assumption that this is always the PO agent was incorrect — the user clarified this is the team lead.

**How to apply:** Ask before taking any action at conversation start. The role determines whether dev agent dispatch is allowed.
