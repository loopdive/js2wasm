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

async function compileToWasm(source: string, allowJs = false) {
  const result = compile(source, allowJs ? { allowJs: true, fileName: "input.js" } : undefined);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return instance.exports as Record<string, Function>;
}

describe("Issue #379: Tuple/destructuring type errors", () => {
  it("empty array destructuring var [] = [] compiles in TS mode", () => {
    const result = compile(`
      export function test(): number {
        var [] = [];
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("empty array destructuring var [] = [] compiles in JS mode", () => {
    const result = compile(
      `
      function test() {
        var [] = [];
        return 0;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    expect(result.success).toBe(true);
  });

  it("var [x] = [] -- destructure from empty array (test262 pattern)", () => {
    // This triggers TS diagnostic 2493 which should be downgraded
    const result = compile(`
      export function test(): number {
        var [x] = [];
        return 0;
      }
    `);
    // Should compile without fatal errors
    expect(result.success).toBe(true);
  });

  it("array destructuring with rest element compiles and runs", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [1, 2, 3, 4, 5];
        var [a, ...rest] = arr;
        return a;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("object destructuring with rest element compiles and runs", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj = { a: 10, b: 20, c: 30 };
        var { a, ...rest } = obj;
        return a;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("basic array destructuring works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [10, 20, 30];
        var [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("basic object destructuring works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj = { x: 1, y: 2 };
        var { x, y } = obj;
        return x + y;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("object destructuring of boolean (test262: obj-empty-bool)", () => {
    const result = compile(`
      export function test(): number {
        var result;
        var vals = false;
        result = ({} = vals);
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("object destructuring of number (test262: obj-empty-num)", () => {
    const result = compile(`
      export function test(): number {
        var result;
        var vals = 42;
        result = ({} = vals);
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("object rest on number (test262: obj-rest-number)", () => {
    const result = compile(`
      export function test(): number {
        var rest;
        var result;
        var vals = 51;
        result = ({...rest} = vals);
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("statement-level object rest element has no field error", () => {
    const result = compile(`
      export function test(): number {
        var obj = { a: 10, b: 20, c: 30 };
        var { a, ...rest } = obj;
        return a;
      }
    `);
    const fieldErrors = result.errors.filter((e) => e.message.includes("Unknown field in destructuring"));
    expect(fieldErrors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("destructuring with unknown source type in JS mode", () => {
    const result = compile(
      `
      function test(x) {
        var { a, b } = x;
        return 0;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    expect(result.success).toBe(true);
  });

  it("array destructuring on unknown type in JS mode", () => {
    const result = compile(
      `
      function test(x) {
        var [a, b] = x;
        return 0;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    expect(result.success).toBe(true);
  });

  it("rest element in array destructuring extracts rest correctly", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [10, 20, 30, 40];
        var [a, ...rest] = arr;
        return a + rest[0] + rest[1];
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("empty array pattern with non-empty RHS compiles", () => {
    const result = compile(`
      export function test(): number {
        var [] = [1, 2, 3];
        return 42;
      }
    `);
    expect(result.success).toBe(true);
  });
});
