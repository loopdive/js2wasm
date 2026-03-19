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

describe("i32 loop inference (#595)", { timeout: 30000 }, () => {
  it("basic for loop with i++ produces correct results", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          sum += i;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(45);
  });

  it("for loop with ++i produces correct results", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 5; ++i) {
          sum += i;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(10);
  });

  it("for loop with i += 1 produces correct results", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 8; i += 1) {
          sum += i;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(28);
  });

  it("for loop with i += 2 (step) produces correct results", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i += 2) {
          sum += i;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(20); // 0 + 2 + 4 + 6 + 8
  });

  it("for loop with <= condition produces correct results", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 1; i <= 5; i++) {
          sum += i;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(15);
  });

  it("for loop counter used in array indexing", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30, 40, 50];
        let sum = 0;
        for (let i = 0; i < 5; i++) {
          sum += arr[i];
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(150);
  });

  it("for loop counter used in arithmetic expressions", async () => {
    const src = `
      export function test(): number {
        let result = 0;
        for (let i = 0; i < 5; i++) {
          result += i * 2 + 1;
        }
        return result;
      }
    `;
    expect(await run(src, "test")).toBe(25);
  });

  it("nested for loops with i32 counters", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 4; j++) {
            sum += 1;
          }
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(12);
  });

  it("for loop with non-zero start", async () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 5; i < 10; i++) {
          sum += i;
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(35);
  });

  it("for loop counter used as function argument (i32 -> f64 coercion)", async () => {
    const src = `
      function double(n: number): number {
        return n * 2;
      }
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 5; i++) {
          sum += double(i);
        }
        return sum;
      }
    `;
    expect(await run(src, "test")).toBe(20);
  });

  it("WAT output contains i32 local for loop counter", () => {
    const src = `
      export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          sum += i;
        }
        return sum;
      }
    `;
    const result = compile(src, { emitWat: true });
    expect(result.success).toBe(true);
    // The WAT should contain an i32 local for the loop counter variable
    expect(result.wat).toContain("i32");
    // Should have i32.const for the init value
    expect(result.wat).toContain("i32.const");
    // Should have i32.add for the increment
    expect(result.wat).toContain("i32.add");
  });
});
