---
name: CI wait — background loop + Monitor, not foreground polling
description: Devs must use run_in_background + Monitor for CI waits, never foreground sleep loops
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Use `run_in_background: true` on the `until` CI-status loop, then call Monitor to block on it. The agent burns zero tokens while waiting and only wakes when the file lands.

**Why:** Foreground polling loops (or agents manually polling CI status) burn tokens continuously and cause idle_notification spam. A background loop + Monitor gives the same result with no active token burn between checks.

**How to apply:** In developer.md step 5 (Wait for CI), always use background + Monitor. Never foreground `until` loops, never manual `sleep`/check cycles. Tech lead should shut down any agent that is idle-pinging while waiting for CI — take over the merge directly.
