import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

function buildImports(result: any): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    __box_number: (v: number) => v,
    __unbox_number: (v: unknown) => Number(v),
    __extern_get: (obj: any, key: any) => (obj == null ? undefined : obj[key]),
    __extern_set: (obj: any, key: any, val: any) => { if (obj != null) obj[key] = val; },
    __extern_length: (obj: any) => (obj == null ? 0 : obj.length),
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    number_toString: (v: number) => String(v),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __box_boolean: (v: number) => Boolean(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    Math_pow: Math.pow,
    Math_random: Math.random,
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) => s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    },
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

async function run(source: string): Promise<Record<string, any>> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, any>;
}

describe("Assignment to non-array - array destructuring from externref (#615)", () => {
  it("array destructuring assignment from any-typed variable", async () => {
    const exports = await run(`
      export function test(arr: any): number {
        let a: any, b: any, c: any;
        [a, b, c] = arr;
        return Number(a) + Number(b) + Number(c);
      }
    `);
    expect(exports.test([10, 20, 30])).toBe(60);
  });

  it("array destructuring assignment with holes from externref", async () => {
    const exports = await run(`
      export function test(arr: any): number {
        let a: any, c: any;
        [a, , c] = arr;
        return Number(a) + Number(c);
      }
    `);
    expect(exports.test([1, 2, 3])).toBe(4);
  });

  it("array destructuring assignment with default values from externref (value present)", async () => {
    const exports = await run(`
      export function test(arr: any): any {
        let a: any, b: any;
        [a, b = 99] = arr;
        return b;
      }
    `);
    // When array has value at index 1, use it
    expect(exports.test([1, 2])).toBe(2);
  });

  it("array destructuring assignment with default values from externref (null triggers default)", async () => {
    const exports = await run(`
      export function test(arr: any): any {
        let a: any, b: any;
        [a, b = 99] = arr;
        return b;
      }
    `);
    // When element is null, use default
    expect(exports.test([1, null])).toBe(99);
  });

  it("const array destructuring from any-typed parameter", async () => {
    const exports = await run(`
      export function test(arr: any): any {
        const [a, b, c] = arr;
        return a;
      }
    `);
    expect(exports.test([10, 20, 30])).toBe(10);
  });

  it("let array destructuring from any-typed parameter", async () => {
    const exports = await run(`
      export function test(arr: any): any {
        let [x, y] = arr;
        return x;
      }
    `);
    expect(exports.test([42, 99])).toBe(42);
  });

  it("compiles without error when destructuring externref array", async () => {
    // This should compile without "Assignment to non-array" or "Cannot destructure" errors
    const result = compile(`
      export function test(x: any): any {
        let a: any, b: any;
        [a, b] = x;
        return a;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.errors.filter((e: any) => e.message.includes("non-array"))).toHaveLength(0);
    expect(result.errors.filter((e: any) => e.message.includes("Cannot destructure"))).toHaveLength(0);
  });
});
