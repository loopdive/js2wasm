// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Regression tests for #1198 — pre-size dense arrays at allocation site.
//
// The codegen detects the canonical fill pattern
//   const arr = []; for (let i = 0; i < N; i++) arr[i] = pureExpr;
// and pre-sizes both the WasmGC backing array AND vec.length to N up
// front. Both literal and identifier loop bounds are supported. The
// matcher is conservative: bodies that could throw, references to
// `arr` outside the indexed write, and non-canonical loop shapes all
// fall back to the existing grow-on-write path.
//
// These tests verify behavioural equivalence (matching cases produce
// the same array contents and length as the unoptimised path; non-
// matching cases still work because they fall back). The performance
// win is tracked by the competitive benchmark and is out of scope here.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileAndRun(source: string, fnName: string, args: ReadonlyArray<number>): Promise<unknown> {
  // Compile as JS so empty `[]` initializers don't get inferred as `never[]`
  // by the strict TS checker — matches the canonical `array-sum.js` shape
  // the issue motivates.
  const r = compile(source, { fileName: "t.js", allowJs: true });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports);
  const fn = instance.exports[fnName] as (...a: number[]) => unknown;
  return fn(...args);
}

describe("#1198 — pre-size dense arrays at allocation site", () => {
  describe("matching patterns (pre-size triggers)", () => {
    it("(a) parameter-bound fill returns correct length", async () => {
      const source = `
        export function run(n) {
          const a = [];
          for (let i = 0; i < n; i++) {
            a[i] = i * 2;
          }
          return a.length;
        }
      `;
      expect(await compileAndRun(source, "run", [10])).toBe(10);
      expect(await compileAndRun(source, "run", [0])).toBe(0);
      expect(await compileAndRun(source, "run", [1000])).toBe(1000);
    });

    it("(b) parameter-bound fill returns correct slot values", async () => {
      const source = `
        export function run(n) {
          const a = [];
          for (let i = 0; i < n; i++) {
            a[i] = i * 2;
          }
          let sum = 0;
          for (let j = 0; j < n; j++) {
            sum = sum + a[j];
          }
          return sum;
        }
      `;
      // Sum of i*2 for i in 0..9 = 2*(0+1+…+9) = 90
      expect(await compileAndRun(source, "run", [10])).toBe(90);
      // Sum of i*2 for i in 0..99 = 2*(99*100/2) = 9900
      expect(await compileAndRun(source, "run", [100])).toBe(9900);
    });

    it("(c) literal-bound fill — original #1001 push pattern's static-N cousin", async () => {
      const source = `
        export function run() {
          const a = [];
          for (let i = 0; i < 100; i++) {
            a[i] = i + 1;
          }
          return a[99];
        }
      `;
      expect(await compileAndRun(source, "run", [])).toBe(100);
    });

    it("(d) array-sum benchmark shape — bitwise body", async () => {
      const source = `
        export function run(n) {
          const values = [];
          for (let i = 0; i < n; i++) {
            values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
          }
          let sum = 0;
          for (let j = 0; j < n; j++) {
            sum = (sum + values[j]) | 0;
          }
          return sum | 0;
        }
      `;
      // Same shape as benchmarks/competitive/programs/array-sum.js. The
      // important property is that the IR-claim path and the legacy
      // path produce identical results — we can't test that here, but
      // we can at least verify the result is deterministic.
      const v10 = await compileAndRun(source, "run", [10]);
      // For n=10, manually computed:
      //   i=0:  0  ^ 0 & 1023 = 0
      //   i=1:  17 ^ 0 & 1023 = 17
      //   i=2:  34 ^ 0 & 1023 = 34
      //   i=3:  51 ^ 0 & 1023 = 51
      //   i=4:  68 ^ 0 & 1023 = 68
      //   i=5:  85 ^ 0 & 1023 = 85
      //   i=6:  102 ^ 0 & 1023 = 102
      //   i=7:  119 ^ 0 & 1023 = 119
      //   i=8:  136 ^ 1 & 1023 = 137
      //   i=9:  153 ^ 1 & 1023 = 152
      // sum = 0+17+34+51+68+85+102+119+137+152 = 765
      expect(v10).toBe(765);
    });
  });

  describe("non-matching patterns (fall back to grow-on-write)", () => {
    it("(e) reading arr.length inside the body inhibits pre-size", async () => {
      const source = `
        export function run(n) {
          const a = [];
          for (let i = 0; i < n; i++) {
            a[i] = a.length;
          }
          return a[5];
        }
      `;
      // a.length grows-as-you-go: at iteration 5, a.length === 5 (a[0..4]
      // already filled). Pre-sizing would make a.length === n on the very
      // first iteration, so a[5] would equal n (10) instead of 5.
      // The matcher rejects this shape, so behaviour is the grow-on-write
      // value.
      expect(await compileAndRun(source, "run", [10])).toBe(5);
    });

    it("(f) two-statement body inhibits pre-size", async () => {
      // Body has a write followed by a no-op statement — the matcher
      // rejects "more than one statement" before even inspecting them,
      // so the pattern falls back to grow-on-write for the indexed
      // write. The matcher's job is to stay conservative, not to be
      // clever about which extra statements are safe.
      const source = `
        export function run(n) {
          const a = [];
          for (let i = 0; i < n; i++) {
            a[i] = i;
            let unused = i;
          }
          return a.length;
        }
      `;
      // a[0..n-1] are filled by grow-on-write; final length === n.
      expect(await compileAndRun(source, "run", [5])).toBe(5);
    });

    it("(g) non-canonical loop shape (while) inhibits pre-size", async () => {
      const source = `
        export function run(n) {
          const a = [];
          let i = 0;
          while (i < n) {
            a[i] = i;
            i = i + 1;
          }
          return a.length;
        }
      `;
      expect(await compileAndRun(source, "run", [5])).toBe(5);
    });

    it("(h) writing to a different index than loopVar inhibits pre-size", async () => {
      const source = `
        export function run(n) {
          const a = [];
          for (let i = 0; i < n; i++) {
            a[i + 1] = i;
          }
          return a.length;
        }
      `;
      // Writes go to index 1..n; a.length = n+1 in grow-on-write mode.
      expect(await compileAndRun(source, "run", [5])).toBe(6);
    });
  });
});
