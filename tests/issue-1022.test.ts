import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const importResult = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  // Provide exports back to runtime so __sget_* getters are discoverable
  if (typeof importResult.setExports === "function") {
    importResult.setExports(instance.exports as any);
  }
  return (instance.exports as any).test?.();
}

describe("Array.prototype.METHOD.call with any-typed receiver (#1022)", () => {
  it("every.call returns false when callback fails", async () => {
    const result = await run(`
      function callbackfn(val: any, idx: number, obj: any) {
        return val > 0;
      }
      const obj: any = { 0: 1, 1: -1, 2: 3, length: 3 };
      const result = Array.prototype.every.call(obj, callbackfn);
      export function test() { return result === false ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("every.call returns true when all pass", async () => {
    const result = await run(`
      function callbackfn(val: any) { return val > 0; }
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const result = Array.prototype.every.call(obj, callbackfn);
      export function test() { return result === true ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("some.call returns true when one passes", async () => {
    const result = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const result = Array.prototype.some.call(obj, (x: any) => x > 2);
      export function test() { return result === true ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("some.call returns false when none pass", async () => {
    const result = await run(`
      const obj: any = { 0: 1, 1: 2, length: 2 };
      const result = Array.prototype.some.call(obj, (x: any) => x > 10);
      export function test() { return result === false ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("forEach.call iterates all elements", async () => {
    const result = await run(`
      let sum = 0;
      const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
      Array.prototype.forEach.call(obj, (x: any) => { sum += x; });
      export function test() { return sum === 60 ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("forEach.call with index parameter", async () => {
    const result = await run(`
      let idxSum = 0;
      const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
      Array.prototype.forEach.call(obj, (x: any, idx: number) => { idxSum += idx; });
      export function test() { return idxSum === 3 ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("find.call returns found element", async () => {
    const result = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const found = Array.prototype.find.call(obj, (x: any) => x === 2);
      export function test() { return found === 2 ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("findIndex.call returns found index", async () => {
    const result = await run(`
      const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
      const idx = Array.prototype.findIndex.call(obj, (x: any) => x === 20);
      export function test() { return idx === 1 ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("findIndex.call returns -1 when not found", async () => {
    const result = await run(`
      const obj: any = { 0: 10, 1: 20, length: 2 };
      const idx = Array.prototype.findIndex.call(obj, (x: any) => x === 99);
      export function test() { return idx === -1 ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("every.call with arrow function callback (common test262 pattern)", async () => {
    const result = await run(`
      const obj: any = { 0: 2, 1: 4, 2: 6, length: 3 };
      const result = Array.prototype.every.call(obj, (val: any) => val % 2 === 0);
      export function test() { return result === true ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });
});
