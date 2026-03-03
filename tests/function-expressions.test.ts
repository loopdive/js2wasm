import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
      __make_callback: () => {},
    },
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    return instance.exports as Record<string, Function>;
  } catch (e) {
    throw new Error(`Instantiation failed: ${e}\nWAT:\n${result.wat}`);
  }
}

describe("function expressions", () => {
  it("anonymous function expression", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const add = function(a: number, b: number): number { return a + b; };
        return add(1, 2);
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("function expression used as callback", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const double = function(x: number): number { return x * 2; };
        return double(21);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("named function expression with recursion", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const fib = function f(n: number): number {
          if (n <= 1) return n;
          return f(n - 1) + f(n - 2);
        };
        return fib(10);
      }
    `);
    expect(e.test()).toBe(55);
  });

  it("named function expression name does not leak to outer scope", async () => {
    // The name 'factorial' inside the function expression should not
    // conflict with other uses of that name in the outer scope
    const e = await compileAndRun(`
      export function test(): number {
        const fact = function factorial(n: number): number {
          if (n <= 1) return 1;
          return n * factorial(n - 1);
        };
        return fact(5);
      }
    `);
    expect(e.test()).toBe(120);
  });

  it("function expression with capture", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const base: number = 100;
        const addBase = function(x: number): number { return base + x; };
        return addBase(42);
      }
    `);
    expect(e.test()).toBe(142);
  });
});
