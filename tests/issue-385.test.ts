import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: { console_log_number: () => {}, console_log_bool: () => {}, console_log_string: () => {} },
  });
  return (instance.exports as any)[fn](...args);
}

describe("Issue #385: Array method argument count errors", () => {
  // indexOf with fromIndex — each call must be a direct return (due to inline return behavior)
  it("indexOf with fromIndex finds match", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30, 20, 40];
        return arr.indexOf(20, 2);   // 3 (start from index 2, finds 20 at index 3)
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("indexOf with fromIndex past last occurrence", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30, 20, 40];
        return arr.indexOf(20, 4);   // -1 (not found after index 4)
      }
    `;
    expect(await run(src, "test")).toBe(-1);
  });

  it("indexOf with negative fromIndex", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30, 20, 40];
        return arr.indexOf(20, -3);  // 3 (length=5, start from 5-3=2)
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("indexOf with very negative fromIndex clamps to 0", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30, 20, 40];
        return arr.indexOf(20, -100); // 1 (clamped to 0)
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("indexOf without fromIndex still works", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30];
        return arr.indexOf(20);  // 1
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  // includes with fromIndex
  it("includes with fromIndex finds match", async () => {
    const src = `
      export function test(): boolean {
        var arr = [10, 20, 30, 20, 40];
        return arr.includes(20, 2);   // found at index 3
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("includes with fromIndex past last occurrence", async () => {
    const src = `
      export function test(): boolean {
        var arr = [10, 20, 30, 20, 40];
        return arr.includes(20, 4);   // not found
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("includes with negative fromIndex", async () => {
    const src = `
      export function test(): boolean {
        var arr = [10, 20, 30, 40, 50];
        return arr.includes(40, -2);   // true (start from index 3)
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("includes without fromIndex still works", async () => {
    const src = `
      export function test(): boolean {
        var arr = [10, 20, 30];
        return arr.includes(20);
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  // push with multiple arguments
  it("push with multiple arguments", async () => {
    const src = `
      export function test(): number {
        var arr = [1, 2, 3];
        var newLen = arr.push(4, 5, 6);
        return newLen * 10000 + arr[3] * 1000 + arr[4] * 100 + arr[5] * 10 + arr.length;
      }
    `;
    // newLen=6, arr[3]=4, arr[4]=5, arr[5]=6, length=6
    // 60000 + 4000 + 500 + 60 + 6 = 64566
    expect(await run(src, "test")).toBe(64566);
  });

  it("push with single argument still works", async () => {
    const src = `
      export function test(): number {
        var arr = [1, 2];
        var newLen = arr.push(3);
        return newLen * 10 + arr[2];
      }
    `;
    // newLen=3, arr[2]=3 => 33
    expect(await run(src, "test")).toBe(33);
  });

  it("push with many arguments triggers capacity growth", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [];
        arr.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
        return arr[0] * 100 + arr[9] * 10 + arr.length;
      }
    `;
    // arr[0]=1, arr[9]=10, length=10 => 100 + 100 + 10 = 210
    expect(await run(src, "test")).toBe(210);
  });

  // lastIndexOf with fromIndex (already supported, verify it compiles)
  it("lastIndexOf with fromIndex", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30, 20, 40];
        return arr.lastIndexOf(20, 2);  // 1 (search backwards from index 2)
      }
    `;
    expect(await run(src, "test")).toBe(1);
  });

  it("lastIndexOf without fromIndex", async () => {
    const src = `
      export function test(): number {
        var arr = [10, 20, 30, 20, 40];
        return arr.lastIndexOf(20);  // 3 (last occurrence)
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });
});
