import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Native i32 type annotations (#323)", () => {
  it("i32 local variable arithmetic", async () => {
    const result = await run(
      `
      type i32 = number;
      let a: i32 = 10;
      let b: i32 = 20;
      export function test(): number {
        return a + b;
      }
      `,
      "test",
    );
    expect(result).toBe(30);
  });

  it("i32 loop counter", async () => {
    const result = await run(
      `
      type i32 = number;
      export function test(): number {
        let sum: i32 = 0;
        for (let i: i32 = 0; i < 10; i++) {
          sum = sum + i;
        }
        return sum;
      }
      `,
      "test",
    );
    expect(result).toBe(45);
  });

  it("i32 subtraction and multiplication", async () => {
    const result = await run(
      `
      type i32 = number;
      export function test(): number {
        let a: i32 = 7;
        let b: i32 = 3;
        let diff: i32 = a - b;
        let prod: i32 = a * b;
        return diff + prod;
      }
      `,
      "test",
    );
    expect(result).toBe(25);
  });

  it("i32 comparison operators", async () => {
    const result = await run(
      `
      type i32 = number;
      export function test(): number {
        let a: i32 = 5;
        let b: i32 = 10;
        let r: i32 = 0;
        if (a < b) r = r + 1;
        if (a > b) r = r + 10;
        if (a === a) r = r + 100;
        if (a !== b) r = r + 1000;
        return r;
      }
      `,
      "test",
    );
    expect(result).toBe(1101);
  });

  it("i32 bitwise operations", async () => {
    const result = await run(
      `
      type i32 = number;
      export function test(): number {
        let a: i32 = 255;
        let b: i32 = 15;
        let andResult: i32 = a & b;
        let orResult: i32 = a | 256;
        let xorResult: i32 = a ^ b;
        return andResult + orResult + xorResult;
      }
      `,
      "test",
    );
    // andResult = 15, orResult = 511, xorResult = 240, sum = 766
    expect(result).toBe(766);
  });

  it("i32 function parameter and return", async () => {
    const result = await run(
      `
      type i32 = number;
      function add(a: i32, b: i32): i32 {
        return a + b;
      }
      export function test(): number {
        return add(100, 200);
      }
      `,
      "test",
    );
    expect(result).toBe(300);
  });

  it("i32 modulo operation", async () => {
    const result = await run(
      `
      type i32 = number;
      export function test(): number {
        let a: i32 = 17;
        let b: i32 = 5;
        let rem: i32 = a % b;
        return rem;
      }
      `,
      "test",
    );
    expect(result).toBe(2);
  });

  it("i32 shift operations", async () => {
    const result = await run(
      `
      type i32 = number;
      export function test(): number {
        let a: i32 = 1;
        let shifted: i32 = a << 8;
        let back: i32 = shifted >> 4;
        return back;
      }
      `,
      "test",
    );
    // 1 << 8 = 256, 256 >> 4 = 16
    expect(result).toBe(16);
  });
});
