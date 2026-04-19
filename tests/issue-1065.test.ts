import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1065 — Bare Array identifier resolves to host constructor", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("bare Array is a function (not null)", async () => {
    const ret = await run(`
      export function test(): number {
        const A: any = Array;
        if (A === null) return 10;
        if (typeof A !== "function") return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Array compared by identity with itself is true", async () => {
    const ret = await run(`
      export function test(): number {
        const A: any = Array;
        const B: any = Array;
        return A === B ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Array passed through a function preserves identity", async () => {
    const ret = await run(`
      function id(x: any): any { return x; }
      export function test(): number {
        return id(Array) === Array ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Object bare identifier resolves to host Object", async () => {
    const ret = await run(`
      export function test(): number {
        const O: any = Object;
        if (O === null) return 10;
        if (typeof O !== "function") return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("new Array(n) fast path still works alongside bare Array", async () => {
    const ret = await run(`
      export function test(): number {
        const a = new Array(3);
        if (a.length !== 3) return 10;
        const A: any = Array;
        if (typeof A !== "function") return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Array.isArray fast path still works alongside bare Array", async () => {
    const ret = await run(`
      export function test(): number {
        const x = [1, 2, 3];
        if (!Array.isArray(x)) return 10;
        const A: any = Array;
        if (typeof A !== "function") return 11;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });
});
