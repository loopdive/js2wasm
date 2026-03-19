import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("ref.cast peephole optimization (#596)", () => {
  it("simple closure call works after removing redundant ref.as_non_null", async () => {
    const result = await run(
      `
      export function test(): number {
        const add = (a: number, b: number): number => a + b;
        return add(3, 4);
      }
    `,
      "test",
    );
    expect(result).toBe(7);
  });

  it("closure capturing a variable works correctly", async () => {
    const result = await run(
      `
      export function test(): number {
        let x = 10;
        const addX = (a: number): number => a + x;
        return addX(5);
      }
    `,
      "test",
    );
    expect(result).toBe(15);
  });

  it("closure with mutation of captured variable", async () => {
    const result = await run(
      `
      export function test(): number {
        let count = 0;
        const inc = (): number => { count++; return count; };
        inc();
        inc();
        return inc();
      }
    `,
      "test",
    );
    expect(result).toBe(3);
  });

  it("higher-order function returning closure", async () => {
    const result = await run(
      `
      function makeAdder(x: number): (y: number) => number {
        return (y: number): number => x + y;
      }
      export function test(): number {
        const add5 = makeAdder(5);
        return add5(10);
      }
    `,
      "test",
    );
    expect(result).toBe(15);
  });

  it("multiple closure calls in sequence", async () => {
    const result = await run(
      `
      export function test(): number {
        const double = (n: number): number => n * 2;
        const square = (n: number): number => n * n;
        return double(square(3));
      }
    `,
      "test",
    );
    expect(result).toBe(18);
  });

  it("closure as callback to array method", async () => {
    const result = await run(
      `
      export function test(): number {
        const nums = [1, 2, 3, 4];
        let sum = 0;
        nums.forEach((n: number) => { sum += n; });
        return sum;
      }
    `,
      "test",
    );
    expect(result).toBe(10);
  });

  it("WAT output does not contain ref.as_non_null immediately after ref.cast", async () => {
    const result = compile(`
      export function test(): number {
        const fn = (a: number): number => a + 1;
        return fn(41);
      }
    `);
    expect(result.success).toBe(true);
    // The WAT should not have ref.as_non_null immediately after ref.cast
    // (the peephole optimizer removes it)
    const wat = result.wat;
    const lines = wat.split("\n").map((l: string) => l.trim());
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i]!.includes("ref.cast") && lines[i + 1]!.includes("ref.as_non_null")) {
        // This should not happen after the peephole pass
        throw new Error(
          `Found redundant ref.as_non_null after ref.cast at line ${i + 1}:\n` +
          `  ${lines[i]}\n  ${lines[i + 1]}`,
        );
      }
    }
  });
});
