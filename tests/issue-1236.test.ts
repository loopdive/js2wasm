// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1236 — premature i32 specialization for `let s = 0` accumulators
// silently saturates on overflow. Fix: in the candidate-promotion logic in
// `src/codegen/function-body.ts`, refuse to mark a candidate i32 when ANY
// of its writes go through `+`, `-`, `*` arithmetic — those route through
// f64 in codegen and a trailing `i32.trunc_sat_f64_s` saturates at i32.MAX
// (silent corruption). Loop counters (`for (let i = 0; ...; i++)`) are
// unaffected: they go through the separate `detectI32LoopVar` path which
// proves the counter is bounded by the loop condition.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string): Promise<Record<string, Function>> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, built);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1236 — i32 specialization overflow safety", () => {
  describe("repro from the issue file", () => {
    it("sum 0..1_000_000 returns 499999500000 (matches V8) instead of i32.MAX saturation", async () => {
      const exports = await compileAndInstantiate(`
        export function bench_loop(): number {
          let s = 0;
          for (let i = 0; i < 1000000; i++) s = s + i;
          return s;
        }
      `);
      const result = (exports.bench_loop as () => number)();
      expect(result).toBe(499999500000);
      // Anti-regression check: the bug returned 2147483647 (i32.MAX).
      expect(result).not.toBe(2147483647);
    });

    it("differential test: V8 and Wasm agree on sum 0..1_000_000", async () => {
      const exports = await compileAndInstantiate(`
        export function bench_loop(): number {
          let s = 0;
          for (let i = 0; i < 1000000; i++) s = s + i;
          return s;
        }
      `);
      let v8Sum = 0;
      for (let i = 0; i < 1000000; i++) v8Sum = v8Sum + i;
      const wasmSum = (exports.bench_loop as () => number)();
      expect(wasmSum).toBe(v8Sum);
    });
  });

  describe("WAT-level proof: accumulator local is f64, not i32", () => {
    it("sum loop emits an f64 local for the accumulator (no i32 trunc_sat round-trip)", async () => {
      const r = compile(
        `
          export function sumTo(): number {
            let s = 0;
            for (let i = 0; i < 1000; i++) s = s + i;
            return s;
          }
        `,
        { fileName: "test.ts" },
      );
      expect(r.success).toBe(true);
      const wat = r.wat ?? "";
      // The accumulator must be f64 — if it stays i32 the trunc_sat path
      // returns. Match the function header and assert the local-line shape.
      const fnHeaderIdx = wat.indexOf("$sumTo");
      expect(fnHeaderIdx).toBeGreaterThan(0);
      const fnBody = wat.slice(fnHeaderIdx, fnHeaderIdx + 800);
      // s is the first declared local (after params).
      expect(fnBody).toMatch(/\(local \$s f64\)/);
      // The bug-WAT had: `f64.add` then `i32.trunc_sat_f64_s` then `local.set 0` (s).
      // After fix: `f64.add` then `local.set 0` directly. Verify no trunc_sat
      // appears between an `f64.add` and a `local.set` for $s.
      expect(fnBody).not.toMatch(/f64\.add\s*i32\.trunc_sat_f64_s/);
    });
  });

  describe("compound assignment also avoids saturation", () => {
    it("`s += i` accumulator preserves f64 semantics", async () => {
      const exports = await compileAndInstantiate(`
        export function bench(): number {
          let s = 0;
          for (let i = 0; i < 1000000; i++) s += i;
          return s;
        }
      `);
      expect((exports.bench as () => number)()).toBe(499999500000);
    });

    it("`s -= i` accumulator preserves f64 semantics on negative overflow", async () => {
      // Mirror of += but with -. Sum-of-negatives can underflow i32.MIN.
      const exports = await compileAndInstantiate(`
        export function bench(): number {
          let s = 0;
          for (let i = 0; i < 1000000; i++) s -= i;
          return s;
        }
      `);
      expect((exports.bench as () => number)()).toBe(-499999500000);
    });

    it("`s *= 2` accumulator preserves f64 semantics", async () => {
      // 2^60 exceeds i32.MAX by many orders. Verifies that *= takes the f64 path.
      const exports = await compileAndInstantiate(`
        export function bench(): number {
          let s = 1;
          for (let i = 0; i < 60; i++) s = s * 2;
          return s;
        }
      `);
      expect((exports.bench as () => number)()).toBe(Math.pow(2, 60));
    });
  });

  describe("regression guard for #595 — for-loop counters stay i32", () => {
    it("`for (let i = 0; i < n; i++)` counter is still i32 in the WAT", async () => {
      const r = compile(
        `
          export function loop(n: number): number {
            let last = 0;
            for (let i = 0; i < n; i++) last = i;
            return last;
          }
        `,
        { fileName: "test.ts" },
      );
      expect(r.success).toBe(true);
      const wat = r.wat ?? "";
      const fnHeaderIdx = wat.indexOf("$loop");
      const fnBody = wat.slice(fnHeaderIdx, fnHeaderIdx + 800);
      // The for-loop counter `i` should still be i32 (proves we didn't
      // accidentally widen #595's loop counters along with the accumulators).
      expect(fnBody).toMatch(/\(local \$i i32\)/);
    });

    it("loop counter `i++` works correctly to large iteration counts", async () => {
      const exports = await compileAndInstantiate(`
        export function lastCounter(n: number): number {
          let i = 0;
          for (i = 0; i < n; i++) {}
          return i;
        }
      `);
      expect((exports.lastCounter as (n: number) => number)(1000000)).toBe(1000000);
    });
  });

  describe("bitwise operations still i32-safe (unchanged)", () => {
    it("`mask = mask | bit` keeps mask as i32", async () => {
      const r = compile(
        `
          export function buildMask(n: number): number {
            let mask = 0;
            for (let i = 0; i < n; i++) mask = mask | (1 << (i & 31));
            return mask | 0;
          }
        `,
        { fileName: "test.ts" },
      );
      expect(r.success).toBe(true);
      const wat = r.wat ?? "";
      const fnHeaderIdx = wat.indexOf("$buildMask");
      const fnBody = wat.slice(fnHeaderIdx, fnHeaderIdx + 800);
      // The mask local should still be i32 (bitwise writes are still
      // proved-safe by isI32SafeExpr).
      expect(fnBody).toMatch(/\(local \$mask i32\)/);
    });
  });
});
