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

## Implementation Plan (architect-spec, senior-developer, 2026-05-08)

### Scoping

The original ~1,500 LoC estimate spans Phase 1+2+3. Phase 1 alone is still
substantial — about 500–700 LoC of new code plus 100–200 LoC of edits at
existing Promise-handling sites. Decomposed into four sub-slices that
each compile + ship independently:

| Sub-slice | Scope | LoC | Risk |
|-----------|-------|-----|------|
| **1A** (this PR) | Architect spec + scaffolded module + type-registry stubs | ~150 | minimal |
| **1B** (follow-up) | $Promise struct registry + `Promise.resolve`/`reject` standalone path | ~150 | low |
| **1C** (follow-up) | Microtask queue (linear memory) + `Promise.then` standalone path | ~250 | medium |
| **1D** (follow-up) | `__drain_microtasks` export + WASI `_start` integration | ~150 | medium |

Each sub-slice is gated on a new flag `ctx.standalonePromise: boolean`,
auto-enabled in WASI target mode (`ctx.target === "wasi"`) and opt-in
elsewhere via a CLI flag. The default JS-host path is preserved
unchanged — no test262 risk for the existing Promise tests.

### Architecture overview

#### `$Promise` WasmGC struct

```
(type $Promise (struct
  (field $state (mut i32))                          ; 0=pending, 1=fulfilled, 2=rejected
  (field $value (mut externref))                    ; fulfilled value or rejection reason
  (field $callbacks (mut (ref null $vec_funcref)))  ; pending then-callbacks
))
```

Reuses the existing `$vec_funcref` shape from the closure GC infrastructure
(grown via `array.copy` like other vec types). The `$callbacks` field is
nullable so unused promises don't allocate the empty vec.

#### Microtask queue (linear memory)

A fixed-page region in linear memory (1 page = 64 KiB = 8K slots of 8
bytes each) holding `(funcref_idx, arg_id)` pairs. The funcref table
holds the actual funcref values; the queue stores indices. Externref
arguments are stored in a parallel `(ref null $vec_externref)` whose
slot index matches.

Why linear memory + funcref table instead of a pure WasmGC vec? Because
a `(ref null $task_record)` vec has worse cache locality than tightly-
packed i32 indices, and the queue is the hottest data structure in
async-heavy code. Phase 2 (CPS desugaring) reuses the same queue.

Operations:
- `__microtask_enqueue(funcIdx: i32, arg: externref) -> void`:
  - Append `(funcIdx, arg)` at the queue tail. If full, `memory.grow` by
    1 page (or panic on growth failure). Standalone-mode export.
- `__drain_microtasks() -> void`:
  - While `head != tail`, pop front, invoke `funcref_table[funcIdx](arg)`,
    advance head. Loops until queue is empty (which may be many iterations
    if callbacks enqueue more microtasks). Exported.

Edge cases:
- Re-entrant `enqueue` during `drain`: queue is a circular buffer, append
  works fine, drain catches up as long as the loop continues
- Promise.then during drain: legal — the resulting microtask is appended
  and processed in this same drain cycle (matches JS spec)
- Exception in microtask body: catch and report via host exception
  channel; in standalone mode, abort with an unhandled-rejection log

#### Standalone-mode Promise codegen

For each call site that today emits `call $Promise_*_import`:
- If `ctx.standalonePromise === false` (default): emit existing host import
- If `ctx.standalonePromise === true`: emit a call to a Wasm-internal
  helper:
  - `Promise_resolve(v)` → `struct.new $Promise (i32.const 1) (v) (ref.null $vec_funcref)`
  - `Promise_reject(reason)` → `struct.new $Promise (i32.const 2) (reason) (ref.null $vec_funcref)`
  - `Promise_then(p, fn)` →
    ```
    block (result (ref $Promise))
      local.get $p; ref.cast $Promise; local.tee $p_struct
      struct.get $Promise $state
      i32.const 1                ;; FULFILLED
      i32.eq
      if
        ;; Already fulfilled — enqueue fn(value) as microtask
        local.get $fn   ;; funcref
        funcref→idx     ;; via funcref table (reuse __make_callback's table)
        local.get $p_struct; struct.get $Promise $value
        call $__microtask_enqueue
        ;; Return a new fulfilled promise (chained, settled later by callback)
        i32.const 0; ref.null extern; ref.null $vec_funcref
        struct.new $Promise
      else
        ;; Pending — append to callbacks vec (lazy-allocate if null)
        ...
      end
    end
    ```
  - `Promise_new(executor)` → call executor with synthesised `(resolve, reject)`
    closures that mutate the freshly-created `$Promise` struct.

