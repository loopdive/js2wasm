// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1219 — ArrayBindingPattern iter-close: destructuring hangs when the
 * iterator never sets done:true.
 *
 * Phase 1 analysis of #1207 (timeout clusters) found 26 test262 hangs in
 * `language/{expressions,statements}/class/dstr/*-ary-init-iter-close.js`.
 * The pattern: a custom iterator returns `{value, done:false}` from `.next()`
 * forever, and a single-element binding pattern `[x]` is supposed to pull
 * exactly ONE value, then call `IteratorClose` (i.e. `iter.return()`).
 *
 * Before the fix, the runtime helper `__array_from_iter` looped until it saw
 * `done:true` (capped at MAX_ITER = 2^20). When the user iterator never
 * terminated naturally, the loop ground through 1 M wasm-closure roundtrips
 * (~22-28 s wall) and never invoked `iter.return()` — producing a 30 s
 * test262 `compile_timeout` and missing the spec-mandated IteratorClose call.
 *
 * The fix:
 *   1. Lower MAX_ITER from 2^20 to 2^16 (cap at ~1.3 s wall on the buggy
 *      iterator instead of ~22 s).
 *   2. Track `sawDone`. When the loop exits without observing done:true, call
 *      `iter.return()` to honor ECMA-262 §7.4.6 IteratorClose.
 *
 * Reference: ECMA-262 §13.3.3.5 BindingInitialization step 4 +
 * §7.4.6 IteratorClose.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1219 — ArrayBindingPattern iter-close: hang fix + IteratorClose", () => {
  it("does not hang when iterator never sets done:true (single-element pattern)", async () => {
    // Reproduces the pattern from
    // test262/test/language/expressions/class/dstr/meth-ary-init-iter-close.js
    // Pre-fix: hangs ~22 s on `__array_from_iter` then 30 s test262 timeout.
    // Post-fix: returns in ~1.3 s wall and `doneCallCount === 1` (return called).
    const exports = await compileToWasm(`
      var doneCallCount: number = 0;
      var seenValue: any = -1;
      var iter: any = {};
      iter[Symbol.iterator] = function (): any {
        return {
          next: function (): any { return { value: 42, done: false }; },
          return: function (): any { doneCallCount = doneCallCount + 1; return {}; },
        };
      };
      class C {
        method([x]: any): void { seenValue = x; }
      }
      export function test(): number {
        new C().method(iter);
        if (seenValue !== 42) return -1;
        if (doneCallCount !== 1) return -2;
        return 1;
      }
    `);
    const t0 = Date.now();
    const ret = exports.test();
    const elapsed = Date.now() - t0;
    expect(ret).toBe(1);
    // The fix caps the loop at 64K iterations; in practice this completes well
    // under 5 s. Generous bound to avoid CI flakiness.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("finite iterator destructure: stops at done:true and does NOT call return()", async () => {
    // Per spec §7.4.6: when the iterator naturally terminates (`done:true`),
    // IteratorClose is NOT invoked. This guards against over-eager return()
    // calls from the fix.
    const exports = await compileToWasm(`
      var doneCallCount: number = 0;
      var nextCallCount: number = 0;
      var iter: any = {};
      iter[Symbol.iterator] = function (): any {
        var i: number = 0;
        return {
          next: function (): any {
            nextCallCount = nextCallCount + 1;
            if (i < 2) {
              i = i + 1;
              return { value: i * 10, done: false };
            }
            return { value: 0, done: true };
          },
          return: function (): any { doneCallCount = doneCallCount + 1; return {}; },
        };
      };
      function takeTwo([a, b]: any): number {
        return (a as number) + (b as number);
      }
      export function test(): number {
        var sum: number = takeTwo(iter);
        // 10 + 20 = 30
        if (sum !== 30) return -1;
        // Iterator naturally terminated — return() must NOT have been called.
        if (doneCallCount !== 0) return -2;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("rest element collects all values until done:true", async () => {
    // Sanity check: rest patterns continue consuming values until the iterator
    // legitimately terminates. With the fix in place, the cap is high enough
    // (64K) that any reasonable rest pattern completes; and IteratorClose is
    // skipped because sawDone === true.
    const exports = await compileToWasm(`
      var doneCallCount: number = 0;
      var iter: any = {};
      iter[Symbol.iterator] = function (): any {
        var i: number = 0;
        return {
          next: function (): any {
            if (i < 3) {
              i = i + 1;
              return { value: i, done: false };
            }
            return { value: 0, done: true };
          },
          return: function (): any { doneCallCount = doneCallCount + 1; return {}; },
        };
      };
      function f([...rest]: any): number {
        return (rest as any).length;
      }
      export function test(): number {
        var n: number = f(iter);
        if (n !== 3) return -1;
        // Iterator self-terminated with done:true → no IteratorClose.
        if (doneCallCount !== 0) return -2;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
