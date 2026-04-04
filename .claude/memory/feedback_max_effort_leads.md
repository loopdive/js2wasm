---
name: feedback_max_effort_leads
description: Tech lead and architect agents should always use max effort (opus model)
type: feedback
---

Tech lead (orchestrator) and architect agents should use max effort.

**Why:** These roles make decisions that cascade to all dev work — wrong baseline comparison, premature merges, bad specs. Max effort catches errors that lower effort misses (like the 1,514 regression that was dismissed as "runner instability").

**How to apply:**
- Tech lead: user sets `/effort max` at session start
- Architect agents: spawn with `model: "opus"` parameter
- Dev agents: default effort is fine (they follow specs, not make architectural decisions)
