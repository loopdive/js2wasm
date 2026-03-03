import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileLinear(source: string) {
  const result = compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-functions: function calls", () => {
  it("calls a local function", async () => {
    const e = await compileLinear(`
      function double(x: number): number {
        return x * 2;
      }
      export function test(n: number): number {
        return double(n);
      }
    `);
    expect(e.test(5)).toBe(10);
    expect(e.test(0)).toBe(0);
  });

  it("calls multiple functions", async () => {
    const e = await compileLinear(`
      function add(a: number, b: number): number {
        return a + b;
      }
      function square(x: number): number {
        return x * x;
      }
      export function test(x: number): number {
        return add(square(x), 1);
      }
    `);
    expect(e.test(3)).toBe(10); // 3*3 + 1
    expect(e.test(0)).toBe(1);
  });

  it("recursive function", async () => {
    const e = await compileLinear(`
      export function fib(n: number): number {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
    `);
    expect(e.fib(0)).toBe(0);
    expect(e.fib(1)).toBe(1);
    expect(e.fib(5)).toBe(5);
    expect(e.fib(10)).toBe(55);
  });

  it("mutually calls between exported functions", async () => {
    const e = await compileLinear(`
      export function isEven(n: number): number {
        if (n === 0) return 1;
        return isOdd(n - 1);
      }
      export function isOdd(n: number): number {
        if (n === 0) return 0;
        return isEven(n - 1);
      }
    `);
    expect(e.isEven(4)).toBe(1);
    expect(e.isEven(3)).toBe(0);
    expect(e.isOdd(3)).toBe(1);
    expect(e.isOdd(4)).toBe(0);
  });
});
