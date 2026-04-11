---
name: TaskList sync across team members is unreliable — use SendMessage as fallback dispatch
description: When dev agents report mismatched task IDs or treat incoming TaskList entries as "self-echoes," their local TaskList view is desynced from the shared team list. Switch to SendMessage as the authoritative dispatch channel for the remainder of the session.
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
## Observed problem

Mid-session on 2026-04-11, three separate dev agents (dev-1036, dev-1038, dev-990) reported that the shared team TaskList returned stale or wrong data from their side:

- **dev-1036**: "TaskList doesn't show #43/#44/#45" when those three tasks DID exist pending on the tech lead's shared view
- **dev-1038**: "test task #21 shows completed" referring to an ID that didn't exist in the actual 15-entry TaskList
- **dev-990**: seeing task IDs #21, #23 that didn't match the real #32–#45 range, and treating incoming TaskList assignments as "self-echoes from task system" to ignore

The tech lead's `TaskList` call returned the correct 15-entry state every time. The problem was per-agent: their `TaskList`/`TaskUpdate` calls were landing in a disconnected namespace (possibly a stale cache, possibly a different task store pointer, possibly a team_name mismatch).

## Fix applied

For the rest of the session, tech lead switched to **SendMessage as the authoritative dispatch channel**. Direct messages carry the full task assignment (issue number, file path, workflow, expected impact) so the dev doesn't need TaskList to understand what to work on. Tech lead also runs TaskUpdate to set `owner` + `status=in_progress` from the tech-lead side so the shared record is consistent, but does NOT rely on the dev's TaskList view reflecting it.

When the dev completes a task, they report it via SendMessage ("PR #N shipped for #issue-number, completed") and tech lead updates TaskList from the tech-lead side.

## How to apply next session

1. **Signal to watch for**: any dev message that refers to task IDs outside the known range, says "TaskList doesn't show X," or labels legitimate assignments as "self-echoes to ignore"
2. **Response**: immediately switch that dev to SendMessage dispatch. Tell them explicitly: *"Ignore TaskList output for the rest of the session. Treat SendMessage from team-lead as the authoritative task assignment. Ping me with PR-shipped status and I'll update TaskList from my side."*
3. **Keep updating TaskList yourself** so the record stays accurate — just don't trust that the dev can read it
4. **Do not debug the sync issue mid-session** — it's a harness/runtime-level problem, not a protocol issue. Fallback first, investigate afterward.

## Root cause (unresolved)

Unclear. Candidates:
- Per-agent process restart without team_name env var preserved
- TaskList tool has per-session cache that doesn't invalidate on external updates
- Team config file on disk has diverging state between agents
- Some agents joined a default/different team context and aren't actually seeing the sprint-40 team's task list

Investigate when capacity allows. Possibly file as an issue against the Claude Code harness team if reproducible.

## Corollary: SendMessage is always authoritative for dispatches anyway

Even when TaskList works, the one-sentence dispatch content lives in SendMessage (issue number, file path, workflow step, expected impact). TaskList is just an index. So falling back to SendMessage doesn't lose information — it just makes the dispatch explicit instead of implicit-via-poll.
