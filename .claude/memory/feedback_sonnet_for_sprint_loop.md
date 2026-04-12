---
name: feedback_sonnet_for_sprint_loop
description: Use Sonnet for routine sprint orchestration loop; only escalate to Opus for crisis investigation or architectural decisions
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Use Sonnet model for routine tech-lead-loop iterations (dispatch, merge queue, status checks, sprint hygiene). Only raise to Opus when:
- Investigating a regression or CI crisis
- Making architectural decisions
- Debugging complex compiler issues
- Writing retrospectives or detailed analysis

**Why:** Sprint watching is high-frequency, low-complexity — Sonnet handles dispatch/merge/status fine and burns far fewer tokens. Opus should be reserved for the hard thinking.

**How to apply:** When running /tech-lead-loop, default to Sonnet. Switch to Opus when the loop encounters a problem that requires deep investigation.
