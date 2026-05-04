---
name: feedback_dev_silence_protocol
description: Devs must be silent during CI-wait and idle — no idle_notification messages to tech lead
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Devs must not send `idle_notification` messages or any status chatter to the tech lead. They are silent until they have a blocker, a decision needed, or a completed merge.

**Why:** The tech lead's job is to keep the task queue full and step in on escalations. Idle pings are noise that interrupt the user. The TaskList is the communication channel for task state — not SendMessage.

**Tech lead behavior:** Do not respond to or acknowledge idle_notifications. Only respond if the message contains a genuine question or escalation. Do not write "Ignoring." — just don't reply.

**Exceptions (three valid reasons to message):**
1. Claiming a task: `"Claiming #N — <title>. Queue: X tasks still pending."` (X excludes the claimed task)
2. After merge, TaskList empty: `"#N merged. TaskList empty — need next task."`
3. Cannot proceed: blocked >30 min, CI failing with unresolvable regressions, or any situation where forward progress is impossible without a decision.

**How to apply:** If a dev sends idle_notification messages mid-task or during CI-wait, remind them once, then update `.claude/agents/developer.md` to reinforce the rule. During CI-wait, devs block on Monitor (zero token burn) and wake only when CI_READY — they do not ping the tech lead.
