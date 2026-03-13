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
    parseInt: (s: any, radix: number) => {
      const r = isNaN(radix) ? undefined : radix;
      return parseInt(String(s), r);
    },
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

describe("Issue #344: Wrapper constructors (new Number, new String, new Boolean)", () => {
  it("new Number(42).valueOf() returns 42", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(42);
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("new Number() with no args defaults to 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number();
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("new Number(3.14).valueOf() returns 3.14", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(3.14);
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBeCloseTo(3.14, 10);
  });

  it("new Boolean(true).valueOf() returns true", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean(true);
        return b.valueOf();
      }
    `);
    expect(exports.test()).toBe(1); // i32 truthy
  });

  it("new Boolean(false).valueOf() returns false", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean(false);
        return b.valueOf();
      }
    `);
    expect(exports.test()).toBe(0); // i32 falsy
  });

  it("new Boolean() with no args defaults to false", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean();
        return b.valueOf();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("new Number wrapper auto-unboxes in arithmetic", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(10);
        return n.valueOf() + 5;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("new Number with expression argument", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a = 3;
        const b = 4;
        const n = new Number(a + b);
        return n.valueOf();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("typeof new Number() returns 'object'", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const n = new Number(42);
        return typeof n === "object";
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("typeof new Boolean() returns 'object'", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        const b = new Boolean(true);
        return typeof b === "object";
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("wrapper Number in arithmetic coercion via valueOf", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(7);
        const result: number = n.valueOf() * 2;
        return result;
      }
    `);
    expect(exports.test()).toBe(14);
  });

  it("multiple wrapper constructors in same function", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const n = new Number(10);
        const b = new Boolean(true);
        return n.valueOf() + (b.valueOf() ? 1 : 0);
      }
    `);
    expect(exports.test()).toBe(11);
  });
});
