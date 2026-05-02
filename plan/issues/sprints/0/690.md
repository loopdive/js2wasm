---
id: 690
title: "Streaming test results with incremental report updates and zero-copy worker IPC"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: spec-completeness
depends_on: [689]
required_by: [691, 692]
files:
  scripts/run-test262.ts:
    breaking:
      - "streaming results from workers, incremental report updates"
  scripts/test262-worker.ts:
    breaking:
      - "send results as they complete, not in batch"
---
# #690 — Streaming test results with incremental report updates and zero-copy worker IPC

## Status: open

### Problem
1. Results only appear when an entire category (up to 11K tests) completes — no visibility during processing
2. Workers serialize full result objects as JSON over IPC — expensive for 48K messages
3. Report only updates at end of run — stale during 2-hour runs

### Requirements

**Streaming results:**
- Workers send each test result immediately as it completes (not batch)
- Main thread writes to JSONL in real-time (already has `writeSync` for atomic lines)
- Report.json regenerated every N results (e.g., every 100 or every 30 seconds)

**Incremental report:**
- Write a `test262-progress.json` alongside report.json with: `{ processed, total, pass, fail, ce, skip, lastUpdate }`
- report.html polls this file (from #687) for live progress
- Full report.json rebuilt every 500 results or 60 seconds

**Zero-copy IPC (SharedArrayBuffer approach):**
```
Main thread:
  1. Allocate SharedArrayBuffer for result ring buffer
  2. Pass SAB to worker via workerData
  3. Worker writes result structs directly into SAB
  4. Main thread reads from SAB using Atomics.wait/notify

Result struct (fixed 256 bytes per entry):
  [0..3]   status: i32 (0=pass, 1=fail, 2=ce, 3=skip)
  [4..7]   compileMs: f32
  [8..11]  executeMs: f32
  [12..15] errorLen: i32
  [16..143] error: utf8 (128 bytes max)
  [144..255] file: utf8 (112 bytes max)
```

**Alternative: MessagePort with transferable ArrayBuffers:**
If SharedArrayBuffer is too complex, use structured clone with transfer:
```typescript
// Worker side
const buf = new ArrayBuffer(resultBytes);
// ... fill buf ...
parentPort.postMessage(buf, [buf]); // zero-copy transfer
```

**Simpler alternative: just reduce batch size:**
Instead of one batch per worker with all tests, give each worker 50 tests at a time. Worker returns results, gets next 50. This gives natural streaming with minimal change:
```typescript
// Current: worker gets 12,000 tests, returns all at once
// Proposed: worker gets 50 tests, returns 50 results, gets next 50
```

### Recommended approach
Start with the simple batch-size reduction (50 tests per round). This:
- Gives results every ~30 seconds per worker
- No SharedArrayBuffer complexity
- Compatible with work-stealing from #689
- Report updates incrementally

Then optimize IPC later if it's a bottleneck (unlikely — JSON serialization of 50 results is <1ms).

## Complexity: M (simple batch), L (SharedArrayBuffer)
