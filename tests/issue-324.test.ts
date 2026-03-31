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

describe("Issue #324: Runtime test failures (wrong return values)", () => {
  // Missing Math constants: SQRT1_2, LOG2E, LOG10E
  it("Math.SQRT1_2 returns correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.SQRT1_2;
      }
    `);
    expect(exports.test()).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("Math.LOG2E returns correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.LOG2E;
      }
    `);
    expect(exports.test()).toBeCloseTo(Math.LOG2E, 10);
  });

  it("Math.LOG10E returns correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.LOG10E;
      }
    `);
    expect(exports.test()).toBeCloseTo(Math.LOG10E, 10);
  });

  // Math.min/max must not skip evaluation of arguments when one is NaN
  it("Math.min with NaN still evaluates all args", async () => {
    const exports = await compileToWasm(`
      let calls = 0;
      function countAndReturn(x: number): number {
        calls++;
        return x;
      }
      export function test(): number {
        calls = 0;
        Math.min(NaN, countAndReturn(5));
        return calls;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.max with NaN still evaluates all args", async () => {
    const exports = await compileToWasm(`
      let calls = 0;
      function countAndReturn(x: number): number {
        calls++;
        return x;
      }
      export function test(): number {
        calls = 0;
        Math.max(NaN, countAndReturn(5));
        return calls;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Math.min/max with 0 args
  it("Math.min() with no args returns Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.min();
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  it("Math.max() with no args returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.max();
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  // Math.min/max basic NaN propagation
  it("Math.min(NaN, 5) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.min(NaN, 5);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("Math.max(NaN, 5) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.max(NaN, 5);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  // Math.min/max with negative zero
  it("Math.min(0, -0) returns -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.min(0, -0);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.max(-0, 0) returns +0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.max(-0, 0);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  // Math.pow edge cases
  it("Math.pow with NaN exponent returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(2, NaN);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("Math.pow(1, NaN) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(1, NaN);
      }
    `);
    // Per spec, Math.pow(1, NaN) should be NaN
    expect(exports.test()).toBeNaN();
  });

  // Math.atanh edge cases
  it("Math.atanh(-1) returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.atanh(-1);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.atanh(1) returns Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.atanh(1);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  it("Math.atanh(2) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.atanh(2);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  // Math.expm1 edge cases
  it("Math.expm1(-Infinity) returns -1", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.expm1(-Infinity);
      }
    `);
    expect(exports.test()).toBe(-1);
  });

  it("Math.expm1(Infinity) returns Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.expm1(Infinity);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  // Math.log2 basic cases
  it("Math.log2(1) returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log2(1);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("Math.log2(8) returns 3", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log2(8);
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("Math.log2(-1) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log2(-1);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  // Math.log10 basic cases
  it("Math.log10(1) returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(1);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("Math.log10(100) returns 2", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(100);
      }
    `);
    expect(exports.test()).toBe(2);
  });

  // Basic addition sanity check
  it("1 + 1 === 2", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 + 1;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  it("variable addition works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 1;
        let y = 1;
        return x + y;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  // Math.sign
  it("Math.sign works for positive numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.sign(5);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.sign works for negative numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.sign(-5);
      }
    `);
    expect(exports.test()).toBe(-1);
  });

  it("Math.sign(0) returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.sign(0);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  // Math.pow edge cases for -Infinity base
  it("Math.pow(-Infinity, 1) returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(-Infinity, 1);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.pow(-Infinity, 3) returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(-Infinity, 3);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.pow(-Infinity, 2) returns +Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(-Infinity, 2);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  it("Math.pow(-Infinity, -1) returns -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.pow(-Infinity, -1);
      }
    `);
    expect(exports.test()).toBe(-Infinity); // 1/(-0) = -Infinity
  });

  // Math.pow edge cases for -0 base
  it("Math.pow(-0, 3) returns -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.pow(-0, 3);
      }
    `);
    expect(exports.test()).toBe(-Infinity); // 1/(-0) = -Infinity
  });

  it("Math.pow(-0, 2) returns +0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.pow(-0, 2);
      }
    `);
    expect(exports.test()).toBe(Infinity); // 1/(+0) = +Infinity
  });

  // Math.pow(NaN, 0) returns 1
  it("Math.pow(NaN, 0) returns 1", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(NaN, 0);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Math.log10 exact values
  it("Math.log10(10) returns exactly 1", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(10);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.log10(1000) returns exactly 3", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(1000);
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
