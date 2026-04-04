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

describe("Issue #259: ClassDeclaration in block scope", () => {
  it("class inside if block", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (true) {
          class Foo {
            val: number;
            constructor() { this.val = 42; }
            getVal(): number { return this.val; }
          }
          const f = new Foo();
          return f.getVal();
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("class inside else block", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (false) {
          return 0;
        } else {
          class Bar {
            x: number;
            constructor() { this.x = 99; }
            getX(): number { return this.x; }
          }
          const b = new Bar();
          return b.getX();
        }
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("class inside bare block", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        {
          class Inner {
            value: number;
            constructor() { this.value = 7; }
            getValue(): number { return this.value; }
          }
          const obj = new Inner();
          return obj.getValue();
        }
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("class with multiple methods inside block", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (true) {
          class Calculator {
            val: number;
            constructor() { this.val = 10; }
            add(x: number): number { return this.val + x; }
            mul(x: number): number { return this.val * x; }
          }
          const c = new Calculator();
          return c.add(5) + c.mul(3);
        }
        return 0;
      }
    `);
    // add(5) = 10 + 5 = 15, mul(3) = 10 * 3 = 30, total = 45
    expect(exports.test()).toBe(45);
  });
});
