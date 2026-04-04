import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as any)[fn]();
}

describe("call type mismatch fix (#532)", { timeout: 30000 }, () => {
  it("string + string is not folded to numeric addition", async () => {
    const val = await run(`
      export function test(): number {
        if ("1" + "1" !== "11") return 0;
        return 1;
      }
    `);
    expect(val).toBe(1);
  });

  it("string literal + numeric-looking string literal is string concat", async () => {
    const val = await run(`
      export function test(): number {
        let x: string = "1" + "2";
        if (x !== "12") return 0;
        return 1;
      }
    `);
    expect(val).toBe(1);
  });

  it("wasm validates when f64 result is compared with string via !==", async () => {
    // This previously caused: call[0] expected type externref, found f64.const of type f64
    const source = `
      // @ts-nocheck
      export function test(): number {
        try {
          if ("1" + "1" !== "11") {
            throw new Test262Error('#1: "1" + "1" === "11"');
          }
        } catch (e) {}
        return 1;
      }
    `;
    const result = compile(source);
    // Should not throw during Module construction (Wasm validation)
    const mod = new WebAssembly.Module(result.binary);
    expect(mod).toBeTruthy();
  });

  it("numeric subtraction of string literals still works", async () => {
    // "2" - "1" should still fold to 1 (numeric subtraction)
    const val = await run(`
      export function test(): number {
        let x: number = ("2" as any) - ("1" as any);
        return x;
      }
    `);
    expect(val).toBe(1);
  });

  it("mixed f64/externref equality comparison does not cause validation error", async () => {
    // When left operand produces f64 but right is string, equals call should coerce
    const source = `
      export function test(): number {
        let a: any = 42;
        let b: string = "42";
        if (a !== b) return 1;
        return 0;
      }
    `;
    const result = compile(source);
    const mod = new WebAssembly.Module(result.binary);
    expect(mod).toBeTruthy();
  });
});
