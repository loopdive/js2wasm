import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runTest(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error("Compile error: " + r.errors.map((e) => e.message).join("; "));
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #794: BindingElement null guard over-triggering", () => {
  it("array destructuring with object binding pattern and default", async () => {
    const src = `
      var arr: {x:number,y:number,z:number}[] = [];
      var [{x, y, z} = {x: 44, y: 55, z: 66}] = arr;
      export function test(): number {
        if (x !== 44) return 0;
        if (y !== 55) return 0;
        if (z !== 66) return 0;
        return 1;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("array destructuring with array binding pattern and default", async () => {
    const src = `
      var arr: number[][] = [];
      var [[a, b, c] = [4, 5, 6]] = arr;
      export function test(): number {
        if (a !== 4) return 0;
        if (b !== 5) return 0;
        if (c !== 6) return 0;
        return 1;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("function param: array with object binding pattern and default", async () => {
    const src = `
      function f([{x, y, z} = {x: 44, y: 55, z: 66}]: {x:number,y:number,z:number}[]): number {
        if (x !== 44) return 0;
        if (y !== 55) return 0;
        if (z !== 66) return 0;
        return 1;
      }
      export function test(): number {
        return f([]);
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("function param: array with array binding pattern and default", async () => {
    const src = `
      function f([[a, b, c] = [4, 5, 6]]: number[][]): number {
        if (a !== 4) return 0;
        if (b !== 5) return 0;
        if (c !== 6) return 0;
        return 1;
      }
      export function test(): number {
        return f([]);
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("nested destructuring with named interface type", async () => {
    const src = `
      interface Point { x: number; y: number; z: number; }
      function extract(arr: Point[]): number {
        var [{x, y, z} = {x: 44, y: 55, z: 66}] = arr;
        return x;
      }
      export function test(): number {
        return extract([]) === 44 ? 1 : 0;
      }
    `;
    expect(await runTest(src)).toBe(1);
  });

  it("module-level nested binding default (externref path)", async () => {
    const src = `
      var [{x, y, z} = {x: 44, y: 55, z: 66}]: any[] = [];
      export function test(): number {
        return x + y + z;
      }
    `;
    expect(await runTest(src)).toBe(165);
  });

  it("simple defaults with vec array still work", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [];
        var [a = 42] = arr;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(42);
  });

  it("non-empty array does not use default", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [10];
        var [a = 42] = arr;
        return a;
      }
    `;
    expect(await runTest(src)).toBe(10);
  });
});
