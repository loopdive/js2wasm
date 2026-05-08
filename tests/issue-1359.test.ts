// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1359 — Array.prototype.concat: bail to host bridge when the typed fast path
// can't safely handle the call shape.
//
// The typed fast path in `compileArrayConcat` was previously emitting a
// `struct.get` / `ref.cast` against the arg using the receiver's vec type.
// That trapped at runtime when:
//   - the arg's vec type differed from the receiver's (e.g. `[].concat([1,2])`
//     — receiver inferred as `__vec_externref`, arg as `__vec_f64`).
//   - there were 2+ args (typed path only handled a single arg).
//
// Both cases now route through `compileArrayConcatExtern` which calls
// `Array.prototype.concat` via the host bridge — handles variadic args,
// IsConcatSpreadable, and mixed element types correctly per spec §23.1.3.2.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndCall<T>(src: string, fnName = "test"): Promise<T> {
  const r = compile(src, { fileName: "test.ts" });
  const errs = r.errors.filter((e) => e.severity === "error");
  if (errs.length) {
    throw new Error(`compile failed: ${errs.map((e) => `L${e.line}:${e.column} ${e.message}`).join(" | ")}`);
  }
  const env = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, env);
  if (env.setExports) env.setExports(instance.exports as Record<string, Function>);
  const fn = (instance.exports as Record<string, () => T>)[fnName]!;
  return fn();
}

describe("issue #1359 — Array.concat fast-path safety", () => {
  describe("vec-type-mismatch falls back to host bridge", () => {
    it("[].concat([1, 2]) returns length 2 (no illegal cast)", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var item: number[] = [1, 2];
          var result: number[] = [].concat(item);
          return result.length;
        }`,
      );
      expect(ret).toBe(2);
    });

    it("([] as number[]).concat([1, 2]) returns length 2", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var nums: number[] = [10, 20];
          var result: any[] = ([] as any[]).concat(nums);
          return result.length;
        }`,
      );
      expect(ret).toBe(2);
    });
  });

  describe("multi-arg concat falls back to host bridge", () => {
    it("[1,2].concat([3,4], [5]) returns length 5", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var a: number[] = [1, 2];
          var b: number[] = [3, 4];
          var c: number[] = [5];
          var result = a.concat(b, c);
          return result.length;
        }`,
      );
      expect(ret).toBe(5);
    });

    it("[].concat([1], [2], [3]) returns length 3", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var a: number[] = [1];
          var b: number[] = [2];
          var c: number[] = [3];
          var result = ([] as number[]).concat(a, b, c);
          return result.length;
        }`,
      );
      expect(ret).toBe(3);
    });
  });

  describe("single-arg same-vec-type takes the fast path (no regression)", () => {
    it("[1, 2].concat([3, 4]) returns length 4", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var a: number[] = [1, 2];
          var b: number[] = [3, 4];
          var result = a.concat(b);
          return result.length;
        }`,
      );
      expect(ret).toBe(4);
    });

    it("[1, 2].concat([3, 4]) preserves elements", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var a: number[] = [1, 2];
          var b: number[] = [10, 20];
          var result = a.concat(b);
          // sum elements as a checksum
          var s = 0;
          for (var i = 0; i < result.length; i++) s = s + result[i];
          return s;
        }`,
      );
      expect(ret).toBe(33); // 1 + 2 + 10 + 20
    });
  });
});
