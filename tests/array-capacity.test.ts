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

describe("array capacity (vec struct)", () => {
  it("push 10k elements and sum them", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [];
        for (let i = 0; i < 10000; i = i + 1) {
          arr.push(i);
        }
        let total = 0;
        for (let i = 0; i < arr.length; i = i + 1) {
          total = total + arr[i];
        }
        return total;
      }
    `;
    expect(await run(src, "test")).toBe(49995000);
  });

  it("push then pop preserves order", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [];
        arr.push(10);
        arr.push(20);
        arr.push(30);
        const c = arr.pop();
        const b = arr.pop();
        return c * 100 + b * 10 + arr.length;
      }
    `;
    // c=30, b=20, length=1 → 3000 + 200 + 1 = 3201
    expect(await run(src, "test")).toBe(3201);
  });

  it("capacity grows beyond initial allocation", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [];
        for (let i = 0; i < 100; i = i + 1) {
          arr.push(i * 2);
        }
        return arr[99] + arr.length;
      }
    `;
    // arr[99] = 198, length = 100 → 298
    expect(await run(src, "test")).toBe(298);
  });

  it("mixed push/pop/shift operations", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [];
        arr.push(1);
        arr.push(2);
        arr.push(3);
        arr.push(4);
        arr.shift();
        arr.pop();
        // arr is now [2, 3]
        return arr[0] * 10 + arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(23);
  });
});
