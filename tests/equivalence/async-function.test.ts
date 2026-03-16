import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent } from "./helpers.js";

describe("Async function support (synchronous compilation)", () => {
  it("async function returning a literal compiles and returns correct value", async () => {
    const src = `
      async function f(): Promise<number> { return 42; }
      export function main(): number {
        // In synchronous wasm, calling an async function returns the value directly
        return f() as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("async function with parameters", async () => {
    const src = `
      async function add(a: number, b: number): Promise<number> {
        return a + b;
      }
      export function main(): number {
        return add(10, 32) as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("await expression is identity (pass-through)", async () => {
    const src = `
      async function getValue(): Promise<number> {
        return 100;
      }
      async function test(): Promise<number> {
        const v = await getValue();
        return v;
      }
      export function main(): number {
        return test() as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(100);
  });

  it("async function with computation", async () => {
    const src = `
      async function square(x: number): Promise<number> {
        return x * x;
      }
      export function main(): number {
        return square(7) as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(49);
  });

  it("multiple awaits in sequence", async () => {
    const src = `
      async function getA(): Promise<number> { return 10; }
      async function getB(): Promise<number> { return 20; }
      async function sum(): Promise<number> {
        const a = await getA();
        const b = await getB();
        return a + b;
      }
      export function main(): number {
        return sum() as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(30);
  });

  it("async arrow function", async () => {
    const src = `
      const double = async (x: number): Promise<number> => x * 2;
      export function main(): number {
        return double(21) as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("async function with conditional", async () => {
    const src = `
      async function abs(x: number): Promise<number> {
        if (x < 0) return -x;
        return x;
      }
      export function main(): number {
        return abs(-5) as any as number;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(5);
  });
});
