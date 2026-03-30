# Agent Session Registry

Track active and recent agent sessions so they can be resumed or their context recovered.

## Active sessions

| Agent | Team | Session ID | Worktree | Started | Notes |
|-------|------|-----------|----------|---------|-------|
| (filled by tech lead when spawning agents) |

## Session management rules

### When to keep an agent alive (idle is OK)
- PO during sprint planning — accumulates discussion context
- SM during/after retro — user may want to continue discussing
- Blog/creative agents — back-and-forth is the product
- Architect during design review — may need follow-up questions

### When it's safe to shut down
- Devs between tasks — task context lives in issue files + checklists
- Architect after spec is written and reviewed — output is in the issue file
- SM after retro is applied and user confirms done
- PO after sprint plan is finalized and user confirms done

### Before shutting down any agent
1. **Ask the user** if they're still talking to it
2. Agent writes a context summary to `plan/agent-context/{agent-name}.md`:
   - Key decisions made
   - Open threads / unresolved questions
   - What was proposed and accepted/rejected
3. Record the session ID in this registry for potential transcript recovery

### Resuming an agent
- If the agent wrote a context summary: pass it in the spawn prompt
- If the session JSONL is available: reference it in the spawn prompt
- Always include the agent's last output files (retro, spec, blog draft, etc.)

## Context summary format

Agents should write to `plan/agent-context/{agent-name}.md` before shutdown:

```markdown
# {Agent Name} Context Summary

**Session**: {date/time range}
**Team**: {team name}

## Key decisions
- (what was decided and why)

## Open threads
- (unresolved questions or ongoing discussions)

## Proposed and rejected
- (what was proposed but the user said no to — important for resumption)

## Proposed and accepted
- (what was approved — so the new session doesn't re-propose)

## Files written/modified
- (so the new session knows where its output went)
```
