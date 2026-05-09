---
id: 1326c
sprint: 51
title: "Async standalone Phase 1C: microtask queue + Promise.then chained-resolution (follow-up to #1326 Phase 1B)"
status: ready
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: async, promises
goal: standalone-mode
depends_on: [1326]
---
# #1326 Phase 1C — Microtask queue + Promise.then standalone

## Background

Phase 1B (PR #323) shipped:
- `$Promise` WasmGC struct registry
- `Promise.resolve(v)` / `Promise.reject(r)` standalone path (no JS host)
- Auto-enabled via `ctx.wasi === true`

Phase 1B intentionally left `emitMicrotaskEnqueue`, `emitDrainMicrotasks`,
and `emitStandalonePromiseThen` as throwing stubs. This issue tracks
their implementation.

## Constraint discovered during 1B implementation

The architect's original ~250 LoC estimate for Phase 1C
("microtask queue + Promise.then") **understated the difficulty of the
chained-resolution machinery**. Three concerns surfaced:

### 1. Closures aren't raw funcrefs

js2wasm's user-callbacks (`fn` in `.then(fn)`) are GC closure structs
(`__fn_wrap_N_struct { funcref, ...captures }`), routed through
`__make_callback` for host-callable interop. In WASI standalone mode
there's no host, so the queue must:
- Store the closure-struct ref (as externref or as a typed ref).
- At drain time, `ref.cast` back to a known closure-supertype struct,
  `struct.get $func`, then `call_ref` with `(closureRef, value)` as args.
- This is a **per-closure-signature dispatch problem**: `(closure, externref) → externref` is the
  generic shape, but each user lambda has its own underlying funcref
  signature, so the drain can't just call all callbacks uniformly.

### 2. Chained-resolution requires synthetic wrapper closures

`Promise.resolve(v).then(fn)` returns a NEW pending promise that must
transition to FULFILLED once `fn(v)` completes. To support this:
- Each `.then` call site must synthesise a wrapper closure
  `(value) → { let r = fn(value); chainedPromise.state = FULFILLED;
   chainedPromise.value = r; }`.
- The wrapper closure captures `fn` AND `chainedPromise`; it's
  registered as a Wasm function and stored in the queue.
- Acceptance criterion #2 (".then() chaining runs in correct microtask
  order") strictly requires this — without it, only the first .then's
  callback runs; subsequent .then calls see a still-pending promise
  and never resolve.

### 3. Multi-arity vs uniform-arity callbacks

The microtask queue can only practically hold uniform-shape entries.
Either:
- (a) ALL standalone .then callbacks have signature
  `(externref) → externref` (the value comes in as externref, the
  result goes out as externref); user lambdas of different arity get
  adapted by per-call-site wrappers.
- (b) The queue stores both the callback shape AND the arg shape; the
  drain dispatches via a `call_indirect` against a function table.

Approach (a) is simpler — mirrors how `__make_callback` already
unifies all JS-host callbacks to a single shape. Recommended.

## Strategy

### Part A: Microtask queue infrastructure (~150 LoC, low risk)

Module-level state, registered lazily on first `__microtask_enqueue` use:
- `(global $__microtask_head (mut i32) i32.const 0)` — drain pointer
- `(global $__microtask_tail (mut i32) i32.const 0)` — enqueue pointer
- `(global $__microtask_funcs (mut (ref null $arr_funcref)))` — funcref slots
- `(global $__microtask_args (mut (ref null $arr_externref)))` — externref args
- Initial capacity: `MICROTASK_QUEUE_INITIAL_SLOTS` from Phase 1A scaffold.

Wasm-defined helper functions:
- `__microtask_enqueue(fn: funcref, arg: externref) -> void`:
  - If tail+1 == head OR uninitialised: grow (or allocate initial).
  - `arr_funcs[tail] = fn; arr_args[tail] = arg; tail++`.
- `__drain_microtasks() -> void`:
  - While `head != tail`: pop `(fn, arg)`, advance head, `call_ref fn(arg)`.

### Part B: Promise.then standalone path (~250 LoC, hard)

For each `.then(fn)` call site in standalone mode:

1. Synthesise a per-site wrapper Wasm function `__then_wrapper_<N>` with
   signature `(externref value) -> externref`:
   ```
   (func $__then_wrapper_N (param $value externref) (result externref)
     ;; Captures: fn (closure ref), chainedPromise ($Promise ref)
     local.get $value
     ;; call closure: ref.cast $fn_closure_struct; struct.get $func; call_ref
     ;; result on stack as externref
     local.tee $result
     ;; chainedPromise.state = FULFILLED
     global.get $__chained_N
     i32.const 1
     struct.set $Promise $state
     ;; chainedPromise.value = result
     global.get $__chained_N
     local.get $result
     struct.set $Promise $value
     local.get $result
   )
   ```
2. At the `.then` call site:
   - Read `promise.state` from the receiver.
   - If FULFILLED: `__microtask_enqueue($__then_wrapper_N, promise.value)`,
     return the new chained promise (PENDING).
   - If REJECTED: pass-through (Phase 1C doesn't handle onRejected).
   - If PENDING: append wrapper to receiver's `$callbacks` field
     (requires Phase 1C-extra: upgrade `$Promise.callbacks` from
     placeholder externref to a typed `(ref null $vec_funcref)`).

### Part C: __drain_microtasks export + WASI _start integration (Phase 1D, ~150 LoC)

- Export `__drain_microtasks` so standalone callers can invoke after the
  top-level entry.
- For WASI target: synthesise `_start` that runs user main, then loops
  `__drain_microtasks` until the queue is empty.

## Acceptance criteria

1. `await Promise.resolve(42)` returns `42` in standalone mode after
   `__drain_microtasks()`.
2. `.then()` chaining executes in correct microtask order:
   `Promise.resolve(1).then(x => x + 1).then(x => x * 2)` after drain
   yields 4.
3. Rejection propagates: `Promise.reject('err').then(_, reason => reason)`
   yields the rejection reason.
4. `tests/issue-1326.test.ts` extended with chaining tests in WASI mode.

## Files

- `src/codegen/async-scheduler.ts` — fill in `emitMicrotaskEnqueue`,
  `emitDrainMicrotasks`, `emitStandalonePromiseThen` real bodies +
  helper-func registration.
- `src/codegen/expressions/calls.ts` — wire `Promise.then` standalone
  path (gated on `isStandalonePromiseActive(ctx)`).
- `src/codegen/declarations.ts` — skip `Promise_then` host import
  pre-registration in WASI mode.
- `tests/issue-1326.test.ts` — extend with .then chaining tests.

## Why this is harder than the original spec estimated

The architect's spec at `1326-async-microtask-queue-wasm-scheduler.md`
described funcref→i32 table machinery as "trickiest bit". After Phase 1B
implementation experience, the actual hardest piece is the **chained-
resolution wrapper closure synthesis**, not the table machinery.
Reusing `__make_callback`'s funcref-id handling doesn't help when
`__make_callback` itself isn't available in WASI mode.

The architect should re-read this constraint section before estimating
Phase 1C subtasks.
