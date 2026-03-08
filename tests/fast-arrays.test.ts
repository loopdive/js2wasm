import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source, { fast: true });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as any)[fn](...args);
}

describe("fast mode arrays - quick check", () => {
  it("array literal and length", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.length;
      }
    `, "test")).toBe(3);
  });

  it("array element access", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr[1];
      }
    `, "test")).toBe(20);
  });

  it("array push and length", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2];
        arr.push(3);
        return arr.length;
      }
    `, "test")).toBe(3);
  });

  it("array indexOf", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.indexOf(20);
      }
    `, "test")).toBe(1);
  });

  it("for-of loop", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4];
        let sum = 0;
        for (const x of arr) sum = sum + x;
        return sum;
      }
    `, "test")).toBe(10);
  });

  it("array map", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        const doubled = arr.map((x: number): number => x * 2);
        return doubled[0] + doubled[1] + doubled[2];
      }
    `, "test")).toBe(12);
  });

  it("array filter", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        const evens = arr.filter((x: number): boolean => x % 2 === 0);
        return evens.length;
      }
    `, "test")).toBe(2);
  });

  it("array reduce", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4];
        return arr.reduce((acc: number, x: number): number => acc + x, 0);
      }
    `, "test")).toBe(10);
  });

  it("array some", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4];
        const hasEven = arr.some((x: number): boolean => x % 2 === 0);
        return hasEven ? 1 : 0;
      }
    `, "test")).toBe(1);
  });

  it("array every", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [2, 4, 6];
        const allEven = arr.every((x: number): boolean => x % 2 === 0);
        return allEven ? 1 : 0;
      }
    `, "test")).toBe(1);
  });

  it("array every false", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [2, 3, 6];
        const allEven = arr.every((x: number): boolean => x % 2 === 0);
        return allEven ? 1 : 0;
      }
    `, "test")).toBe(0);
  });

  it("array forEach", async () => {
    // forEach with side effects — test it compiles and runs without error
    // (forEach callbacks run on JS side so can't easily write wasm globals)
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        let count = 0;
        arr.forEach((x: number): void => { });
        return arr.length;
      }
    `, "test")).toBe(3);
  });

  it("array find", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [1, 2, 3, 4];
        const found = arr.find((x: number): boolean => x > 2);
        return found;
      }
    `, "test")).toBe(3);
  });

  it("array findIndex", async () => {
    expect(await run(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.findIndex((x: number): boolean => x === 20);
      }
    `, "test")).toBe(1);
  });
});
