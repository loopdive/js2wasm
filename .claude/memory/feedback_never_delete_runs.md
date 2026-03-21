---
name: Never delete test262 run data
description: Never delete JSONL/report files from benchmarks/results/runs/ — they are the only copy and not in git
type: feedback
---

NEVER delete test262 run files from `benchmarks/results/runs/`. They are not tracked in git and cannot be recovered once deleted.

**Why:** I deleted the most complete run (24k lines, 18k unique tests) while "cleaning up stale runs", forcing a full 30-min re-run from scratch. The data was irreplaceable.

**How to apply:** When multiple run files exist, leave them all. The symlinks point to the active one. Old runs serve as baselines for `--recheck`. If disk space is a concern, ask the user before deleting anything.
