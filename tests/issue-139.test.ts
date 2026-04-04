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
      substring: (s: string, start: number, end: number) => s.substring(start, end),
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
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, Function>;
}

describe("Issue #139: valueOf/toString coercion on arithmetic operators", () => {
  it("unary minus on object with valueOf", async () => {
    const exports = await compileToWasm(`
      class Obj {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): number {
        const obj = new Obj(5);
        return -obj;
      }
    `);
    expect(exports.test()).toBe(-5);
  });

  it("arithmetic multiplication with valueOf object", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): number {
        const a = new Num(10);
        return a * 3;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("all arithmetic operators with valueOf", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function add(): number { const n = new Num(5); return n + 3; }
      export function sub(): number { const n = new Num(10); return n - 3; }
      export function mul(): number { const n = new Num(4); return n * 5; }
      export function div(): number { const n = new Num(20); return n / 4; }
      export function mod(): number { const n = new Num(17); return n % 5; }
      export function neg(): number { const n = new Num(7); return -n; }
      export function pos(): number { const n = new Num(42); return +n; }
    `);
    expect(exports.add()).toBe(8);
    expect(exports.sub()).toBe(7);
    expect(exports.mul()).toBe(20);
    expect(exports.div()).toBe(5);
    expect(exports.mod()).toBe(2);
    expect(exports.neg()).toBe(-7);
    expect(exports.pos()).toBe(42);
  });

  it("both operands are valueOf objects", async () => {
    const exports = await compileToWasm(`
      class Num {
        val: number;
        constructor(v: number) { this.val = v; }
        valueOf(): number { return this.val; }
      }

      export function test(): number {
        const a = new Num(6);
        const b = new Num(7);
        return a * b;
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
