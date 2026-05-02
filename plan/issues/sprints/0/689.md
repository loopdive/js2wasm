---
id: 689
title: "Dynamic worker pool: memory-aware scaling with dead worker recovery"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: test-infrastructure
required_by: [690, 691, 692]
files:
  scripts/run-test262.ts:
    breaking:
      - "dynamic worker pool with memory-aware scaling"
---
# #689 — Dynamic worker pool: memory-aware scaling with dead worker recovery

## Status: open

POOL_SIZE is currently a fixed number (default 4). Workers can OOM on heavy tests, and their remaining batch is lost until retry phase.

### Requirements
1. **Memory-aware pool sizing**: Before spawning a worker, check `os.freemem()`. Only spawn if free memory > 1.5GB (enough for one worker + headroom). POOL_SIZE becomes a max, not fixed.
2. **Dead worker detection**: If a worker process exits unexpectedly (not timeout), immediately redistribute its remaining tests to surviving workers or spawn a replacement.
3. **Live reassignment**: When a worker dies mid-batch, its unfinished tests are pushed back to a shared queue. The next available worker picks them up.
4. **Graceful degradation**: If memory is too low for any workers, wait and retry. Log memory state.

### Approach
```typescript
const MAX_WORKERS = parseInt(process.env.TEST262_WORKERS || "4", 10);
const MIN_FREE_MEM_MB = 1500; // don't spawn if less than 1.5GB free

function canSpawnWorker(): boolean {
  const freeMB = os.freemem() / 1024 / 1024;
  return freeMB > MIN_FREE_MEM_MB;
}

// Instead of fixed chunks, use a work-stealing queue:
// - Main thread holds a queue of test jobs
// - Each worker pulls N tests at a time (e.g., 50)
// - When a worker finishes its batch, it pulls more
// - When a worker dies, its in-flight tests return to the queue
```

### Benefits
- No more lost batches from OOM workers
- Adapts to available memory (works with 8GB or 20GB containers)
- Agents and test262 can coexist without manual tuning

## Complexity: M
