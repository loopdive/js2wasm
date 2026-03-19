import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
  };
  env["number_toString"] = (v: number) => String(v);

  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("array out-of-bounds guards (#540)", () => {
  it("element access out of bounds returns default (not trap)", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        const x = arr[5]; // out of bounds
        return x === undefined ? -1 : x;
      }
    `;
    const result = await run(src, "test");
    expect(typeof result).toBe("number");
  });

  it("negative index returns default (not trap)", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        const x = arr[-1]; // out of bounds
        return x === undefined ? -1 : x;
      }
    `;
    const result = await run(src, "test");
    expect(typeof result).toBe("number");
  });

  it("compound assignment on in-bounds element works correctly", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        arr[1] += 5;
        return arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(25);
  });

  it("increment on array element works correctly", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        arr[1]++;
        return arr[1];
      }
    `;
    expect(await run(src, "test")).toBe(21);
  });

  it("destructuring more elements than array has should not trap", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [1, 2];
        const [a, b, c] = arr;
        return a + b;
      }
    `;
    const result = await run(src, "test");
    expect(result).toBe(3);
  }, 15000);

  it("in-bounds element access still works correctly", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        return arr[0] + arr[1] + arr[2];
      }
    `;
    expect(await run(src, "test")).toBe(60);
  });

  it("prefix decrement on array element works", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        --arr[0];
        return arr[0];
      }
    `;
    expect(await run(src, "test")).toBe(9);
  });

  it("postfix increment returns old value", async () => {
    const src = `
      export function test(): number {
        const arr = [10, 20, 30];
        const old = arr[0]++;
        return old;
      }
    `;
    expect(await run(src, "test")).toBe(10);
  });
});