The funcref→i32 conversion is the trickiest bit. Wasm doesn't have a
direct "store funcref get index" op. The codegen emits `ref.func $closure_N`
plus `i32.const <table_idx>` for each known closure; the funcref table
is populated at module init time. For dynamic funcrefs (closure captures),
we use `table.set` at closure-construction time and remember the slot.
This is similar to the existing `__make_callback` shim's funcref-id
handling; reuse the same machinery.

### Sub-slice 1A — Architect spec + scaffold (THIS PR)

**Files (new):**
- `src/codegen/async-scheduler.ts` — module skeleton with type-registry
  helpers, currently no-op (returns `null` until 1B).
- `tests/issue-1326.test.ts` — smoke test that imports the module
  and verifies it loads cleanly; sub-slice 1B+ will extend.

**Files (modified):**
- `src/codegen/registry/types.ts` — add `getOrRegisterPromiseType(ctx)`
  helper that registers the `$Promise` WasmGC struct type.

**Exports added (stubbed):**
```ts
export function getOrRegisterPromiseType(ctx: CodegenContext): number;
export function getOrRegisterMicrotaskQueueType(ctx: CodegenContext): number;
export function emitMicrotaskEnqueue(ctx, fctx, funcRef, arg): void;       // throws
export function emitDrainMicrotasks(ctx, fctx): void;                       // throws
export function emitStandalonePromiseResolve(ctx, fctx, value): void;       // throws
export function emitStandalonePromiseThen(ctx, fctx, promise, fn): void;    // throws
```

The throwing stubs are intentional — they make sub-slice 1B's first job
to remove the throw and emit real Wasm. This forces explicit "what
changed" review per sub-slice.

**Acceptance for 1A:**
- New module `src/codegen/async-scheduler.ts` exists with the stubbed exports
- Type-registry helpers produce reasonable `$Promise` and `$microtask_queue`
  struct types when called (verifiable via WAT inspection)
- Existing test262 numbers UNCHANGED (no behaviour change yet)
- `tests/issue-1326.test.ts` smoke test compiles + verifies the module loads

### Sub-slice 1B — Promise.resolve/reject standalone path (~150 LoC)

**Implements:**
- `emitStandalonePromiseResolve` and `emitStandalonePromiseReject` real bodies
- Dispatch in `src/codegen/expressions/calls.ts` near `Promise_resolve` /
  `Promise_reject` import emission: gate on `ctx.standalonePromise` flag;
  when true, emit Wasm-native `struct.new` instead of host call.

**Acceptance:**
- `Promise.resolve(42)` returns a $Promise with state=1, value=42 (verified
  in standalone mode via export of `Promise_resolve_test()`)
- `Promise.reject("err")` similarly with state=2

### Sub-slice 1C — Microtask queue + Promise.then (~250 LoC)

**Implements:**
- Linear-memory queue (with growth via `memory.grow`)
- Funcref→i32 table machinery (or reuse from `__make_callback`)
- `emitMicrotaskEnqueue` real body
- `Promise.then` standalone path:
  - If promise.state === 1 (fulfilled): enqueue
  - If promise.state === 2 (rejected): enqueue with reject path
  - If pending: append to callbacks vec

**Acceptance:**
- `Promise.resolve(42).then((x) => x + 1)` after `__drain_microtasks()`
  yields a fulfilled promise with value=43
- Chain of three `.then()` calls executes in order

### Sub-slice 1D — Drain export + WASI integration (~150 LoC)

**Implements:**
- `emitDrainMicrotasks` real body (with re-entrancy safety)
- Export `__drain_microtasks` from the module
- WASI `_start` integration: in WASI target mode, wrap user entry with
  `try { user_entry(); __drain_microtasks(); } catch ...`

**Acceptance:**
- WASI smoke test: `async function main() { return await Promise.resolve(42); }`
  compiled to WASI returns exit code 42 (or writes 42 via fd_write)
- All Phase 1 acceptance criteria from the issue pass

### Risk assessment

**Low** for 1A (this PR) — pure additive, no existing behaviour changes.

**Medium** for 1B — touches Promise.resolve/reject codegen. The flag gate
keeps default JS-host mode untouched. Risk: missing some Promise.resolve
emit sites and getting inconsistent behaviour. Mitigate by grep-finding
all sites and gating each.

**Medium-High** for 1C — funcref→i32 table interaction is subtle.
Reusing `__make_callback`'s machinery is the right move; building from
scratch risks divergence.

**Medium** for 1D — WASI `_start` wiring touches the entry point. Validate
against the existing WASI examples in `examples/wasi-*`.

### Out-of-scope (Phase 2+)

- `async function f() { ... await x ... }` CPS desugaring (Phase 2)
- `Promise.all` / `race` / `allSettled` / `any` (Phase 3)
- Async generators standalone (Phase 3)
- Microtask queue eviction policies / panic-on-overflow tuning
- Performance optimization vs existing JS-host Promise (correctness first)
