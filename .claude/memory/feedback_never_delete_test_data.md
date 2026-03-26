---
name: Never delete test data or run history
description: Never delete test262 cache, results, run data, or benchmarks without asking first
type: feedback
---

Never delete or clear any of:
- `benchmarks/results/runs/` — test262 run history (used for trend graphs)
- `.test262-cache/` — disk cache for compiled tests
- `benchmarks/results/test262-results.jsonl` — current results
- Any test data files

**Why:** Run history is irreplaceable and feeds the trend graph. Cache saves hours of recompilation. Deleted twice by accident.

**How to apply:** Always ask user before removing any test-related data. This includes "cleanup" operations.
