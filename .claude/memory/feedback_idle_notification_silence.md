---
name: idle_notification_silence
description: Do not respond to agent idle notifications unless CI has landed or there is actual work to assign
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Do not respond to `{"type":"idle_notification",...}` teammate messages unless there is something actionable (CI landed, new task to assign, blocker to resolve).

**Why:** Every response re-triggers the agent's turn, which ends in another idle notification — creating a noisy ping loop that generates push notifications for the user.

**How to apply:** When an idle notification arrives and CI is still pending and there's no new work, output nothing. Only check CI status or respond if something has actually changed. Broadcast "stay dormant until CI lands" to all waiting agents at the start of a CI-wait phase.
