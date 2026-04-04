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
    env: { console_log_number: () => {}, console_log_bool: () => {} },
  });
  return (instance.exports as any)[fn](...args);
}

describe("arrays", () => {
  it("array literal and index read", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        return arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(20);
  });

  it("array with parameters", async () => {
    const src = `
      export function test(a: number, b: number): number {
        const arr = [a, b];
        return arr[0] + arr[1];
      }
    `;
    expect(await run(src, "test", [5, 7])).toBe(12);
  });

  it("array length", async () => {
    const src = `
      export function test(): number {
        const arr = [1, 2, 3, 4, 5];
        return arr.length;
      }
    `;
    expect(await run(src, "test")).toBe(5);
  });

  it("array element assignment", async () => {
    const src = `
      export function test(): number {
        const arr = [1, 2, 3];
        arr[0] = 99;
        return arr[0];
      }
    `;
    expect(await run(src, "test")).toBe(99);
  });

  it("array in loop", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        const arr = [1, 2, 3];
        let i = 0;
        while (i < arr.length) {
          sum = sum + arr[i];
          i = i + 1;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(6);
  });
});

describe("enums", () => {
  it("explicit values", async () => {
    const src = `
      enum Dir { Up = 0, Down = 1, Left = 2, Right = 3 }
      export function test(): number {
        return Dir.Left;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("auto-incremented values", async () => {
    const src = `
      enum Color { Red, Green, Blue }
      export function test(): number {
        return Color.Blue;
      }
    `;
    expect(await run(src, "test")).toBe(2);
  });

  it("enum in arithmetic", async () => {
    const src = `
      enum E { A = 10, B = 20 }
      export function test(): number {
        return E.A + E.B;
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });

  it("enum in comparison", async () => {
    const src = `
      enum Dir { Up = 0, Down = 1 }
      export function isUp(d: number): number {
        if (d === Dir.Up) return 1;
        return 0;
      }
    `;
    expect(await run(src, "isUp", [0])).toBe(1);
    expect(await run(src, "isUp", [1])).toBe(0);
  });
});
