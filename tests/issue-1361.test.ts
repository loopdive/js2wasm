// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1361 — Array.prototype.sort comparator validation.
//
// Spec §23.1.3.30 step 1 mandates that a non-callable comparator (other than
// undefined) throws TypeError before any sort work begins. The compiler now
// emits an early TypeError throw when the comparator argument is known
// statically to be non-callable (null, number, string, boolean).
//
// `undefined` is explicitly allowed as "no comparator" (default ToString
// ordering). Default ordering correctness is out-of-scope here — tracked
// in the larger #1361 plan items (B + C).

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

describe("issue #1361 — Array.prototype.sort comparator validation", () => {
  describe("non-callable comparator throws TypeError", () => {
    it("sort(null) throws TypeError", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          var caught = 0;
          try {
            arr.sort(null);
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });

    it("sort(42) throws TypeError", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          var caught = 0;
          try {
            arr.sort(42);
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });

    it("sort('foo') throws TypeError", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          var caught = 0;
          try {
            arr.sort("foo");
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });

    it("sort(true) throws TypeError", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          var caught = 0;
          try {
            arr.sort(true);
          } catch (e: any) {
            caught = 1;
          }
          return caught;
        }`,
      );
      expect(ret).toBe(1);
    });
  });

  describe("undefined / no-arg / callable comparator does NOT throw", () => {
    it("sort() with no args succeeds", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          arr.sort();
          // ascending order: [1, 2, 3] -> first element 1
          return arr[0];
        }`,
      );
      expect(ret).toBe(1);
    });

    it("sort(undefined) succeeds (treated as no comparator)", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          arr.sort(undefined);
          return arr[0];
        }`,
      );
      expect(ret).toBe(1);
    });

    it("sort(arrowFn) does not throw", async () => {
      const ret = await compileAndCall<number>(
        `export function test(): number {
          var arr: any = [3, 1, 2] as number[];
          var threw = 0;
          try {
            arr.sort((a, b) => a - b);
          } catch (e: any) {
            threw = 1;
          }
          return threw;
        }`,
      );
      expect(ret).toBe(0);
    });
  });
});
