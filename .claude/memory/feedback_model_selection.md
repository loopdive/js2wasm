---
name: feedback_model_selection
description: Tech lead must check issue reasoning_effort before spawning dev agents and set model accordingly
type: feedback
---

Before spawning a dev agent, read the issue's `reasoning_effort` frontmatter field and set the agent model:

- `reasoning_effort: max` → `model: "opus"` (hard/architectural issues)
- `reasoning_effort: high` → `model: "sonnet"` (medium issues, default)
- `reasoning_effort: medium` → `model: "sonnet"` or `model: "haiku"` (easy issues, docs, tests)

**Why:** This session spawned 30+ agents all on opus, burning 25% of weekly token budget in one day. Most dev tasks (docs, cleanup, easy fixes) don't need opus-level reasoning.

**How to apply:** When dispatching from the sprint task queue:
1. Read the issue file: `head -10 plan/issues/{N}.md`
2. Check `reasoning_effort:` field (or `feasibility:` as fallback)
3. Set `model` parameter in the Agent tool call accordingly
4. For batched easy issues (3+ simple fixes to one dev), always use haiku/sonnet
