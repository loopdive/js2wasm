---
name: Ask before killing running tests
description: Never kill a running test262 or vitest process without asking the user first
type: feedback
---

Never kill a running test suite (test262, vitest, benchmarks) without asking the user first. Even if the data appears stale, the user may want the run to complete for comparison or other reasons.

**Why:** The user explicitly asked to always ask before killing tests. Running test suites take significant time and computing resources — killing them wastes that investment.

**How to apply:** If a test run appears stale or problematic, inform the user and ask "The test262 run is using stale code — should I kill it and restart?" instead of just killing it.
