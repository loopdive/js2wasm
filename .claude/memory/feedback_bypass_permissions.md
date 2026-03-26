---
name: feedback_bypass_permissions
description: Always use bypassPermissions mode when spawning agents/teammates
type: feedback
---

Every Agent spawn must include `mode: "bypassPermissions"`. Agents get stuck on permission prompts otherwise — there's nobody to approve them.

**Why:** Multiple agents got stuck for 10+ iterations waiting on permission approval that never came. Wasted compute and time.

**How to apply:** Always include `"mode": "bypassPermissions"` in every Agent tool call.
