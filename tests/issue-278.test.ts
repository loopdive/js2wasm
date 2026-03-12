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

describe("Issue #278: Destructuring non-struct types", () => {
  it("destructure function return value", async () => {
    const exports = await compileToWasm(`
      function getPair(): { a: number; b: number } {
        return { a: 10, b: 20 };
      }
      export function test(): number {
        const { a, b } = getPair();
        return a + b;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("destructure inline object with __type symbol", async () => {
    const exports = await compileToWasm(`
      function makeObj() {
        return { x: 3, y: 4 };
      }
      export function test(): number {
        const { x, y } = makeObj();
        return x + y;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("destructure with renaming", async () => {
    const exports = await compileToWasm(`
      function getCoords(): { x: number; y: number } {
        return { x: 5, y: 10 };
      }
      export function test(): number {
        const { x: a, y: b } = getCoords();
        return a * b;
      }
    `);
    expect(exports.test()).toBe(50);
  });

  it("nested function returning object for destructuring", async () => {
    const exports = await compileToWasm(`
      function compute(n: number): { sum: number; product: number } {
        return { sum: n + 1, product: n * 2 };
      }
      export function test(): number {
        const { sum, product } = compute(5);
        return sum + product;
      }
    `);
    expect(exports.test()).toBe(16);
  });

  it("destructure parameter-returned object", async () => {
    const exports = await compileToWasm(`
      function wrap(a: number, b: number): { first: number; second: number } {
        return { first: a, second: b };
      }
      export function test(): number {
        const { first, second } = wrap(100, 200);
        return first + second;
      }
    `);
    expect(exports.test()).toBe(300);
  });
});
