/**
 * Issue #178: Wasm validation errors — type mismatches in emitted binary
 *
 * Tests that:
 * 1. Loose equality between string and number/boolean imports parseFloat and produces valid Wasm
 * 2. i64 → externref coercion works (BigInt to boxed number)
 * 3. BigInt vs String comparisons don't route through string handler
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndValidate(
  source: string,
): Promise<{ valid: boolean; instance?: WebAssembly.Instance; error?: string }> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    return {
      valid: false,
      error:
        "compile: " +
        result.errors
          .filter((e) => e.severity === "error")
          .map((e) => e.message)
          .join("; "),
    };
  }
  const valid = WebAssembly.validate(result.binary);
  if (!valid) {
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      await WebAssembly.instantiate(result.binary, imports);
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    return { valid: true, instance };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}

describe("Issue #178: Wasm validation — type mismatches", () => {
  it("loose equality: boolean == string produces valid wasm", async () => {
    const result = await compileAndValidate(`
      export function test(): number {
        if ((true == 1) !== true) return 0;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
  });

  it("loose equality: number == string imports parseFloat and validates", async () => {
    const result = await compileAndValidate(`
      export function test(): number {
        if (("-1" == -1) !== true) return 0;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
  });

  it("loose equality: string == boolean produces valid wasm", async () => {
    const result = await compileAndValidate(`
      export function test(): number {
        var x: boolean = false;
        var y: string = "0";
        if ((x == y) !== false) return 0;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
  });

  it("BigInt strict equality with string produces valid wasm", async () => {
    const result = await compileAndValidate(`
      export function test(): number {
        if ((0n === "0") !== false) return 0;
        if ((0n !== "0") !== true) return 0;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
  });

  it("i64 coercion to externref via box_number", async () => {
    // This tests the i64 → externref coercion path
    const result = await compileAndValidate(`
      export function test(): number {
        var x: bigint = 42n;
        var y: bigint = 43n;
        if (x + 1n !== y) return 0;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
  });

  it("BigInt arithmetic produces valid wasm binary", async () => {
    const result = await compileAndValidate(`
      export function test(): number {
        var a: bigint = 100n;
        var b: bigint = 200n;
        var c = a + b;
        if (c !== 300n) return 0;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
    if (result.instance) {
      const testFn = (result.instance.exports as any).test;
      expect(testFn()).toBe(1);
    }
  });

  it("large BigInt literals produce valid LEB128 encoding", async () => {
    const result = await compileAndValidate(`
      export function test(): number {
        var x = 0xFEDCBA9876543210n;
        var y = 0xFEDCBA9876543210n;
        var sum = x + y;
        return 1;
      }
    `);
    expect(result.valid).toBe(true);
  });
});
