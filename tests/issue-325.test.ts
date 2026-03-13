import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_tan: Math.tan,
    Math_asin: Math.asin,
    Math_acos: Math.acos,
    Math_atan: Math.atan,
    Math_atan2: Math.atan2,
    Math_exp: Math.exp,
    Math_log: Math.log,
    Math_log2: Math.log2,
    Math_log10: Math.log10,
    Math_pow: Math.pow,
    Math_random: Math.random,
    Math_acosh: Math.acosh,
    Math_asinh: Math.asinh,
    Math_atanh: Math.atanh,
    Math_cbrt: Math.cbrt,
    Math_expm1: Math.expm1,
    Math_log1p: Math.log1p,
    number_toString: (v: number) => String(v),
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": {
      concat: (a: string, b: string) => a + b,
      length: (s: string) => s.length,
      equals: (a: string, b: string) => (a === b ? 1 : 0),
      substring: (s: string, start: number, end: number) =>
        s.substring(start, end),
      charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    },
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports;
}

async function compileToWasm(source: string) {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

describe("Issue #325: Null pointer dereference in array rest destructuring", () => {
  it("lone rest element: const [...x] = [1, 2, 3]", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3];
        const [...x] = values;
        return x[0] + x[1] + x[2];
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("rest element after one binding: const [a, ...rest] = arr", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const arr: number[] = [10, 20, 30, 40];
        const [a, ...rest] = arr;
        return a + rest[0] + rest[1] + rest[2];
      }
    `);
    expect(exports.test()).toBe(100);
  });

  it("rest after elisions: const [, , ...x] = values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3, 4, 5];
        const [, , ...x] = values;
        return x[0] + x[1] + x[2];
      }
    `);
    // x should be [3, 4, 5]
    expect(exports.test()).toBe(12);
  });

  it("rest in for-loop initializer: for (const [...x] = [1]; ...)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        for (const [...x] = [1] as number[]; result < 1; ) {
          result = x[0];
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("rest in for-loop with let: for (let [...x] = values; ...)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3];
        let result = 0;
        for (let [...x] = values; result < 1; ) {
          result = x[0] + x[1] + x[2];
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("rest in for-loop with var: for (var [...x] = values; ...)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3];
        let result = 0;
        for (var [...x] = values; result < 1; ) {
          result = x[0] + x[1] + x[2];
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(6);
  });
});
