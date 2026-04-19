---
name: Tech lead context discipline
description: Stop re-checking state, split planning vs execution sessions, write handoffs to plan/agent-context/tech-lead.md instead of resuming long sessions
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Three related rules for keeping the tech-lead conversation context lean:

## 1. Stop re-checking state

Once per phase is enough for `git status`, `git log`, `free -m`, `gh pr list`, `gh run list`. After each check, track the result in your working memory (written text in your next response, or a memory file if it spans sessions) rather than re-running the same probe every few turns.

**Why:** Each re-check costs tokens for the tool call AND adds its output to every subsequent tool call's input. Over a long session, this compounds fast.

**How to apply:**
- Keep a single "current state" mental model — PR numbers, baseline, memory headroom, in-flight work
- Only re-check when something would have actively changed: after a merge, after a dispatch, after user action that implies state change
- Don't re-check "to confirm" after edits — Edit/Write error if they fail, and harness reminders already show current file state

## 2. Split planning vs execution sessions

Planning sessions decide *what* to do. Execution sessions do the work. Keep them in separate conversations so neither carries the other's noise.

**Why:** A planning session accumulates triage tables, PR diffs, regression samples, and architectural discussion. An execution session accumulates rebase output, merge narrations, and dispatch messages. Combined, they hit budget limits fast.

**How to apply:**
- Planning phase: triage → write issues → populate TaskList → persist decisions in `plan/issues/sprints/N/sprint.md`. End session.
- Execution phase: fresh session. Read issues / TaskList. Dispatch. Merge. Repeat.
- If a single session must do both, run `/compact` between them.

## 3. Write tech-lead handoffs to plan/agent-context/tech-lead.md — don't rely on session resume

Every `claude --resume <old-id>` inherits a multi-thousand-token compaction summary of the prior session. That summary is then carried forward into every tool call of the new session, forever.

**Why:** Session resume is NOT free. A resume that brings back a summary already 20% the size of your weekly budget means every tool call in the resumed session costs 20% more than it should.

**How to apply:**
- Before ending a long session: write current state, open PRs, active devs, blockers, and next actions to `plan/agent-context/tech-lead.md` (~200 lines max, bulletted)
- Next session: start fresh (no --resume), read that file as one of your first tool calls, proceed
- Reserve `--resume` for cases where you were mid-edit with uncommitted state that can't be reconstructed from files — not for "I want to continue yesterday's work"
- The project already uses `plan/agent-context/{agent-name}.md` for dev handoffs per CLAUDE.md; same pattern for tech lead
