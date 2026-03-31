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

describe("Issue #277: local.set type mismatch coercion", () => {
  it("assign number to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = 42;
        return x as number;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("assign boolean to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = true;
        return x ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("assign string to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = "hello";
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("reassign any-typed variable with different types", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = 10;
        x = 20;
        return x as number;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("assign struct to externref-typed local", async () => {
    const exports = await compileToWasm(`
      interface Point { x: number; y: number }
      export function test(): number {
        let p: any = { x: 3, y: 4 };
        return 7;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("assign number|string union variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number | string = 42;
        return 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("function returning any assigned to typed local", async () => {
    const exports = await compileToWasm(`
      function getVal(): any { return 5; }
      export function test(): number {
        let x: number = getVal();
        return x;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("assign array to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = [1, 2, 3];
        return 6;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("multiple any-typed assignments in sequence", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let a: any = 1;
        let b: any = 2;
        let c: any = 3;
        return (a as number) + (b as number) + (c as number);
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("for loop with any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum: any = 0;
        for (let i = 0; i < 5; i++) {
          sum = (sum as number) + i;
        }
        return sum as number;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("var hoisted then assigned a concrete value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: any;
        x = 42;
        return x as number;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("conditional branches assign different types to same local", async () => {
    const exports = await compileToWasm(`
      export function test(flag: number): number {
        var result: any;
        if (flag > 0) {
          result = 1;
        } else {
          result = 0;
        }
        return result as number;
      }
    `);
    expect(exports.test(1)).toBe(1);
    expect(exports.test(0)).toBe(0);
  });

  it("assign object literal to any-typed variable then use it", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let obj: any = { x: 10, y: 20 };
        return 30;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("function parameter typed as any receives number", async () => {
    const exports = await compileToWasm(`
      function process(val: any): number {
        return val as number;
      }
      export function test(): number {
        return process(42);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("assign closure to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let fn: any = () => 42;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("var re-declaration with different types", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x = 10;
        var x = 20;
        return x;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("assign to variable in nested scope with type widening", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number | boolean = 5;
        if (true) {
          x = 10;
        }
        return x as number;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("ternary expression with mixed types assigned to any", async () => {
    const exports = await compileToWasm(`
      export function test(flag: number): number {
        let x: any = flag > 0 ? 1 : 0;
        return x as number;
      }
    `);
    expect(exports.test(1)).toBe(1);
  });

  it("for-of loop with array elements", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let arr = [10, 20, 30];
        let sum = 0;
        for (let x of arr) {
          sum += x;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("for-loop var initializer with hoisted type mismatch", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var i: number;
        for (var i = 0; i < 3; i++) {}
        return i;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("assignment result used in expression context", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        let y: number = (x = 5);
        return x + y;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("array destructuring with type coercion", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let arr = [1, 2, 3];
        let [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("object destructuring with field type coercion", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let obj = { x: 10, y: 20 };
        let { x, y } = obj;
        return x + y;
      }
    `);
    expect(exports.test()).toBe(30);
  });
});
