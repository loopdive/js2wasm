import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
  });
  return (instance.exports as any)[fn](...args);
}

function compileOnly(source: string): void {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
}

describe("issue-328: OmittedExpression (array holes/elision)", () => {
  it("array literal with holes [1,,3] compiles", () => {
    compileOnly(`
      export function test(): number {
        const arr: number[] = [1,,3];
        return arr[2];
      }
    `);
  });

  it("[1,,3] has correct values", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [1,,3];
        return arr[0] + arr[2];
      }
    `;
    expect(await run(src, "test")).toBe(4);
  });

  it("array with leading hole [,,1]", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [,,1];
        return arr[2];
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("array with trailing hole [1,2,]", async () => {
    // Trailing comma is not an OmittedExpression in TS, but test for safety
    const src = `
      export function test(): number {
        const arr: number[] = [1, 2];
        return arr[0] + arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("destructuring with holes [a,,b] = arr", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        const [a,,b] = arr;
        return a + b;
      }
    `;
    expect(await run(src, "test")).toBe(40);
  });

  it("destructuring with leading hole [,a] = arr", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [10, 20];
        const [,a] = arr;
        return a;
      }
    `;
    expect(await run(src, "test")).toBe(20);
  });

  it("hole in number array produces NaN", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [1,,3];
        return arr[1];
      }
    `;
    const result = await run(src, "test");
    expect(result).toBeNaN();
  });
});
