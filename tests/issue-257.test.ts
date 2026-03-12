import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) =>
    s.substring(start, end),
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
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return instance.exports as Record<string, Function>;
}

describe("Issue #257: Method calls on returned values", () => {
  it("method call on function return value (class)", async () => {
    const exports = await compileToWasm(`
      class Obj {
        val: number;
        constructor(v: number) { this.val = v; }
        getVal(): number { return this.val; }
      }
      function makeObj(): Obj { return new Obj(42); }
      export function test(): number {
        return makeObj().getVal();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("chained method calls", async () => {
    const exports = await compileToWasm(`
      class Builder {
        value: number;
        constructor() { this.value = 0; }
        add(n: number): Builder {
          this.value = this.value + n;
          return this;
        }
        result(): number { return this.value; }
      }
      function makeBuilder(): Builder { return new Builder(); }
      export function test(): number {
        return makeBuilder().add(10).add(5).result();
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("method call on constructor return", async () => {
    const exports = await compileToWasm(`
      class Counter {
        count: number;
        constructor(start: number) { this.count = start; }
        getCount(): number { return this.count; }
      }
      export function test(): number {
        return new Counter(7).getCount();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("property access on function return value", async () => {
    const exports = await compileToWasm(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) { this.x = x; this.y = y; }
      }
      function makePoint(): Point { return new Point(3, 4); }
      export function test(): number {
        return makePoint().x + makePoint().y;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("element access method call on class instance: obj['method']()", async () => {
    const exports = await compileToWasm(`
      class Calc {
        value: number;
        constructor(v: number) { this.value = v; }
        double(): number { return this.value * 2; }
      }
      export function test(): number {
        const c = new Calc(21);
        return c['double']();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("element access method call on object literal with methods", async () => {
    const exports = await compileToWasm(`
      function makeObj() {
        return { x: 10, getX(): number { return this.x; } };
      }
      export function test(): number {
        const obj = makeObj();
        return obj['getX']();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("element access method call with arguments", async () => {
    const exports = await compileToWasm(`
      class Adder {
        base: number;
        constructor(b: number) { this.base = b; }
        add(n: number): number { return this.base + n; }
      }
      export function test(): number {
        const a = new Adder(10);
        return a['add'](32);
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
