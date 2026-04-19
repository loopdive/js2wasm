import { describe, expect, it } from "vitest";
import { compile } from "../src/index";
import { buildImports } from "../src/runtime";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "t.ts" });
  if (!r.success) throw new Error("CE: " + r.errors?.[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as any).setExports?.(instance.exports);
  return (instance.exports as any).test();
}

describe("Array.prototype.METHOD.call(arrayLikeObj, cb)", () => {
  it("filter iterates with HasProperty gating — skips holes", async () => {
    const src = `
      function cb(v: any) { return v > 10; }
      const obj = { 1: 11, 2: 9, length: "2" };
      export function test(): number {
        const r = Array.prototype.filter.call(obj, cb);
        return (r as any).length === 1 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("reduce accumulates across array-like receiver", async () => {
    const src = `
      function add(acc: any, v: any): any { return acc + v; }
      const obj = { 0: 10, 1: 20, 2: 30, length: 3 };
      export function test(): number {
        const r = Array.prototype.reduce.call(obj, add, 0);
        return r === 60 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("reduceRight iterates right-to-left on array-like", async () => {
    const src = `
      const visited: any[] = [];
      function cb(_acc: any, _v: any, idx: any): any { visited.push(idx); return false; }
      const obj = { 0: 12, 1: 11, length: 2 };
      export function test(): number {
        Array.prototype.reduceRight.call(obj, cb, 1);
        return visited.length === 2 && visited[0] === 1 && visited[1] === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("length: '-Infinity' clamps to 0 (ToLength)", async () => {
    const src = `
      let called = false;
      function cb() { called = true; return false; }
      const obj = { 0: 9, length: "-Infinity" };
      export function test(): number {
        Array.prototype.every.call(obj, cb);
        return called ? 0 : 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
