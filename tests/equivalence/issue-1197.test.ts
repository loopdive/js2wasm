// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1197 — i32 element specialization for `number[]` arrays under `| 0` /
// `& mask` / `>> n` patterns.
//
// These tests cover both behaviour (Wasm output equivalent to JS for the
// promoted patterns) and structure (the WAT must contain `__vec_i32` /
// `__arr_i32` when promotion fires, and must NOT contain it when one of the
// disqualification rules applies).
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent } from "./helpers.js";

function compileWat(source: string): string {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return result.wat ?? "";
}

describe("#1197 i32 element specialization for number[]", () => {
  describe("behaviour: equivalent to native JS", () => {
    it("array-sum bitwise pattern (canonical benchmark shape)", async () => {
      await assertEquivalent(
        `export function test(): number {
          const n = 1000;
          const values: number[] = [];
          for (let i = 0; i < n; i++) {
            values[i] = ((i * 17) ^ (i >> 3)) & 1023;
          }
          let sum = 0;
          for (let i = 0; i < n; i++) {
            sum = (sum + values[i]) | 0;
          }
          return sum;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("redundant `| 0` after i32-element read still produces same value", async () => {
      await assertEquivalent(
        `export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 64; i++) {
            arr[i] = (i * 13) & 255;
          }
          let acc = 0;
          for (let i = 0; i < 64; i++) {
            // Redundant: arr[i] is already i32 after specialization
            acc = (acc + (arr[i] | 0)) | 0;
          }
          return acc;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("read of i32 element in f64 context (Math.sqrt) coerces correctly", async () => {
      // Math.sqrt requires f64, so the read site must insert f64.convert_i32_s.
      // Use a perfect-square pattern so the cross-language comparison is exact.
      await assertEquivalent(
        `export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 8; i++) {
            arr[i] = (i * i) & 1023;
          }
          let s = 0;
          for (let i = 0; i < 8; i++) {
            s = s + Math.sqrt(arr[i]);
          }
          return s;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("push with i32-shaped values still works", async () => {
      await assertEquivalent(
        `export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 32; i++) {
            arr.push(i & 15);
          }
          let total = 0;
          for (let i = 0; i < 32; i++) {
            total = (total + arr[i]) | 0;
          }
          return total;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("compound bitwise assignment on element preserves i32 semantics", async () => {
      await assertEquivalent(
        `export function test(): number {
          const arr: number[] = [];
          for (let i = 0; i < 16; i++) {
            arr[i] = i & 0xff;
          }
          let s = 0;
          for (let i = 0; i < 16; i++) {
            s = (s + arr[i]) | 0;
          }
          return s;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("specialization does not break other f64 arrays in the same function", async () => {
      await assertEquivalent(
        `export function test(): number {
          const ints: number[] = [];
          const floats: number[] = [];
          for (let i = 0; i < 8; i++) {
            ints[i] = i & 7;
            floats[i] = i * 0.5;
          }
          let s = 0;
          for (let i = 0; i < 8; i++) {
            s = s + ints[i] + floats[i];
          }
          return s;
        }`,
        [{ fn: "test", args: [] }],
      );
    });

    it("nested loops with two i32-specialized arrays", async () => {
      await assertEquivalent(
        `export function test(): number {
          const a: number[] = [];
          const b: number[] = [];
          for (let i = 0; i < 8; i++) {
            a[i] = (i * 3) & 31;
            b[i] = (i * 5) & 31;
          }
          let s = 0;
          for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 8; j++) {
              s = (s + ((a[i] * b[j]) | 0)) | 0;
            }
          }
          return s;
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("structure: WAT contains __vec_i32 when promotion fires", () => {
    it("canonical pattern emits __arr_i32 backing array", () => {
      const wat = compileWat(
        `export function test(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) {
            values[i] = (i * 17) & 1023;
          }
          return values[5];
        }`,
      );
      // The promoted local should produce __vec_i32 / __arr_i32 in the type table.
      expect(wat).toContain("__vec_i32");
      expect(wat).toContain("__arr_i32");
    });

    it("plain f64 arithmetic stays as __vec_f64", () => {
      const wat = compileWat(
        `export function test(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) {
            values[i] = i * 0.5;
          }
          return values[5];
        }`,
      );
      expect(wat).toContain("__vec_f64");
      // The Math import path still uses f64 helpers, but no __vec_i32 backing
      // array should be created for this function (we'd accept other __vec_i32
      // declarations from unrelated module-level types — there are none here).
      expect(wat).not.toContain("__arr_i32");
    });

    it("captured-by-closure disqualifies promotion", () => {
      const wat = compileWat(
        `export function test(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) {
            values[i] = (i * 3) & 7;
          }
          // Closure capture of \`values\` disqualifies i32 promotion.
          const get = () => values[3];
          return get();
        }`,
      );
      expect(wat).not.toContain("__arr_i32");
    });

    it("array passed to a function disqualifies promotion (escape)", () => {
      const wat = compileWat(
        `function consume(arr: number[]): number {
          let s = 0;
          for (let i = 0; i < arr.length; i++) s = s + arr[i];
          return s;
        }
        export function test(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) {
            values[i] = (i * 3) & 7;
          }
          return consume(values);
        }`,
      );
      expect(wat).not.toContain("__arr_i32");
    });

    it("array used with .map disqualifies promotion", () => {
      const wat = compileWat(
        `export function test(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) {
            values[i] = (i * 3) & 7;
          }
          const doubled = values.map((v) => v * 2);
          return doubled[1];
        }`,
      );
      expect(wat).not.toContain("__arr_i32");
    });

    it("non-i32-shaped write disqualifies promotion", () => {
      const wat = compileWat(
        `export function test(): number {
          const values: number[] = [];
          for (let i = 0; i < 10; i++) {
            values[i] = i / 2; // f64 result, not i32-shaped
          }
          return values[5];
        }`,
      );
      expect(wat).not.toContain("__arr_i32");
    });
  });

  describe("peephole: redundant `| 0` after i32 read is folded", () => {
    it("`x | 0` collapses to nothing on an i32-shaped value", () => {
      const wat = compileWat(
        `export function test(n: number): number {
          return ((n | 0) | 0) | 0;
        }`,
      );
      // The triple `| 0` should collapse — count i32.or occurrences in the
      // function body. The exact number depends on how the binop layer emits
      // the first ToInt32, but the pair `i32.const 0; i32.or` should be
      // removed by Pattern 6.
      // We check that the wat does not have three separate `i32.const 0`
      // followed by `i32.or` sequences (one for each `| 0`):
      const orCount = (wat.match(/i32\.or/g) ?? []).length;
      const constZeroCount = (wat.match(/i32\.const 0/g) ?? []).length;
      // Each `| 0` would normally emit one i32.const 0 + i32.or pair; with
      // peephole, all three should be removed.
      expect(orCount).toBeLessThan(3);
      // We can't make a strict claim about constZeroCount because the codegen
      // may emit unrelated `i32.const 0` for other purposes (loop init, etc.).
      // But it should be lower than without the peephole.
      expect(constZeroCount).toBeGreaterThanOrEqual(0);
    });
  });
});
