import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Verify that exported functions with primitive TypeScript types
 * use concrete Wasm types (f64 for number, i32 for boolean) instead
 * of externref at the module boundary. This avoids boxing/unboxing
 * overhead at every JS<->Wasm call.
 *
 * Issue #598
 */

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

function getWat(source: string): string {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  return result.wat;
}

/** Find the (func $name ...) line in WAT and return the signature portion */
function getFuncSignature(wat: string, funcName: string): string | undefined {
  const lines = wat.split("\n");
  return lines.find(l => l.includes(`(func $${funcName} `));
}

describe("typed export signatures (#598)", () => {
  it("number params and return use f64, not externref", () => {
    const wat = getWat(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    const sig = getFuncSignature(wat, "add");
    expect(sig).toBeDefined();
    expect(sig).toContain("(param f64 f64)");
    expect(sig).toContain("(result f64)");
    expect(sig).not.toContain("externref");
  });

  it("boolean params and return use i32, not externref", () => {
    const wat = getWat(`
      export function negate(a: boolean): boolean {
        return !a;
      }
    `);
    const sig = getFuncSignature(wat, "negate");
    expect(sig).toBeDefined();
    expect(sig).toContain("(param i32)");
    expect(sig).toContain("(result i32)");
    expect(sig).not.toContain("externref");
  });

  it("void return emits no result type", () => {
    const wat = getWat(`
      export function doNothing(x: number): void {
        const y = x + 1;
      }
    `);
    const sig = getFuncSignature(wat, "doNothing");
    expect(sig).toBeDefined();
    expect(sig).toContain("(param f64)");
    expect(sig).not.toContain("result");
    expect(sig).not.toContain("externref");
  });

  it("exported number function is callable from JS with concrete values", async () => {
    expect(await run(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `, "add", [3, 4])).toBe(7);
  });

  it("exported boolean function works with JS booleans", async () => {
    expect(await run(`
      export function negate(a: boolean): boolean {
        return !a;
      }
    `, "negate", [1])).toBe(0);

    expect(await run(`
      export function negate(a: boolean): boolean {
        return !a;
      }
    `, "negate", [0])).toBe(1);
  });

  it("mixed number params with module-level globals still use f64", async () => {
    expect(await run(`
      const offset = 10;
      export function addOffset(a: number, b: number): number {
        return a + b + offset;
      }
    `, "addOffset", [3, 4])).toBe(17);
  });

  it("number function with optional param uses f64", () => {
    const wat = getWat(`
      export function add(a: number, b?: number): number {
        return a + (b || 0);
      }
    `);
    const sig = getFuncSignature(wat, "add");
    expect(sig).toBeDefined();
    expect(sig).toContain("(param f64 f64)");
    expect(sig).toContain("(result f64)");
    expect(sig).not.toContain("externref");
  });

  it("any-typed params correctly use externref", () => {
    const wat = getWat(`
      export function identity(a: any): any {
        return a;
      }
    `);
    const sig = getFuncSignature(wat, "identity");
    expect(sig).toBeDefined();
    expect(sig).toContain("externref");
  });

  it("string params use externref (strings are host objects)", () => {
    const wat = getWat(`
      export function getLen(s: string): number {
        return s.length;
      }
    `);
    const sig = getFuncSignature(wat, "getLen");
    expect(sig).toBeDefined();
    // String param should be externref, but result should be f64
    expect(sig).toContain("externref");
    expect(sig).toContain("(result f64)");
  });

  it("multi-param function with all numbers computes correctly", async () => {
    expect(await run(`
      export function compute(a: number, b: number, c: number): number {
        return a * b + c;
      }
    `, "compute", [3, 4, 5])).toBe(17);
  });
});
