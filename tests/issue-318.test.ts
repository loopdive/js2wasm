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

describe("Issue #318: Infer parameter types from call-site arguments", () => {
  it("infers number param type from call site", async () => {
    const exports = await compileToWasm(`
      function add(a, b) {
        return a + b;
      }
      export function test(): number {
        return add(3, 4);
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("infers number param from multiple consistent call sites", async () => {
    const exports = await compileToWasm(`
      function double(x) {
        return x * 2;
      }
      export function test(): number {
        const a = double(5);
        const b = double(10);
        return a + b;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("infers boolean param type from call site", async () => {
    const exports = await compileToWasm(`
      function negate(flag) {
        return flag ? 0 : 1;
      }
      export function test(): number {
        return negate(true);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("handles mixed typed and untyped params", async () => {
    const exports = await compileToWasm(`
      function compute(x: number, y) {
        return x + y;
      }
      export function test(): number {
        return compute(10, 20);
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("infers type for helper function called from exported function", async () => {
    const exports = await compileToWasm(`
      function square(n) {
        return n * n;
      }
      export function test(): number {
        return square(6);
      }
    `);
    expect(exports.test()).toBe(36);
  });

  it("correctly handles untyped params with arithmetic operations", async () => {
    const exports = await compileToWasm(`
      function subtract(a, b) {
        return a - b;
      }
      export function test(): number {
        return subtract(10, 3);
      }
    `);
    expect(exports.test()).toBe(7);
  });
});
