---
name: feedback_architect_max_effort
description: Architect agents should use max effort (opus model) for thorough analysis
type: feedback
---

Architect agents should use the max effort model (opus) for thorough analysis.

**Why:** Architectural decisions have outsized impact — a bad spec leads to wasted dev time or regressions (like sprint 31's repair-pass failure). Max effort produces more thorough specs with better edge case analysis.

**How to apply:** When spawning architect agents, use `model: "opus"` parameter in the Agent tool call. This ensures the architect uses the highest reasoning effort for implementation specs.
