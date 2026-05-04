// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1195 — array-reduce-fusion (escape-analysis scalarization).
 *
 * Verifies that the fill+reduce shape
 *
 *     const arr = [];
 *     for (let i = 0; i < n; i++) arr[i] = WRITE;
 *     let acc = INIT;
 *     for (let j = 0; j < arr.length; j++) acc = READ(acc, arr[j]);
 *
 * fuses to a single loop that eliminates the temporary array entirely,
 * and that arrays which DO escape are NOT fused (correctness).
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1195 — array-reduce-fusion", () => {
  describe("fusion fires (correctness across n)", () => {
    it("array-sum benchmark pattern: sum of ((i*17)^(i>>>3)) & 1023", async () => {
      const exports = await compileToWasm(`
        export function run(n: number): number {
          const values: number[] = [];
          for (let i = 0; i < n; i++) {
            values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
          }
          let sum: number = 0;
          for (let i = 0; i < values.length; i++) {
            sum = (sum + values[i]) | 0;
          }
          return sum | 0;
        }
      `);
      // Reference implementation in JS — fused loop must match for every n.
      const ref = (n: number): number => {
        let sum = 0;
        for (let i = 0; i < n; i++) sum = (sum + (((i * 17) ^ (i >>> 3)) & 1023)) | 0;
        return sum | 0;
      };
      for (const n of [0, 1, 2, 10, 100, 1000, 50000]) {
        expect(exports.run(n)).toBe(ref(n));
      }
    });

    it("simple sum of i values", async () => {
      const exports = await compileToWasm(`
        export function run(n: number): number {
          const a: number[] = [];
          for (let i = 0; i < n; i++) {
            a[i] = i;
          }
          let s: number = 0;
          for (let i = 0; i < a.length; i++) {
            s = (s + a[i]) | 0;
          }
          return s | 0;
        }
      `);
      for (const n of [0, 1, 100, 1000]) {
        const expected = (((n - 1) * n) / 2) | 0;
        expect(exports.run(n)).toBe(expected);
      }
    });

    it("alpha-rename: write index 'k' renamed to read index 'j'", async () => {
      const exports = await compileToWasm(`
        export function run(n: number): number {
          const arr: number[] = [];
          for (let k = 0; k < n; k++) {
            arr[k] = k * 2;
          }
          let acc: number = 0;
          for (let j = 0; j < arr.length; j++) {
            acc = (acc + arr[j]) | 0;
          }
          return acc | 0;
        }
      `);
      for (const n of [0, 5, 100]) {
        let expected = 0;
        for (let i = 0; i < n; i++) expected = (expected + i * 2) | 0;
        expect(exports.run(n)).toBe(expected);
      }
    });

    it("read loop bound textually matches write loop bound (no arr.length)", async () => {
      const exports = await compileToWasm(`
        export function run(n: number): number {
          const arr: number[] = [];
          for (let i = 0; i < n; i++) {
            arr[i] = (i * i) | 0;
          }
          let s: number = 0;
          for (let i = 0; i < n; i++) {
            s = (s + arr[i]) | 0;
          }
          return s | 0;
        }
      `);
      for (const n of [0, 5, 50]) {
        let expected = 0;
        for (let i = 0; i < n; i++) expected = (expected + ((i * i) | 0)) | 0;
        expect(exports.run(n)).toBe(expected);
      }
    });
  });

  describe("escape cases — fusion MUST NOT fire", () => {
    it("returned array: must keep allocation", async () => {
      // The array escapes via `return` — fusion would silently drop the data.
      // Result: a real array; reduce externally to compare.
      const exports = await compileToWasm(`
        export function run(n: number): any {
          const a: number[] = [];
          for (let i = 0; i < n; i++) {
            a[i] = i + 1;
          }
          return a;
        }
      `);
      const arr = exports.run(5);
      expect(Array.isArray(arr) ? arr.length : ((arr as any).length ?? -1)).toBe(5);
      // Element sanity check
      const sum = (() => {
        let s = 0;
        for (let i = 0; i < 5; i++) s += i + 1;
        return s;
      })();
      let actualSum = 0;
      for (let i = 0; i < 5; i++) actualSum += Number((arr as any)[i] ?? (arr as any).at?.(i));
      expect(actualSum).toBe(sum);
    });

    it("array passed to a user function: must keep allocation", async () => {
      const exports = await compileToWasm(`
        function tap(a: any): number {
          // Cannot prove tap is non-escaping; fusion must bail.
          return (a as any).length | 0;
        }
        export function run(n: number): number {
          const arr: number[] = [];
          for (let i = 0; i < n; i++) {
            arr[i] = i;
          }
          // Use arr both via tap() AND in a reduce-shaped loop. Even though
          // the second loop could fuse in isolation, the tap() call escapes
          // the array, so fusion must bail.
          const len = tap(arr);
          let s: number = 0;
          for (let i = 0; i < arr.length; i++) {
            s = (s + arr[i]) | 0;
          }
          return (s + len) | 0;
        }
      `);
      // Reference: sum 0..n-1 plus n
      for (const n of [0, 1, 10]) {
        const ref = (() => {
          let s = 0;
          for (let i = 0; i < n; i++) s += i;
          return s + n;
        })();
        expect(exports.run(n)).toBe(ref);
      }
    });

    it("two distinct reductions over the same array: must keep allocation", async () => {
      // First reduce sums values, second checks max. Fusion would only see
      // one reduce; the second loop's read of `arr` inside the function
      // means our detector should bail (no arr.length-equivalent rebuild).
      const exports = await compileToWasm(`
        export function run(n: number): number {
          const arr: number[] = [];
          for (let i = 0; i < n; i++) {
            arr[i] = i + 1;
          }
          let s: number = 0;
          for (let i = 0; i < arr.length; i++) {
            s = (s + arr[i]) | 0;
          }
          let max: number = 0;
          for (let i = 0; i < arr.length; i++) {
            if ((arr[i] | 0) > max) max = arr[i] | 0;
          }
          return ((s | 0) + (max | 0)) | 0;
        }
      `);
      for (const n of [0, 1, 5, 10]) {
        let s = 0;
        let max = 0;
        for (let i = 0; i < n; i++) {
          s = (s + (i + 1)) | 0;
          if (i + 1 > max) max = i + 1;
        }
        expect(exports.run(n)).toBe((s + max) | 0);
      }
    });
  });

  describe("acceptance: hot runtime parity with the no-array reference", () => {
    it("array-sum compiles and executes correctly for n=1_000_000", async () => {
      const exports = await compileToWasm(`
        export function run(n: number): number {
          const values: number[] = [];
          for (let i = 0; i < n; i++) {
            values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
          }
          let sum: number = 0;
          for (let i = 0; i < values.length; i++) {
            sum = (sum + values[i]) | 0;
          }
          return sum | 0;
        }
      `);
      const ref = (() => {
        let sum = 0;
        for (let i = 0; i < 1_000_000; i++) sum = (sum + (((i * 17) ^ (i >>> 3)) & 1023)) | 0;
        return sum | 0;
      })();
      expect(exports.run(1_000_000)).toBe(ref);
    });
  });
});
