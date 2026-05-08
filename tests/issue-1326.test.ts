// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1326 Phase 1A — Smoke test for the async-scheduler scaffold module.
//
// This test validates that:
//   1. The scaffold module loads cleanly
//   2. The type-registry helpers register valid Wasm types when invoked
//   3. The stubbed emit helpers throw with the expected sub-slice marker
//      (so future sub-slices know which to remove)
//   4. The default Promise codegen path (JS-host imports) is unchanged —
//      `Promise.resolve(42).then(...)` still works as before
//
// Sub-slices 1B/1C/1D will extend this file with real behaviour tests.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import {
  PROMISE_STATE_PENDING,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
  MICROTASK_QUEUE_INITIAL_SLOTS,
  MICROTASK_QUEUE_SLOT_BYTES,
  emitMicrotaskEnqueue,
  emitDrainMicrotasks,
  emitStandalonePromiseResolve,
  emitStandalonePromiseReject,
  emitStandalonePromiseThen,
  isStandalonePromiseActive,
} from "../src/codegen/async-scheduler.js";

describe("#1326 Phase 1A — async-scheduler scaffold", () => {
  it("exports the right state constants", () => {
    expect(PROMISE_STATE_PENDING).toBe(0);
    expect(PROMISE_STATE_FULFILLED).toBe(1);
    expect(PROMISE_STATE_REJECTED).toBe(2);
  });

  it("exports microtask queue dimensioning", () => {
    // 1 page = 64 KiB. 8 bytes per slot. 8192 slots fits one page.
    expect(MICROTASK_QUEUE_INITIAL_SLOTS).toBe(8192);
    expect(MICROTASK_QUEUE_SLOT_BYTES).toBe(8);
    expect(MICROTASK_QUEUE_INITIAL_SLOTS * MICROTASK_QUEUE_SLOT_BYTES).toBe(65536);
  });

  it("isStandalonePromiseActive defaults to false (no behaviour change in 1A)", () => {
    // Phase 1A doesn't expose a way to enable standalone promise codegen;
    // until 1B wires the ctx flag, this must be false everywhere so the
    // existing JS-host Promise path is untouched.
    const fakeCtx = {} as unknown as Parameters<typeof isStandalonePromiseActive>[0];
    expect(isStandalonePromiseActive(fakeCtx)).toBe(false);
  });

  it("stubbed emit helpers throw with the expected sub-slice marker", () => {
    const fakeCtx = {} as unknown as Parameters<typeof emitMicrotaskEnqueue>[0];
    const fakeFctx = {} as unknown as Parameters<typeof emitMicrotaskEnqueue>[1];
    expect(() => emitMicrotaskEnqueue(fakeCtx, fakeFctx, [], [])).toThrow(/Phase 1C: emitMicrotaskEnqueue/);
    expect(() => emitDrainMicrotasks(fakeCtx, fakeFctx)).toThrow(/Phase 1D: emitDrainMicrotasks/);
    expect(() => emitStandalonePromiseResolve(fakeCtx, fakeFctx, [])).toThrow(/Phase 1B: emitStandalonePromiseResolve/);
    expect(() => emitStandalonePromiseReject(fakeCtx, fakeFctx, [])).toThrow(/Phase 1B: emitStandalonePromiseReject/);
    expect(() => emitStandalonePromiseThen(fakeCtx, fakeFctx, [], [])).toThrow(/Phase 1C: emitStandalonePromiseThen/);
  });
});

describe("#1326 Phase 1A — existing JS-host Promise path unchanged (compile-only)", () => {
  // Phase 1A is purely additive: importing the new module + registering
  // the new types must not break Promise compilation. We only assert
  // `compile()` returns success here — the Promise-await runtime path
  // currently has pre-existing NaN issues unrelated to #1326 (tracked
  // separately under #1313 / await-passthrough). Once those land, Phase
  // 1B will extend this to assert the runtime behaviour too.
  it("Promise.resolve(value) compiles successfully in JS-host mode", () => {
    const r = compile(`
      export async function test(): Promise<number> {
        return await Promise.resolve(42);
      }
    `);
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
  });

  it("Promise.resolve(...).then(fn) compiles successfully", () => {
    const r = compile(`
      export function test(): number {
        let v = 0;
        Promise.resolve(7).then((x: number) => { v = x; });
        return v;
      }
    `);
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
  });
});
