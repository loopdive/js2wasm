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

describe("TypedArray basic support", () => {
  it("new Uint8Array(n) creates array of length n", async () => {
    const src = `
      export function test(): number {
        const arr = new Uint8Array(4);
        return arr.length;
      }
    `;
    expect(await run(src, "test")).toBe(4);
  });

  it("new Int32Array(n) creates array of length n", async () => {
    const src = `
      export function test(): number {
        const arr = new Int32Array(8);
        return arr.length;
      }
    `;
    expect(await run(src, "test")).toBe(8);
  });

  it("new Float64Array(n) creates array of length n", async () => {
    const src = `
      export function test(): number {
        const arr = new Float64Array(3);
        return arr.length;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  });

  it("element read/write on Uint8Array", async () => {
    const src = `
      export function test(): number {
        const arr = new Uint8Array(4);
        arr[0] = 10;
        arr[1] = 20;
        arr[2] = 30;
        arr[3] = 40;
        return arr[0] + arr[1] + arr[2] + arr[3];
      }
    `;
    expect(await run(src, "test")).toBe(100);
  });

  it("element read/write on Int32Array", async () => {
    const src = `
      export function test(): number {
        const arr = new Int32Array(3);
        arr[0] = 100;
        arr[1] = -200;
        arr[2] = 300;
        return arr[0] + arr[1] + arr[2];
      }
    `;
    expect(await run(src, "test")).toBe(200);
  });

  it("element read/write on Float64Array", async () => {
    const src = `
      export function test(): number {
        const arr = new Float64Array(2);
        arr[0] = 3.14;
        arr[1] = 2.718;
        return arr[0] + arr[1];
      }
    `;
    const result = await run(src, "test") as number;
    expect(result).toBeCloseTo(5.858, 5);
  });

  it("new TypedArray() with no args creates empty array", async () => {
    const src = `
      export function test(): number {
        const arr = new Uint8Array();
        return arr.length;
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("TypedArray default values are 0", async () => {
    const src = `
      export function test(): number {
        const arr = new Float64Array(3);
        return arr[0] + arr[1] + arr[2];
      }
    `;
    expect(await run(src, "test")).toBe(0);
  });

  it("TypedArray used in loop", async () => {
    const src = `
      export function test(): number {
        const arr = new Int32Array(5);
        for (let i = 0; i < 5; i++) {
          arr[i] = i * i;
        }
        return arr[0] + arr[1] + arr[2] + arr[3] + arr[4];
      }
    `;
    // 0 + 1 + 4 + 9 + 16 = 30
    expect(await run(src, "test")).toBe(30);
  });

  it("Float32Array support", async () => {
    const src = `
      export function test(): number {
        const arr = new Float32Array(2);
        arr[0] = 1.5;
        arr[1] = 2.5;
        return arr[0] + arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(4);
  });

  it("Uint16Array support", async () => {
    const src = `
      export function test(): number {
        const arr = new Uint16Array(2);
        arr[0] = 1000;
        arr[1] = 2000;
        return arr[0] + arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(3000);
  });
});
