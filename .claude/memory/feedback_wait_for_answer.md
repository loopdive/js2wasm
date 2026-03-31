---
name: Ask then WAIT — don't act on assumed answers
description: When asking the user a question, STOP and wait for their reply. Never act on the assumed "yes" in the same message.
type: feedback
---

When you ask the user a question ("do you want me to X?", "should I Y?"), you MUST:
1. End your response after the question
2. Wait for the user's reply
3. Only then act

**DO NOT** ask a question and then execute the action in the same message. This includes:
- "Want me to run test262?" → runs it anyway
- "Should I shut down X?" → sends shutdown
- "Do you want to continue?" → continues anyway

**Why:** The user said "you are getting ahead of yourself" — multiple times this session. The pattern is: asking a question but treating it as rhetorical, acting on the assumed "yes" without waiting. This removes the user's ability to say no or redirect.

**How to apply:** If your message contains a question to the user, it should be the LAST thing in your message. No tool calls after it. No actions after it. Just the question, then stop.
