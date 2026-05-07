---
id: 1354
sprint: backlog
title: "spec backlog: SharedArrayBuffer + Atomics (full implementation, requires multi-thread Wasm)"
status: backlog
created: 2026-05-08
priority: low
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
language_feature: sharedarraybuffer
goal: spec-completeness
parent: 1334
related: 1353
---
# #1354 — SharedArrayBuffer + Atomics

## Problem

`built-ins/SharedArrayBuffer`: 0/104 — all skipped.
`built-ins/Atomics`: 92/382 (24.1%, mostly stubs returning undefined).

Spec §25.2 (SharedArrayBuffer) and §25.4 (Atomics) require:
1. `new SharedArrayBuffer(byteLength, {maxByteLength?})` — heap memory shared across agents.
2. `Atomics.load/store/exchange/compareExchange/add/sub/and/or/xor` — atomic RMW ops.
3. `Atomics.wait/notify` — futex-style blocking + wakeup (requires agent scheduler).
4. `Atomics.waitAsync` — non-blocking wait that resolves a Promise.
5. `Atomics.isLockFree(size)` — true for 4-byte aligned word-sized ops.

## Acceptance criteria

1. `new SharedArrayBuffer(N)` allocates a `shared` Wasm memory.
2. TypedArray views over a SAB are themselves shared (write-visible across agents).
3. All `built-ins/Atomics/*` tests that are not blocked on a missing JS Worker host pass.
4. `built-ins/SharedArrayBuffer/length/*`, `prototype/byteLength/*`, `prototype/grow/*` pass.

## Implementation notes

- Wasm has the `shared` memory flag (multi-memory + threads proposal). Toolchain (binaryen,
  wasm-tools) must enable threads in the emit + the runtime.
- Atomics.wait blocks the current agent — needs a host-provided `__agent_wait(addr, expected, timeout)`
  bridge in JS-host mode (delegating to Atomics.wait on the underlying SAB) and a futex emulator
  in standalone mode.
- Atomics.waitAsync is callable from any agent (not just the main thread), so its return Promise
  must be resolvable from a worker — requires our microtask scheduler (#1326) to be agent-aware.

## Files (eventual)

- `src/codegen/registry/atomics.ts` — replace stubs with real `*.atomic.*` Wasm ops
- `src/runtime.ts` — `__sharedarraybuffer_*`, `__agent_*` host imports
- New: thread / Worker host bridge

## Dependency

Blocked by #1353 (Memory Model). When threading lands, this issue becomes the implementation
task. Until then, the SAB sections in `spec-compliance/sec-25.2.md` and `sec-25.4.md` should
remain "not implemented" with a link here.
