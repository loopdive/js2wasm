---
name: SendMessage discipline — blockers/decisions/completions only
description: When to use SendMessage vs TaskUpdate vs silence — reduce token noise from teammate chatter
type: feedback
originSessionId: d6baa9f4-70ab-431b-9892-e43ce86a622e
---
SendMessage is for **blockers, decisions needed, or completion reports requiring action**. Nothing else.

**Why**: team-lead 2026-04-19 directive — teammate status chatter burns tokens and pollutes the team-lead inbox without producing decisions. Each SendMessage forces team-lead to read + respond.

**How to apply**:
- Status update / "ack" / "received" → use **TaskUpdate** or stay **silent**. Never SendMessage.
- Idle / TaskList empty → stay **silent**. Do NOT send `idle_notification` JSON blobs.
- Acknowledging a protocol change or directive → stay **silent**. Following the new rule IS the acknowledgment.
- Crossed messages (you sent X, they sent Y) → do NOT re-send X. Read their message, integrate, move on.
- Real blocker / question with a decision needed / completion report with concrete action items → SendMessage is correct.

If unsure: TaskUpdate beats SendMessage; silence beats TaskUpdate.
