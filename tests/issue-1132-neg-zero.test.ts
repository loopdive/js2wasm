import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): number {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

describe("Negative zero preservation (#1132)", () => {
  it("-0 literal produces IEEE 754 negative zero", () => {
    const result = compileAndRun(`
      export function test(): number {
        return 1 / -0 === -Infinity ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("-0 assigned to const preserves sign", () => {
    const result = compileAndRun(`
      export function test(): number {
        const x = -0;
        return 1 / x === -Infinity ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("runtime negation of zero variable produces -0", () => {
    const result = compileAndRun(`
      export function test(): number {
        var x: number = 0;
        x = -x;
        return 1 / x === -Infinity ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("-(-0) produces +0", () => {
    const result = compileAndRun(`
      export function test(): number {
        var x: number = -0;
        x = -x;
        return 1 / x === Infinity ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("WAT output shows -0.0 for negative zero constant", () => {
    const result = compile(`export function test(): number { return -0; }`, {
      fileName: "test.ts",
      emitWat: true,
    });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("f64.const -0.0");
  });
});
