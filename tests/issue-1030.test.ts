import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const importResult = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  if (typeof importResult.setExports === "function") {
    importResult.setExports(instance.exports as any);
  }
  return (instance.exports as any).test?.();
}

describe("Array.prototype.{filter,map,reduce,reduceRight}.call long tail (#1030)", () => {
  it("filter.call keeps matching elements", async () => {
    const r = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, 3: 4, length: 4 };
      const out: any = Array.prototype.filter.call(obj, (x: any) => x > 2);
      export function test() { return out.length === 2 && out[0] === 3 && out[1] === 4 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("filter.call with function declaration callback", async () => {
    const r = await run(`
      function isOdd(val: any) { return val % 2 === 1; }
      const obj: any = { 0: 1, 1: 2, 2: 3, 3: 4, length: 4 };
      const out: any = Array.prototype.filter.call(obj, isOdd);
      export function test() { return out.length === 2 && out[0] === 1 && out[1] === 3 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("map.call transforms each element", async () => {
    const r = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const out: any = Array.prototype.map.call(obj, (x: any) => x * 2);
      export function test() { return out.length === 3 && out[0] === 2 && out[1] === 4 && out[2] === 6 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("map.call with index argument", async () => {
    const r = await run(`
      const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
      const out: any = Array.prototype.map.call(obj, (_v: any, i: number) => i);
      export function test() { return out.length === 3 && out[0] === 0 && out[1] === 1 && out[2] === 2 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("reduce.call with initial value", async () => {
    const r = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const sum: any = Array.prototype.reduce.call(obj, (acc: any, x: any) => acc + x, 10);
      export function test() { return sum === 16 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("reduce.call without initial value", async () => {
    const r = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const sum: any = Array.prototype.reduce.call(obj, (acc: any, x: any) => acc + x);
      export function test() { return sum === 6 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("reduceRight.call walks right-to-left with initial value", async () => {
    const r = await run(`
      const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
      const s: any = Array.prototype.reduceRight.call(obj, (acc: any, x: any) => acc + "," + x, "start");
      export function test() { return s === "start,3,2,1" ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("reduceRight.call without initial value", async () => {
    const r = await run(`
      const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
      const sum: any = Array.prototype.reduceRight.call(obj, (acc: any, x: any) => acc + x);
      export function test() { return sum === 60 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("filter.call on arguments object (test262 pattern)", async () => {
    const r = await run(`
      function makeArgs(): any { return arguments; }
      const args: any = (makeArgs as any)("a", "b", "c");
      const out: any = Array.prototype.filter.call(args, (x: any) => true);
      export function test() { return out.length === 3 && out[0] === "a" && out[2] === "c" ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });
});
