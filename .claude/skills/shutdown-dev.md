---
name: shutdown-dev
description: Cleanly shut down a dev teammate — instruct them to write a context summary to plan/agent-context/{name}.md first, receive their approval, verify process exit. Use for scale-down, rotation, sprint wrap-up.
---

# Shutdown Dev

Gracefully terminate a dev teammate's session while preserving their working context for future resumption.

## When to use

- Team scale-down (e.g. going from 8 → 6 devs after OOM pressure or sprint close)
- Dev assigned to an orphaned branch after their PR was closed
- Sprint retrospective and wrap-up — shutting down devs between sprints
- Memory pressure requiring you to shed agent processes

## Pre-shutdown checklist

1. **Is the dev in the middle of something?** Check their task status:
   ```bash
   # via TaskList, filter for owner == <dev-name>
   ```
   If they're mid-implementation on a non-trivial task, prefer rotating them OFF that task first rather than losing the work.

2. **Is the user currently talking to this dev?** If yes, confirm with the user before shutting down.

3. **Do they have uncommitted work in their worktree?** Check via their file-locks entries and any in-flight PRs. Warn them to commit before approving shutdown.

## Step 1: Send the shutdown_request

```
SendMessage to: <dev-name>
Type: shutdown_request

{"type": "shutdown_request", "reason": "<reason — e.g. 'Scaling team from 8 to 6 after OOM recovery; your current PR is merged/closed and you have no active task'>. Before approving shutdown: (1) write your working context to plan/agent-context/<dev-name>.md — include active branches, any in-progress thoughts, and anything a successor agent would need to resume. Keep it concise (~100 lines). (2) Commit any uncommitted WIP in your worktrees, or note explicitly that nothing is WIP. (3) Reply with shutdown_response approve=true. Your worktrees and branches stay — another dev can resume them later."}
```

**Critical constraints in the message:**
- MUST instruct them to write `plan/agent-context/<name>.md` FIRST
- MUST tell them to commit uncommitted WIP
- MUST NOT ask them to narrate their context in the chat reply (that bloats the tech lead's context)
- Reply should be a one-line `shutdown_response` approve=true

## Step 2: Wait for response

The dev will either:
- Reply with `{"type":"shutdown_response","approve":true,"request_id":"..."}` → proceed to step 3
- Reply asking questions (rare) → answer briefly, re-send shutdown_request
- Not respond (stuck process) → see step 5

## Step 3: Verify the context file was written

```bash
ls -la plan/agent-context/<dev-name>.md
head -20 plan/agent-context/<dev-name>.md
```

The file should exist, be recent, and have substantive content (not empty).

If the dev skipped this step, re-send the shutdown_request with an explicit "blocked until context file exists" note.

## Step 4: Verify the worktree is in a known state

```bash
wt=/workspace/.claude/worktrees/<branch-name>
git -C "$wt" diff --stat      # uncommitted changes
git -C "$wt" log --oneline main..HEAD  # unmerged commits
```

If there are uncommitted changes: write them to the agent-context file as "Suspended Work" with a resume recipe, then commit or drop per the dev's note.

If there are unmerged commits: note the branch name in the context file so a successor can pick up.

## Step 5: If the dev is unresponsive

The dev's claude process may be stuck or already dead. Verify:

```bash
# Find their tmux pane / pid
tmux list-panes -a -F '#{pane_pid} #{session_name}:#{window_index}.#{pane_index}'
ps -ef | grep claude | grep <their pid or pane>
```

Options:
1. Wait another 60s — they may be mid-tool-call
2. Send a `PAUSE` to interrupt the current work, then retry the shutdown_request
3. If clearly dead: manually write their agent-context file based on known state (branch name, task ID, last-known progress from TaskList), then kill the process

## Step 6: Commit the context file

If the dev committed it themselves, you're done. If not:

```bash
cd /workspace
git add plan/agent-context/<dev-name>.md
git commit -m "docs(agent-context): preserve <dev-name> state before shutdown

Checklist completed.

<dev-name> shut down during <reason>. Context preserved for resumption.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

## Step 7: Update team state

- Remove the dev from any active dispatch messaging
- Update `plan/method/agent-sessions.md` if it tracks live sessions
- Update `plan/method/file-locks.md` to drop any claims held by the dev

## Step 8: Confirm termination

After the dev's process exits (approved shutdown), verify no orphan vitest or subprocess runners remain:

```bash
ps -ef | grep -E '(vitest|claude)' | grep -v grep
```

If leftover processes trace back to the shut-down dev, kill them.

## Output

```
Shutdown complete: <dev-name>
Context saved: plan/agent-context/<dev-name>.md (~NN lines)
Worktree: <branch> preserved, <uncommitted|clean>, <unmerged|merged>
Team size: N → N-1
```

## Notes

- **The agent-context file is the handoff channel** — without it, a successor agent has to reconstruct everything from issue files and git history.
- **Never delete worktrees on shutdown** — they may contain recoverable state a successor needs. Cleanup happens at sprint close, not at shutdown.
- **Don't shut down devs mid-PR-review** — if their PR is open and awaiting CI, wait for CI to finish (merge or close) before shutting down. Otherwise their context file has to describe a PR state that may change.
- **Scale-down batches:** when shutting down multiple devs, send all the shutdown_requests in parallel (one SendMessage each in a single message) and wait for all approvals before verifying.
