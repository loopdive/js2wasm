import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("Issue #342: Array.prototype.method.call/apply patterns", () => {
  describe("indexOf via Array.prototype.indexOf.call", () => {
    it("finds element at correct index", async () => {
      const result = await run(`
        const arr: number[] = [5, 10, 15, 20];
        export function test(): number {
          return Array.prototype.indexOf.call(arr, 15);
        }
      `);
      expect(result).toBe(2);
    });

    it("returns -1 for missing element", async () => {
      const result = await run(`
        const arr: number[] = [5, 10, 15, 20];
        export function test(): number {
          return Array.prototype.indexOf.call(arr, 99);
        }
      `);
      expect(result).toBe(-1);
    });

    it("finds first element", async () => {
      const result = await run(`
        const arr: number[] = [5, 10, 15, 20];
        export function test(): number {
          return Array.prototype.indexOf.call(arr, 5);
        }
      `);
      expect(result).toBe(0);
    });

    it("finds last element", async () => {
      const result = await run(`
        const arr: number[] = [5, 10, 15, 20];
        export function test(): number {
          return Array.prototype.indexOf.call(arr, 20);
        }
      `);
      expect(result).toBe(3);
    });
  });

  describe("map via Array.prototype.map.call", () => {
    it("preserves array length", async () => {
      const result = await run(`
        const arr: number[] = [10, 20, 30, 40];
        export function test(): number {
          const mapped: number[] = Array.prototype.map.call(arr, (x: number): number => x + 1);
          return mapped.length;
        }
      `);
      expect(result).toBe(4);
    });
  });

  describe("routing parity: Array.prototype.X.call(arr, ...) produces same result as arr.X(...)", () => {
    it("indexOf via .call matches direct call", async () => {
      const directResult = await run(`
        const arr: number[] = [10, 20, 30];
        export function test(): number {
          return arr.indexOf(20);
        }
      `);
      const callResult = await run(`
        const arr: number[] = [10, 20, 30];
        export function test(): number {
          return Array.prototype.indexOf.call(arr, 20);
        }
      `);
      expect(callResult).toBe(directResult);
    });

    it("map.length via .call matches direct call", async () => {
      const directResult = await run(`
        const arr: number[] = [1, 2, 3];
        export function test(): number {
          const m: number[] = arr.map((x: number): number => x * 2);
          return m.length;
        }
      `);
      const callResult = await run(`
        const arr: number[] = [1, 2, 3];
        export function test(): number {
          const m: number[] = Array.prototype.map.call(arr, (x: number): number => x * 2);
          return m.length;
        }
      `);
      expect(callResult).toBe(directResult);
    });

    it("filter.length via .call matches direct call", async () => {
      const directResult = await run(`
        const arr: number[] = [1, 2, 3, 4, 5];
        export function test(): number {
          const f: number[] = arr.filter((x: number): number => x > 3 ? 1 : 0);
          return f.length;
        }
      `);
      const callResult = await run(`
        const arr: number[] = [1, 2, 3, 4, 5];
        export function test(): number {
          const f: number[] = Array.prototype.filter.call(arr, (x: number): number => x > 3 ? 1 : 0);
          return f.length;
        }
      `);
      expect(callResult).toBe(directResult);
    });

    it("find via .call matches direct call", async () => {
      const directResult = await run(`
        const arr: number[] = [1, 2, 3, 4, 5];
        export function test(): number {
          return arr.find((x: number): number => x > 3 ? 1 : 0);
        }
      `);
      const callResult = await run(`
        const arr: number[] = [1, 2, 3, 4, 5];
        export function test(): number {
          return Array.prototype.find.call(arr, (x: number): number => x > 3 ? 1 : 0);
        }
      `);
      expect(callResult).toBe(directResult);
    });

    it("findIndex via .call matches direct call", async () => {
      const directResult = await run(`
        const arr: number[] = [10, 20, 30, 40];
        export function test(): number {
          return arr.findIndex((x: number): number => x > 25 ? 1 : 0);
        }
      `);
      const callResult = await run(`
        const arr: number[] = [10, 20, 30, 40];
        export function test(): number {
          return Array.prototype.findIndex.call(arr, (x: number): number => x > 25 ? 1 : 0);
        }
      `);
      expect(callResult).toBe(directResult);
    });

    it("reduce via .call matches direct call", async () => {
      const directResult = await run(`
        const arr: number[] = [1, 2, 3, 4, 5];
        export function test(): number {
          return arr.reduce((acc: number, x: number): number => acc + x, 0);
        }
      `);
      const callResult = await run(`
        const arr: number[] = [1, 2, 3, 4, 5];
        export function test(): number {
          return Array.prototype.reduce.call(arr, (acc: number, x: number): number => acc + x, 0);
        }
      `);
      expect(callResult).toBe(directResult);
    });
  });
});
