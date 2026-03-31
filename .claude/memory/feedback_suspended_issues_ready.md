---
name: Suspended issues go in ready/
description: When suspending work on an issue, move/keep the issue file in plan/issues/ready/, not done/
type: feedback
---

When suspending work on an issue, the issue file should be in `plan/issues/ready/`, not `plan/issues/done/`. Only completed and merged issues belong in `done/`.

**Why:** Suspended issues are not done — they need to be picked up again. Keeping them in `ready/` makes them visible to the next agent.

**How to apply:** When writing `## Suspended Work` to an issue file, ensure the file is in `plan/issues/ready/`. If it was previously in `done/`, move it back with `mv`.
