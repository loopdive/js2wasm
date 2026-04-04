import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success) throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: {
      console_log_number: () => {},
      console_log_bool: () => {},
    },
  });
  return (instance.exports as any)[fn](...args);
}

describe("do-while", () => {
  it("basic: runs at least once", async () => {
    const src = `
      export function countUp(n: number): number {
        let i: number = 0;
        do { i = i + 1; } while (i < n);
        return i;
      }
    `;
    expect(await run(src, "countUp", [5])).toBe(5);
    expect(await run(src, "countUp", [0])).toBe(1); // runs once even when cond is false
    expect(await run(src, "countUp", [1])).toBe(1);
  });

  it("break inside do-while", async () => {
    const src = `
      export function test(): number {
        let i: number = 0;
        do {
          i = i + 1;
          if (i === 3) break;
        } while (i < 10);
        return i;
      }
    `;
    expect(await run(src, "test", [])).toBe(3);
  });
});

describe("for-of", () => {
  it("sum array elements", async () => {
    const src = `
      export function test(): number {
        let sum: number = 0;
        for (const x of [1, 2, 3, 4, 5]) {
          sum = sum + x;
        }
        return sum;
      }
    `;
    expect(await run(src, "test", [])).toBe(15);
  });

  it("break inside for-of", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        for (const x of [10, 20, 30, 40]) {
          if (x === 30) break;
          result = result + x;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [])).toBe(30);
  });
});

describe("switch", () => {
  it("basic cases with return", async () => {
    const src = `
      export function classify(x: number): number {
        switch (x) {
          case 1: return 10;
          case 2: return 20;
          default: return 0;
        }
      }
    `;
    expect(await run(src, "classify", [1])).toBe(10);
    expect(await run(src, "classify", [2])).toBe(20);
    expect(await run(src, "classify", [99])).toBe(0);
  });

  it("switch with break and variable", async () => {
    const src = `
      export function test(x: number): number {
        let result: number = 0;
        switch (x) {
          case 1: result = 10; break;
          case 2: result = 20; break;
          default: result = 99;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [1])).toBe(10);
    expect(await run(src, "test", [2])).toBe(20);
    expect(await run(src, "test", [5])).toBe(99);
  });

  it("switch with no default", async () => {
    const src = `
      export function test(x: number): number {
        let r: number = 0;
        switch (x) {
          case 5: r = 50; break;
        }
        return r;
      }
    `;
    expect(await run(src, "test", [5])).toBe(50);
    expect(await run(src, "test", [3])).toBe(0);
  });
});
