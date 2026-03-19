import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    __box_number: (v: number) => v,
    __unbox_number: (v: unknown) => Number(v),
    __box_boolean: (v: number) => Boolean(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    __typeof: (v: unknown) => typeof v,
    __typeof_number: (v: unknown) => (typeof v === "number" ? 1 : 0),
    __typeof_string: (v: unknown) => (typeof v === "string" ? 1 : 0),
    __typeof_boolean: (v: unknown) => (typeof v === "boolean" ? 1 : 0),
    __make_callback: () => null,
    number_toString: (v: number) => String(v),
    parseFloat: (s: any) => parseFloat(String(s)),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    Math_pow: Math.pow,
    Math_sin: Math.sin,
    Math_cos: Math.cos,
    Math_random: Math.random,
    Math_exp: Math.exp,
    Math_log: Math.log,
    Math_log2: Math.log2,
    Math_log10: Math.log10,
    Math_tan: Math.tan,
    Math_asin: Math.asin,
    Math_acos: Math.acos,
    Math_atan: Math.atan,
    Math_atan2: Math.atan2,
    Math_acosh: Math.acosh,
    Math_asinh: Math.asinh,
    Math_atanh: Math.atanh,
    Math_cbrt: Math.cbrt,
    Math_expm1: Math.expm1,
    Math_log1p: Math.log1p,
  };
  const imports: WebAssembly.Imports = { env };
  imports["wasm:js-string"] = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    fromCharCode: (c: number) => String.fromCharCode(c),
    cast: (s: unknown) => String(s),
    test: (v: unknown) => (typeof v === "string" ? 1 : 0),
  };
  return imports;
}

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) throw new Error(result.errors.map(e => `L${e.line}: ${e.message}`).join("\n"));
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("finally block execution count", () => {
  it("try + catch + finally: finally runs once on normal path", { timeout: 30000 }, async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          count += 1;
        } catch (e) {
        } finally {
          count += 10;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(11);
  });

  it("try + finally (no catch): finally runs once on normal path", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          count += 1;
        } finally {
          count += 10;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(11);
  });

  it("try + catch + finally: finally runs once on catch path", async () => {
    const src = `
      export function thrower(): number {
        throw 42;
      }
      export function test(): number {
        let count: number = 0;
        try {
          count += 1;
          thrower();
        } catch (e) {
          count += 100;
        } finally {
          count += 10;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(111);
  });

  it("try + catch + finally: catch throws, finally still runs once", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          try {
            throw 1;
          } catch (e) {
            count += 100;
            throw 2;
          } finally {
            count += 10;
          }
        } catch (e) {
        }
        return count;
      }
    `;
    // catch runs (+100), catch throws, inner finally runs (+10) = 110
    expect(await run(src, "test")).toBe(110);
  });

  it("nested try/catch/finally", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          try {
            count += 1;
          } catch (e) {
          } finally {
            count += 10;
          }
        } catch (e) {
        } finally {
          count += 100;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(111);
  });
});
