import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runWasm(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("Compile: " + r.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("#847 — for-of destructuring with externref elements", () => {
  it("basic for-of with simple variable works", async () => {
    const result = await runWasm(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        let sum = 0;
        for (const x of arr) {
          sum = sum + x;
        }
        return sum;
      }
    `);
    expect(result).toBe(60);
  });

  it("for-of with typed array destructuring (tuple path)", async () => {
    // Uses the WasmGC tuple struct path for typed arrays
    const result = await runWasm(`
      export function test(): number {
        const items: [number, number][] = [[10, 20], [30, 40]];
        let sum = 0;
        for (const [a, b] of items) {
          sum = sum + a + b;
        }
        return sum;
      }
    `);
    expect(result).toBe(100);
  });

  it("for-of assign destructuring into module-level globals", async () => {
    const result = await runWasm(`
      let v1: number = 0;
      let v2: number = 0;
      export function test(): number {
        const arr = [[1, 2], [3, 4]];
        for ([v1, v2] of arr) { }
        if (v1 !== 3) return 0;
        if (v2 !== 4) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("for-of assign destructuring into module globals with defaults", async () => {
    const result = await runWasm(`
      let a: number = 0;
      let b: number = 0;
      export function test(): number {
        const arr = [[1], [3]];
        for ([a, b = 99] of arr) { }
        if (a !== 3) return 0;
        if (b !== 99) return 0;
        return 1;
      }
    `);
    expect(result).toBe(1);
  });
});
