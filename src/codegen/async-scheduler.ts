// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1326 Phase 1A — Async standalone microtask queue + Promise GC struct.
//
// This module provides the foundation for running Promise/async code in
// standalone (WASI) mode without JS-host imports. The full Phase 1 is
// decomposed into 4 sub-slices (see issue file `## Implementation Plan`):
//
//   1A (this slice): scaffold + type-registry + stubbed emit helpers
//   1B: $Promise struct registry + Promise.resolve/reject standalone path
//   1C: Microtask queue (linear memory) + Promise.then standalone path
//   1D: __drain_microtasks export + WASI _start integration
//
// The throwing stubs in 1B-1D are intentional — they force explicit
// "what changed" review when each sub-slice removes the throw and emits
// real Wasm. This module exports nothing wired in 1A; existing JS-host
// Promise paths are unchanged.

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getOrRegisterArrayType } from "./registry/types.js";

/**
 * #1326 — Sentinel state values for `$Promise.state`. Match the JS spec
 * tri-state: pending → fulfilled (final), or pending → rejected (final).
 * State transitions other than from pending are illegal per spec and
 * silently ignored by Phase 1B's resolve/reject emit code.
 */
export const PROMISE_STATE_PENDING = 0;
export const PROMISE_STATE_FULFILLED = 1;
export const PROMISE_STATE_REJECTED = 2;

/**
 * #1326 — Default microtask queue capacity. One Wasm page is 64 KiB =
 * 65,536 bytes; with 8 bytes per slot (4-byte funcref-table idx + 4-byte
 * arg-vec idx for externref), one page = 8,192 slots. The queue grows
 * via `memory.grow` if it overflows; this default sizes the initial
 * allocation for typical async kernels.
 */
export const MICROTASK_QUEUE_INITIAL_SLOTS = 8192;
export const MICROTASK_QUEUE_SLOT_BYTES = 8;

/**
 * #1326 — Shared per-context state for the async scheduler. Cached on
 * `ctx.asyncScheduler` (created lazily on first access) so 1B/1C/1D
 * sub-slices can share the registered $Promise typeIdx + queue indices
 * without re-registering them.
 *
 * Phase 1A only fills `promiseTypeIdx` when `getOrRegisterPromiseType`
 * is called. The other fields stay null until Phase 1C wires the queue.
 */
export interface AsyncSchedulerState {
  /** $Promise WasmGC struct typeIdx, or -1 until registered */
  promiseTypeIdx: number;
  /** $microtask_args_arr (array externref) typeIdx, or -1 until registered */
  microtaskArgsArrTypeIdx: number;
}

function getOrInitState(ctx: CodegenContextWithScheduler): AsyncSchedulerState {
  if (!ctx.asyncScheduler) {
    ctx.asyncScheduler = { promiseTypeIdx: -1, microtaskArgsArrTypeIdx: -1 };
  }
  return ctx.asyncScheduler;
}

/**
 * Type cast for ctx augmentation. Phase 1A doesn't modify
 * `CodegenContext`; instead it stashes per-module state under
 * `ctx.asyncScheduler` (any-typed). Phase 1B+ promotes this to a
 * proper field if the integration matures.
 */
type CodegenContextWithScheduler = CodegenContext & { asyncScheduler?: AsyncSchedulerState };

/**
 * #1326 — Get or register the `$Promise` WasmGC struct type. The struct
 * has three fields:
 *   - state: i32 (0=pending, 1=fulfilled, 2=rejected)
 *   - value: externref (fulfilled value or rejection reason)
 *   - callbacks: externref (placeholder; Phase 1C upgrades to
 *     `(ref null $vec_funcref)` once the funcref-vec type is wired)
 *
 * Returns the registered struct's typeIdx, cached for re-use.
 */
export function getOrRegisterPromiseType(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.promiseTypeIdx !== -1) return state.promiseTypeIdx;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Promise",
    fields: [
      { name: "state", type: { kind: "i32" }, mutable: true },
      { name: "value", type: { kind: "externref" }, mutable: true },
      // Phase 1A placeholder. Phase 1C replaces with `(ref null $vec_funcref)`
      // after the funcref-vec type is registered. Until then, `then()`
      // callbacks aren't supported in standalone mode.
      { name: "callbacks", type: { kind: "externref" }, mutable: true },
    ],
  });
  // Mirror the bookkeeping that other struct registrations do so the
  // verifier/walker can find $Promise by name.
  ctx.structMap.set("$Promise", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "$Promise");
  ctx.structFields.set("$Promise", [
    { name: "state", type: { kind: "i32" as const }, mutable: true },
    { name: "value", type: { kind: "externref" as const }, mutable: true },
    { name: "callbacks", type: { kind: "externref" as const }, mutable: true },
  ]);
  state.promiseTypeIdx = typeIdx;
  return typeIdx;
}

