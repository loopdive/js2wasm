import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports, instantiateWasm } from "../src/runtime.ts";

async function run(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("Compile error: " + result.errors.map(e => e.message).join("; "));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports["wasm:js-string"], imports.string_constants);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("for-in enumeration", () => {
  it("enumerates struct field names", async () => {
    const result = await run(`
      interface Obj { a: number; b: number; c: number }
      export function test(): number {
        const obj: Obj = { a: 1, b: 2, c: 3 };
        let count = 0;
        for (const key in obj) {
          count++;
        }
        return count; // should be 3
      }
    `);
    expect(result).toBe(3);
  });

  it("for-in supports break", async () => {
    const result = await run(`
      interface Obj { a: number; b: number; c: number }
      export function test(): number {
        const obj: Obj = { a: 1, b: 2, c: 3 };
        let count = 0;
        for (const key in obj) {
          count++;
          if (count === 2) break;
        }
        return count; // should be 2
      }
    `);
    expect(result).toBe(2);
  });

  it("for-in supports continue", async () => {
    const result = await run(`
      interface Obj { a: number; b: number; c: number }
      export function test(): number {
        const obj: Obj = { a: 10, b: 20, c: 30 };
        let sum = 0;
        let i = 0;
        for (const key in obj) {
          i++;
          if (i === 2) continue;
          sum += i;
        }
        return sum; // 1 + 3 = 4
      }
    `);
    expect(result).toBe(4);
  });

  it("for-in with bare identifier", async () => {
    const result = await run(`
      interface Obj { a: number; b: number }
      export function test(): number {
        const obj: Obj = { a: 1, b: 2 };
        let count = 0;
        let key: string;
        for (key in obj) {
          count++;
        }
        return count; // should be 2
      }
    `);
    expect(result).toBe(2);
  });

  it("for-in on empty object returns 0 iterations", async () => {
    const result = await run(`
      export function test(): number {
        const obj: Record<string, number> = {};
        let count = 0;
        for (const key in obj) {
          count++;
        }
        return count; // should be 0
      }
    `);
    expect(result).toBe(0);
  });
});
