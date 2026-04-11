---
name: Token budget guardrails — warn at 25%, force break at 40%
description: Watch weekly token budget consumption; proactively compact or terminate session when thresholds are crossed so one day doesn't burn a week
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Hard thresholds on weekly token budget to prevent a single long session from burning the week:

- **≤25%** of weekly budget consumed on the current session day: continue normally
- **25%** crossed: warn the user, recommend `/compact` or session end at the next natural breakpoint (sprint boundary, completion of current task)
- **40%** crossed: stop dispatching new work in the current session. Finish any in-flight commit/push, write tech-lead context summary to `plan/agent-context/tech-lead.md`, end the session. Resume in a fresh session tomorrow.
- **50%** crossed: hard stop, even mid-task. Budget for the week is at risk.

## Why

A single tech-lead session that triages 80 regressions, merges 6 PRs, files follow-up issues, handles infra fixes, and does sprint planning can do ~150+ tool calls. Every tool call pays the cumulative history as input tokens, so the marginal cost climbs linearly. One day at 43% weekly budget (observed: 2026-04-11) means only 57% remains for the other 6 days.

The biggest driver is NOT the number of actions — it's the length of the conversation. Compacting mid-session or splitting phases across sessions dramatically reduces per-action cost.

## How to apply

- Watch for budget usage signals from the user ("we've burned X% of weekly")
- If the user hasn't said anything but the session has been active for >2 hours of continuous tech-lead work, assume you're approaching a threshold and proactively suggest compaction
- On any threshold crossing: tell the user the current estimate, recommend the action (compact / context-dump-and-exit / hard stop)
- Bias toward smaller, focused sessions over long omnibus sessions — even if it means the same work takes 2-3 separate conversations

## Corollary — measure what you pay for

Big cost contributors (in rough order):
1. Inherited compaction summaries from `--resume`
2. Repeated full-file `Read` when a grep or offset+limit would do
3. `gh run view --log` without `--jq` filters (GB-scale logs)
4. `git status` with scratch pollution (fixed as of this session with `.tmp/`)
5. Verbose dev SendMessage status updates (should be TaskUpdate)
6. Tech-lead status tables replayed in every reply to the user
