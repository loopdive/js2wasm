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

function compileOnly(source: string): { success: boolean; errors: { message: string }[] } {
  return compile(source);
}

describe("ArrayBuffer and DataView constructors", () => {
  it("new ArrayBuffer(n) compiles without error", () => {
    const result = compileOnly(`
      const buf = new ArrayBuffer(16);
      export function test(): number { return 42; }
    `);
    expect(result.success).toBe(true);
  });

  it("new ArrayBuffer(n) runs and returns a value", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const buf = new ArrayBuffer(16);
        return 42;
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("new DataView(buffer) compiles without error", () => {
    const result = compileOnly(`
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      export function test(): number { return 99; }
    `);
    expect(result.success).toBe(true);
  });

  it("new DataView(buffer) runs and returns a value", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        return 99;
      }
    `,
        "test",
      ),
    ).toBe(99);
  });

  it("new ArrayBuffer(0) creates an empty buffer", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const buf = new ArrayBuffer(0);
        return 1;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("new Uint8Array(n) compiles and runs", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const arr = new Uint8Array(4);
        return 4;
      }
    `,
        "test",
      ),
    ).toBe(4);
  });

  it("new Int32Array(n) compiles and runs", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const arr = new Int32Array(8);
        return 8;
      }
    `,
        "test",
      ),
    ).toBe(8);
  });

  it("new Float64Array(n) compiles and runs", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const arr = new Float64Array(16);
        return 16;
      }
    `,
        "test",
      ),
    ).toBe(16);
  });
});
