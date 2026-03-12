import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";
import ts from "typescript";

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

function evaluateAsJs(source: string): Record<string, Function> {
  const jsOutput = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const fn = new Function("exports", "module", "Math", jsOutput.outputText);
  fn(exports, module, Math);
  return exports as Record<string, Function>;
}

async function assertEquivalent(
  source: string,
  testCases: { fn: string; args: unknown[]; approx?: boolean }[],
) {
  const wasmExports = await compileToWasm(source);
  const jsExports = evaluateAsJs(source);

  for (const { fn, args, approx } of testCases) {
    const wasmResult = wasmExports[fn]!(...args);
    const jsResult = jsExports[fn]!(...args);

    if (approx) {
      expect(wasmResult).toBeCloseTo(jsResult as number, 10);
    } else {
      expect(wasmResult).toBe(jsResult);
    }
  }
}

describe("Issue #272: type mismatch -- stale funcIdx after addUnionImports", () => {
  it("class constructor with any-typed parameter (new triggers boxing coercion)", async () => {
    await assertEquivalent(
      `
      class Obj {
        val: any;
        constructor(v: any) { this.val = v; }
        getVal(): any { return this.val; }
      }
      export function test(): number {
        const o = new Obj(42);
        return o.getVal() + 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class method call with any-typed arguments", async () => {
    await assertEquivalent(
      `
      class Calculator {
        add(a: any, b: any): any { return a + b; }
      }
      export function test(): number {
        const c = new Calculator();
        return c.add(3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("static method call with any-typed parameter", async () => {
    await assertEquivalent(
      `
      class MathHelper {
        static double(x: any): any { return x * 2; }
      }
      export function test(): number {
        return MathHelper.double(5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super method call with coercion in arguments", async () => {
    await assertEquivalent(
      `
      class Base {
        getValue(): number { return 42; }
      }
      class Derived extends Base {
        getValue(): number { return super.getValue() + 1; }
      }
      export function test(): number {
        const d = new Derived();
        return d.getValue();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("constructor with multiple any-typed args causing late import shift", async () => {
    await assertEquivalent(
      `
      class Container {
        a: any;
        b: any;
        constructor(a: any, b: any) { this.a = a; this.b = b; }
        sum(): any { return this.a + this.b; }
      }
      export function test(): number {
        const c = new Container(10, 20);
        return c.sum();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained method calls with any types", async () => {
    await assertEquivalent(
      `
      function toNum(x: any): number { return x; }
      function toAny(x: number): any { return x; }
      export function test(): number { return toNum(toAny(42)); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class instance used in numeric expression", async () => {
    await assertEquivalent(
      `
      class Counter {
        count: number = 0;
        increment(): number { this.count++; return this.count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        return c.increment();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
