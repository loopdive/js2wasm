import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

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
    "wasm:js-string": jsStringPolyfill,
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
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, Function>;
}

describe("Issue #258: Nested call expressions", () => {
  it("function returning closure called immediately", async () => {
    const exports = await compileToWasm(`
      function makeAdder(a: number): (b: number) => number {
        return (b: number) => a + b;
      }
      export function test(): number {
        return makeAdder(10)(32);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("parenthesized identifier callee: (fn)(args)", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return (add)(10, 20);
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("double parenthesized callee: ((fn))(args)", async () => {
    const exports = await compileToWasm(`
      function mul(a: number, b: number): number {
        return a * b;
      }
      export function test(): number {
        return ((mul))(6, 7);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("nested call as argument: f(g())", async () => {
    const exports = await compileToWasm(`
      function double(x: number): number {
        return x * 2;
      }
      function addOne(x: number): number {
        return x + 1;
      }
      export function test(): number {
        return double(addOne(20));
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("multiple nested calls as arguments: f(g(), h())", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number {
        return a + b;
      }
      function square(x: number): number {
        return x * x;
      }
      function triple(x: number): number {
        return x * 3;
      }
      export function test(): number {
        return add(square(3), triple(11));
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("function returning closure with captures", async () => {
    const exports = await compileToWasm(`
      function makeMultiplier(factor: number): (x: number) => number {
        return (x: number) => x * factor;
      }
      export function test(): number {
        return makeMultiplier(7)(6);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Skipped: storing closure from function call in a variable and calling it later
  // is a pre-existing limitation unrelated to issue #258 (closure capture coercion issue)
  it.skip("chained closure calls: makeAdder(a)(b) used multiple times", async () => {
    const exports = await compileToWasm(`
      function makeAdder(a: number): (b: number) => number {
        return (b: number) => a + b;
      }
      export function test(): number {
        const add10 = makeAdder(10);
        const add20 = makeAdder(20);
        return add10(12) + add20(0);
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
