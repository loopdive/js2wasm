---
id: 1326
sprint: 50
title: "Async standalone: implement microtask queue + CPS scheduler in Wasm for Promise/async without JS host"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: low
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: async, promises, generators
goal: standalone-mode
depends_on: []
---
# #1326 — Async standalone: Wasm microtask queue + CPS desugaring

## Problem

`Promise`, `async`/`await`, and async generators all require JS's microtask queue for
correct execution ordering. In standalone/WASI mode, any async code either fails at
instantiation (missing imports) or produces incorrect ordering because there's no event loop.

Generator buffering is ~70% done in the IR (`generatorBufferSlot`, yield queue in
`src/ir/lower.ts`). The missing piece is:
1. A standalone microtask queue scheduler
2. CPS (continuation-passing style) desugaring of `async` functions
3. A `__drain_microtasks()` export for standalone callers

## Strategy

### Part A: Microtask queue

Implement a fixed-size circular queue in Wasm linear memory:
- Each slot: `(funcref, externref arg)` — the pending microtask + its argument
- `__microtask_enqueue(task: funcref, arg: externref)` — push to queue
- `__drain_microtasks()` — run until queue empty (exported; standalone callers invoke
  after top-level entry)
- On queue overflow: grow via `memory.grow` (or panic — configurable)

### Part B: Promise implementation in Wasm

Implement `Promise` as a WasmGC struct:
```
$Promise {
  state: i32,        // 0=pending, 1=fulfilled, 2=rejected
  value: externref,  // fulfilled value or rejection reason
  callbacks: $vec_funcref  // then-callbacks (chained via microtask queue)
}
```
`Promise.resolve(v)` → create $Promise with state=fulfilled, value=v  
`promise.then(fn)` → if fulfilled: enqueue `fn(value)` as microtask; else push to callbacks

### Part C: async function CPS desugaring

Transform `async function f() { const x = await g(); return x + 1; }` into a state machine:
- State 0: call `g()`, register continuation as microtask
- State 1 (resume): `x = resolved_value`, enqueue `return x + 1` as microtask

The IR already has `generatorBufferSlot` and yield-state machinery — reuse the same state
machine pattern for async/await.

### Part D: WASI integration

For WASI standalone programs with async entry points:
- Emit `_start` that calls the async entry, then calls `__drain_microtasks()` in a loop
  until the root promise settles.

## Scope and risk

This is a significant undertaking (~1,500 LoC). Phase it:
1. **Phase 1** (this issue): microtask queue + Promise struct + `resolve`/`then`/`reject`
2. **Phase 2** (follow-up): async function CPS desugaring
3. **Phase 3** (follow-up): full Promise combinators (`all`, `race`, `allSettled`, `any`)

## Acceptance criteria (Phase 1)

1. `await Promise.resolve(42)` returns `42` in standalone mode with `__drain_microtasks()`
2. `.then()` chaining executes in correct microtask order
3. Rejection propagates through unhandled-rejection path
4. `tests/issue-1326.test.ts` — basic promise chaining in standalone mode

## Files

- `src/ir/lower.ts` — emit `$Promise` struct type, enqueue operations
- New: `src/ir/async-scheduler.ts` — microtask queue implementation
- `src/codegen/index.ts` — emit `__microtask_queue` linear memory region + exports
- `src/runtime.ts` — gate existing Promise host imports on JS-host-mode only
