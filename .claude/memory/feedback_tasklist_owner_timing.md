---
name: Set task owner when claiming, not when completing
description: Always set owner on TaskUpdate when claiming a task (status→in_progress), never when completing
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Any `owner` change on TaskUpdate triggers a task_assignment notification routed to the new owner. When team-lead is the owner, this creates a self-echo in the conversation.

**Why:** The system sends a task_assignment notification on every owner change — including when claiming (in_progress), not just when completing.

**How to apply:**
- **Agents** (dev-906, senior-dev, etc.): set `owner` to their name when claiming (`status: "in_progress"`). Never set `owner` when completing.
- **Team-lead handling a task directly**: do NOT set `owner` at all. Just update `status` (in_progress, then completed). Leaving owner blank avoids the self-echo entirely.
