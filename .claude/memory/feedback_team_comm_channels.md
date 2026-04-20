---
name: Team communication — use the right channel, not verbose chat
description: Devs must send status via TaskUpdate not verbose SendMessage, and shutdown handoffs must go through plan/agent-context/{name}.md files rather than chat narration
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Three rules for keeping dev ↔ tech-lead communication token-efficient:

## 0. No idle notifications

When TaskList is empty and a dev has nothing to do, they MUST stay silent — no `idle_notification` JSON, no "standing by" SendMessage. Idle pings land in the tech lead's context stream and add tokens every turn for the rest of the session.

**Why:** idle_notification blobs are pure overhead — they carry no decision-relevant information. Each one injected into the tech lead context costs ~100 tokens on every subsequent tool call for the lifetime of the session. In a session with 4 devs firing 3-4 idle pings each, this adds thousands of wasted tokens.

**How to apply:**
- Devs: when TaskList returns empty, simply stop. Don't message. Wait for dispatch.
- Tech lead: if an idle_notification arrives, ignore it and do not ping back asking for status. That causes a message-crossing loop.
- Brief new dev agents on this at spawn time: "When idle, stay silent."

## 1. Status updates → TaskUpdate, not SendMessage

When a dev has progress to report (branch pushed, PR opened, tests passing, blocker hit), they should call `TaskUpdate` on their current task, NOT send a multi-paragraph SendMessage narrating what they did.

**Why:** SendMessage content lands verbatim in the tech lead's conversation context. A 500-word status report from one dev costs the tech lead ~700 tokens every subsequent tool call for the rest of the session. TaskUpdate metadata is queried on-demand via `TaskGet`, and only when the tech lead actually needs it.

**Tech lead must NOT ping agents asking for status.** Doing so triggers a response, which may cross with an in-flight report, causing duplicate messages and cascading token waste. Wait for the agent to self-report when done.

**When SendMessage is still appropriate:**
- Blocker requiring tech lead decision ("need input on approach for X")
- False-positive regression flag that needs tech lead judgment
- File-lock conflict requiring negotiation
- Merge-ready notification where the tech lead needs to act immediately

**When to use TaskUpdate comment / activeForm / status instead:**
- "I pushed my branch" / "PR opened" / "CI running" — TaskUpdate activeForm
- "Tests pass" / "equivalence matches main" — TaskUpdate activeForm
- "Next step is to refactor X" — TaskUpdate description
- Routine progress pings — don't send anything; the activeForm spinner is the signal

**How to apply:**
- Tech lead: when a dev sends a verbose status message, reply with "please put this in TaskUpdate next time" once and save them to context discipline memory so it spreads across the team.
- Brief new dev agents on this protocol as part of their dispatch message.

## 2. Agent shutdown → write to plan/agent-context/{name}.md before approving

When a dev is being shut down (scale-down, sprint wrap-up, orphan cleanup), they should NOT narrate their context summary in SendMessage. They should write it to `plan/agent-context/{name}.md` and the tech lead reads that file only if/when it's needed.

**Why:** Shutdown narrations tend to be long ("here's my branch, here's what I was thinking, here are the regressions I saw, here's what should happen next"). All of that gets dumped into the tech lead's context verbatim. Most of it is never needed.

**How to apply:**
- Shutdown request from tech lead MUST say "write your context summary to `plan/agent-context/{name}.md`" as the FIRST step
- Dev writes the file, commits if appropriate, replies with a ONE-LINE shutdown_response "summary written, safe to shutdown"
- Tech lead reads the file later only if a successor agent needs to resume the work
- The file lives with the repo so future sessions can pick it up; chat narration dies with the session
