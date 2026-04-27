---
name: Don't shut down idle agents
description: Idle agents between tasks should NOT be shut down — they wait for CI, self-merge, then claim next task
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Do NOT send shutdown requests to agents that are idle or sending idle_notification pings.

**Why:** An idle agent is between tasks in the normal sprint loop: waiting for CI to finish on their PR, self-merging when green, then claiming the next task from TaskList. Shutting them down breaks that loop and wastes their accumulated context.

**How to apply:** When an agent sends an idle_notification, respond — ask if they have a PR waiting on CI (check it and self-merge if green) or direct them to claim the next task from TaskList. Never shut them down just because they're idle. Only shut down agents when: (1) the user explicitly requests it, (2) end-of-sprint wind-down, or (3) the agent signals it has no more tasks and the sprint is over.
