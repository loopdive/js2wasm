---
id: 1353
sprint: backlog
title: "spec backlog: §29 Memory Model implementation (multi-thread Wasm)"
status: backlog
created: 2026-05-08
priority: low
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime, memory
language_feature: memory-model
goal: spec-completeness
parent: 1334
---
# #1353 — §29 Memory Model

## Problem

ECMAScript §29 defines the memory model for shared-memory multi-threaded execution:
sequential consistency for SeqCst accesses, candidate-execution semantics for unordered
accesses, synchronization edges across Atomic operations, agent ordering, etc.

js2wasm currently runs single-threaded, so the memory model is **trivially satisfied**
(every program is an SC-execution by virtue of having one thread). However, the spec is
"eventually in scope" — when we add multi-threaded support (shared memories, Atomics,
SharedArrayBuffer), the memory model becomes a hard correctness requirement.

## Acceptance criteria (when this work is taken on)

1. The Wasm module supports shared memory (`shared` flag on memory imports/exports).
2. Atomic operations (Atomics.load/store/add/CAS/wait/notify) emit Wasm `*.atomic.*` ops.
3. test262 `built-ins/Atomics/*` non-skipped tests pass at the same rate as a host JS engine
   running the same tests.
4. The Memory Model invariants are upheld: SC accesses are sequentially consistent across
   agents, init-tear-free for aligned word-size accesses.

## Files (eventual)

- `src/codegen/registry/atomics.ts` — currently stubs; will need real implementations
- `src/runtime.ts` — agent-creation helpers (currently absent)
- New: thread / worker bridge for the JS host

## Notes

This is a **far-future** dependency for any "Wasm replaces Node Worker Threads" story.
Without shared memory, there is no observable memory-model behavior to test. Until then,
this remains backlog. Listed as Not Implemented in §29 of the audit (`spec-compliance/sec-29.md`).

Test262 baseline: 0 tests directly target §29 — observability is via Atomics and SAB.
