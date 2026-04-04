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

describe("Issue #199: Labeled statement compile errors", () => {
  it("labeled block with break", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        outer: {
          x = 1;
          break outer;
          x = 2;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("labeled block with conditional break", async () => {
    const exports = await compileToWasm(`
      export function test(n: number): number {
        let result: number = 0;
        myBlock: {
          result = 10;
          if (n > 5) break myBlock;
          result = 20;
        }
        return result;
      }
    `);
    expect(exports.test(10)).toBe(10);
    expect(exports.test(3)).toBe(20);
  });

  it("nested labeled blocks", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        outer: {
          x = 1;
          inner: {
            x = 2;
            break outer;
            x = 3;
          }
          x = 4;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  it("labeled block break inner only", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        outer: {
          x = 1;
          inner: {
            x = 2;
            break inner;
            x = 3;
          }
          x = x + 10;
        }
        return x;
      }
    `);
    // inner block: x=2, break inner (skip x=3), then x = 2 + 10 = 12
    expect(exports.test()).toBe(12);
  });

  it("label on expression statement (no-op label)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        myLabel: x = 42;
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("label on if statement with break", async () => {
    const exports = await compileToWasm(`
      export function test(n: number): number {
        let result: number = 0;
        myLabel: if (n > 0) {
          result = 1;
          if (n > 10) break myLabel;
          result = 2;
        }
        return result;
      }
    `);
    expect(exports.test(5)).toBe(2);
    expect(exports.test(15)).toBe(1);
    expect(exports.test(-1)).toBe(0);
  });

  it("labeled for loop with break (existing support)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum: number = 0;
        outer: for (let i: number = 0; i < 10; i = i + 1) {
          for (let j: number = 0; j < 10; j = j + 1) {
            if (i === 2 && j === 3) break outer;
            sum = sum + 1;
          }
        }
        return sum;
      }
    `);
    // i=0: 10, i=1: 10, i=2: j=0,1,2 (3), then break
    expect(exports.test()).toBe(23);
  });

  it("labeled while loop with continue outer", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let count: number = 0;
        let i: number = 0;
        outer: while (i < 3) {
          i = i + 1;
          let j: number = 0;
          while (j < 5) {
            j = j + 1;
            if (j === 2) continue outer;
            count = count + 1;
          }
        }
        return count;
      }
    `);
    // Each outer: j=1 (count+1), j=2 continues outer. 3 iterations * 1 = 3
    expect(exports.test()).toBe(3);
  });

  it("label on switch with break label", async () => {
    const exports = await compileToWasm(`
      export function test(n: number): number {
        let result: number = -1;
        mySwitch: switch (n) {
          case 1:
            result = 10;
            break mySwitch;
          case 2:
            result = 20;
            break mySwitch;
          default:
            result = 0;
        }
        return result;
      }
    `);
    expect(exports.test(1)).toBe(10);
    expect(exports.test(2)).toBe(20);
    expect(exports.test(99)).toBe(0);
  });

  it("multiple labels on same loop (nested labels)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        a: b: for (let i: number = 0; i < 5; i = i + 1) {
          x = x + 1;
          if (i === 2) break a;
        }
        return x;
      }
    `);
    // i=0: x=1, i=1: x=2, i=2: x=3, break a
    expect(exports.test()).toBe(3);
  });

  it("labeled do-while with break", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let count: number = 0;
        outer: do {
          count = count + 1;
          if (count === 3) break outer;
        } while (count < 10);
        return count;
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
