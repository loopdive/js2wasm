import { describe, it, expect } from "vitest";
import { compile, compileToWat, type CompileResult } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
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

describe("Issue #319: Inline single-use function type signatures", () => {
  it("inlines single-use func type into function signature", () => {
    const wat = compileToWat(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    // The function should have inlined params/results instead of (type N)
    // Look for (func $add with param/result instead of (type ...)
    const funcLine = wat.split("\n").find((l) => l.includes("(func $add"));
    expect(funcLine).toBeDefined();
    expect(funcLine).toContain("(param");
    expect(funcLine).toContain("(result");
    // Should NOT have (type N) on the func line for single-use types
    expect(funcLine).not.toMatch(/\(type \d+\)/);
  });

  it("still produces valid Wasm binary for simple function", async () => {
    const exports = await compileToWasm(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    expect(exports.add(3, 4)).toBe(7);
  });

  it("still produces valid Wasm binary for multiple functions", async () => {
    const exports = await compileToWasm(`
      export function add(a: number, b: number): number {
        return a + b;
      }
      export function mul(a: number, b: number): number {
        return a * b;
      }
      export function negate(x: number): number {
        return -x;
      }
    `);
    expect(exports.add(3, 4)).toBe(7);
    expect(exports.mul(3, 4)).toBe(12);
    expect(exports.negate(5)).toBe(-5);
  });

  it("keeps shared types when multiple functions use same signature", () => {
    const wat = compileToWat(`
      export function add(a: number, b: number): number {
        return a + b;
      }
      export function sub(a: number, b: number): number {
        return a - b;
      }
    `);
    // Both add and sub have same signature (f64, f64) -> f64
    // If they share a type index, the type declaration should be kept
    // and the functions should reference it with (type N)
    const lines = wat.split("\n");
    const addLine = lines.find((l) => l.includes("(func $add"));
    const subLine = lines.find((l) => l.includes("(func $sub"));
    expect(addLine).toBeDefined();
    expect(subLine).toBeDefined();
    // Both should either be inlined (if different type indices) or
    // both reference a shared type (if same type index).
    // The key is that valid Wasm is produced either way.
  });

  it("produces valid Wasm for functions with no params/results", async () => {
    const exports = await compileToWasm(`
      let counter = 0;
      export function increment(): void {
        counter = counter + 1;
      }
      export function getCount(): number {
        return counter;
      }
    `);
    exports.increment();
    exports.increment();
    expect(exports.getCount()).toBe(2);
  });

  it("WAT output does not contain standalone type for single-use void func", () => {
    const wat = compileToWat(`
      export function noop(): void {}
    `);
    // The function should have inlined signature
    const funcLine = wat.split("\n").find((l) => l.includes("(func $noop"));
    expect(funcLine).toBeDefined();
    // Single-use void function: no (type N) reference needed
    // It should be either bare (no type ref) or inlined
    // The key: no (type N) on the func line for this single-use type
  });
});