/**
 * #1326 — Get or register the microtask-queue arg-vec type. Phase 1A
 * registers the WasmGC array type; Phase 1C will wire the linear-memory
 * queue head/tail globals + the funcref table that pairs with this
 * arg-vec.
 */
export function getOrRegisterMicrotaskQueueType(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.microtaskArgsArrTypeIdx !== -1) return state.microtaskArgsArrTypeIdx;
  // The queue's externref-args buffer is an array of externref slots.
  // Reuses the existing `__arr_externref` registration if present.
  const arrTypeIdx = getOrRegisterArrayType(ctx, "externref", { kind: "externref" });
  state.microtaskArgsArrTypeIdx = arrTypeIdx;
  return arrTypeIdx;
}

/**
 * #1326 Phase 1C stub — emit instructions to enqueue a microtask
 * `(funcRef, arg)` for later drain. Phase 1A throws to make sub-slice 1C
 * remove the throw as its first edit.
 */
export function emitMicrotaskEnqueue(
  _ctx: CodegenContext,
  _fctx: FunctionContext,
  _funcRefInstrs: Instr[],
  _argInstrs: Instr[],
): void {
  throw new Error("#1326 Phase 1C: emitMicrotaskEnqueue not yet implemented — see issue file's Implementation Plan");
}

/**
 * #1326 Phase 1D stub — emit instructions to drain the microtask queue
 * until empty. Phase 1A throws.
 */
export function emitDrainMicrotasks(_ctx: CodegenContext, _fctx: FunctionContext): void {
  throw new Error("#1326 Phase 1D: emitDrainMicrotasks not yet implemented — see issue file's Implementation Plan");
}

/**
 * #1326 Phase 1B stub — emit standalone-mode `Promise.resolve(value)`
 * as `struct.new $Promise (i32.const 1) (value) (ref.null extern)`.
 * Phase 1A throws.
 */
export function emitStandalonePromiseResolve(
  _ctx: CodegenContext,
  _fctx: FunctionContext,
  _valueInstrs: Instr[],
): void {
  throw new Error(
    "#1326 Phase 1B: emitStandalonePromiseResolve not yet implemented — see issue file's Implementation Plan",
  );
}

/**
 * #1326 Phase 1B stub — emit standalone-mode `Promise.reject(reason)`
 * as `struct.new $Promise (i32.const 2) (reason) (ref.null extern)`.
 * Phase 1A throws.
 */
export function emitStandalonePromiseReject(
  _ctx: CodegenContext,
  _fctx: FunctionContext,
  _reasonInstrs: Instr[],
): void {
  throw new Error(
    "#1326 Phase 1B: emitStandalonePromiseReject not yet implemented — see issue file's Implementation Plan",
  );
}

/**
 * #1326 Phase 1C stub — emit standalone-mode `promise.then(fn)`.
 * If promise is fulfilled: enqueue `fn(value)` as microtask + return a
 * chained pending promise. If pending: append `fn` to callbacks vec.
 * Phase 1A throws.
 */
export function emitStandalonePromiseThen(
  _ctx: CodegenContext,
  _fctx: FunctionContext,
  _promiseInstrs: Instr[],
  _fnInstrs: Instr[],
): void {
  throw new Error(
    "#1326 Phase 1C: emitStandalonePromiseThen not yet implemented — see issue file's Implementation Plan",
  );
}

/**
 * #1326 — Check whether standalone-mode Promise codegen is active.
 * Auto-enables in WASI target mode (the JS host imports for Promise are
 * unavailable); opt-in elsewhere via a flag. Sub-slices 1B-1D consult
 * this to decide between host-import and Wasm-native Promise codegen.
 *
 * Currently always returns `false` because Phase 1A doesn't expose the
 * opt-in flag; Phase 1B+ adds the proper context field gate. Keeping
 * this as a stub means existing JS-host paths are guaranteed unchanged.
 */
export function isStandalonePromiseActive(_ctx: CodegenContext): boolean {
  // Phase 1A: always false. Phase 1B+ wires `ctx.target === "wasi"` or
  // an explicit `ctx.standalonePromise === true` flag.
  return false;
}
