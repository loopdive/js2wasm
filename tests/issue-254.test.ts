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

describe("Issue #254: Private class fields and methods (#field)", () => {
  it("private field assignment in constructor", async () => {
    const exports = await compileToWasm(`
      class Counter {
        #count;
        constructor() {
          this.#count = 0;
        }
        getCount() {
          return this.#count;
        }
      }
      export function test(): number {
        const c = new Counter();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("private field mutation in methods", async () => {
    const exports = await compileToWasm(`
      class Counter {
        #count;
        constructor() {
          this.#count = 0;
        }
        increment() {
          this.#count = this.#count + 1;
        }
        getCount() {
          return this.#count;
        }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        c.increment();
        return c.getCount();
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("multiple private fields", async () => {
    const exports = await compileToWasm(`
      class Point {
        #x;
        #y;
        constructor(x, y) {
          this.#x = x;
          this.#y = y;
        }
        sum() {
          return this.#x + this.#y;
        }
      }
      export function test(): number {
        const p = new Point(10, 20);
        return p.sum();
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("private field with initializer", async () => {
    const exports = await compileToWasm(`
      class Box {
        #value = 42;
        getValue() {
          return this.#value;
        }
      }
      export function test(): number {
        const b = new Box();
        return b.getValue();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("private field compound assignment", async () => {
    const exports = await compileToWasm(`
      class Accumulator {
        #total = 0;
        add(n) {
          this.#total = this.#total + n;
        }
        getTotal() {
          return this.#total;
        }
      }
      export function test(): number {
        const a = new Accumulator();
        a.add(5);
        a.add(10);
        a.add(15);
        return a.getTotal();
      }
    `);
    expect(exports.test()).toBe(30);
  });
});
