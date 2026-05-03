// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1293 — string[][] (array-of-arrays) WasmGC type support
//
// Currently the compiler handles `string[]` (array of externrefs) but not
// `string[][]`. This test checks the minimal repro for nested array typing.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#1293 string[][] array-of-arrays type support", () => {
  it("compiles and indexes a nested string array literal", async () => {
    const { exports } = await run(`
      export function test(): string {
        const arr: string[][] = [["a", "b"], ["c"]];
        return arr[0][1];
      }
    `);
    expect(exports.test!()).toBe("b");
  });

  it("compiles and indexes the second row first column", async () => {
    const { exports } = await run(`
      export function test(): string {
        const arr: string[][] = [["a", "b"], ["c"]];
        return arr[1][0];
      }
    `);
    expect(exports.test!()).toBe("c");
  });

  it("supports string[][] as a class field with nested access", async () => {
    const { exports } = await run(`
      class Holder {
        rows: string[][] = [];
      }
      export function test(): string {
        const h = new Holder();
        h.rows = [["x", "y"], ["z"]];
        return h.rows[0][1];
      }
    `);
    expect(exports.test!()).toBe("y");
  });

  it("supports number[][] (matrix) as a regression check", async () => {
    const { exports } = await run(`
      export function test(): number {
        const m: number[][] = [[1, 2, 3], [4, 5, 6]];
        return m[1][2];
      }
    `);
    expect(exports.test!()).toBe(6);
  });

  it("returns the correct length of an outer string[][]", async () => {
    const { exports } = await run(`
      export function test(): number {
        const arr: string[][] = [["a", "b"], ["c"], ["d", "e", "f"]];
        return arr.length;
      }
    `);
    expect(exports.test!()).toBe(3);
  });

  it("returns the correct length of inner row", async () => {
    const { exports } = await run(`
      export function test(): number {
        const arr: string[][] = [["a", "b"], ["c"], ["d", "e", "f"]];
        return arr[2].length;
      }
    `);
    expect(exports.test!()).toBe(3);
  });
});
