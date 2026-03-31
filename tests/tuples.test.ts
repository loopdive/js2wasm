import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fnName = "test") {
  const result = compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as any)[fnName]();
}

describe("tuples", () => {
  it("create a tuple [number, number] and access elements", async () => {
    const result = await run(`
      export function test(): number {
        const pair: [number, number] = [10, 20];
        return pair[0] + pair[1];
      }
    `);
    expect(result).toBe(30);
  });

  it("create a tuple [number, boolean] with mixed types", async () => {
    const result = await run(`
      export function test(): number {
        const t: [number, boolean] = [42, true];
        return t[0];
      }
    `);
    expect(result).toBe(42);
  });

  it("access boolean element from tuple", async () => {
    const result = await run(`
      export function test(): boolean {
        const t: [number, boolean] = [42, true];
        return t[1];
      }
    `);
    expect(result).toBe(1); // true is i32(1)
  });

  it("return tuple from function", async () => {
    const result = await run(`
      function makePair(a: number, b: number): [number, number] {
        return [a, b];
      }
      export function test(): number {
        const p = makePair(3, 7);
        return p[0] + p[1];
      }
    `);
    expect(result).toBe(10);
  });

  it("tuple with three elements", async () => {
    const result = await run(`
      export function test(): number {
        const t: [number, number, number] = [1, 2, 3];
        return t[0] + t[1] + t[2];
      }
    `);
    expect(result).toBe(6);
  });

  it("tuple passed as function argument", async () => {
    const result = await run(`
      function sum(pair: [number, number]): number {
        return pair[0] + pair[1];
      }
      export function test(): number {
        const p: [number, number] = [5, 15];
        return sum(p);
      }
    `);
    expect(result).toBe(20);
  });

  it("tuple assigned to local variable", async () => {
    const result = await run(`
      export function test(): number {
        let t: [number, number] = [1, 2];
        const a: number = t[0];
        const b: number = t[1];
        return a * b;
      }
    `);
    expect(result).toBe(2);
  });

  it("nested function returning tuple", async () => {
    const result = await run(`
      function first(t: [number, number]): number {
        return t[0];
      }
      function second(t: [number, number]): number {
        return t[1];
      }
      export function test(): number {
        const t: [number, number] = [100, 200];
        return first(t) + second(t);
      }
    `);
    expect(result).toBe(300);
  });

  it("tuple [boolean, boolean]", async () => {
    const result = await run(`
      export function test(): boolean {
        const t: [boolean, boolean] = [true, false];
        return t[0];
      }
    `);
    expect(result).toBe(1); // true
  });

  it("tuple [boolean, number]", async () => {
    const result = await run(`
      export function test(): number {
        const t: [boolean, number] = [true, 99];
        return t[1];
      }
    `);
    expect(result).toBe(99);
  });
});
