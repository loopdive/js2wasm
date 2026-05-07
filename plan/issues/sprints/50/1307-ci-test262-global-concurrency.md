---
id: 1307
title: "ci: serialize Test262 Sharded across PRs to eliminate runner-pool contention"
status: done
priority: medium
sprint: 50
created: 2026-05-07
---

# ci: serialize Test262 Sharded across PRs to eliminate runner-pool contention

## Problem

Current concurrency config in `.github/workflows/test262-sharded.yml:73-75`:

```yaml
concurrency:
  group: test262-sharded-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: false
```

The group is **per-PR**, so each PR gets its own concurrency group.
This means multiple PRs' test262 runs execute simultaneously, competing
for the same GitHub Actions runner pool. With 5 PRs open in S50, each
test262 run (16 shards × ~4 min) was blocked for 45+ minutes instead of
the expected ~20 min, because all 80 shard jobs were contending for the
same limited runner pool.

## Proposed fix

Two-part change:

1. **Global serialization** — change the concurrency group to a constant
   so all PRs' test262 runs queue globally:
   ```yaml
   concurrency:
     group: test262-sharded
     cancel-in-progress: false
   ```
   This means PR #2 waits for PR #1's run to finish before starting.
   Wall-clock wait per PR stays ~20 min; total throughput is unchanged
   since the runner pool was the bottleneck anyway.

2. **Per-PR cancel-in-progress** — optionally add a separate inner
   concurrency block (or use `cancel-in-progress: true` with the per-PR
   group) so that pushing a new commit to a branch cancels the in-flight
   run for that same branch, without cancelling other PRs' runs.
   This requires two concurrency blocks or a composite group key.

## Acceptance criteria

- With 3+ PRs open simultaneously, Test262 Sharded runs queue and
  execute sequentially rather than racing.
- Pushing a new commit to a branch cancels that branch's in-progress
  run (not other branches').
- Median per-PR test262 wall time returns to ~20 min.

## Notes

- Reported by dev-1302 during S50 while PR #225 waited 45+ min.
- Low risk change — only affects scheduling, not test logic.
- Small PR, good candidate for a dev to pick up between tasks.
