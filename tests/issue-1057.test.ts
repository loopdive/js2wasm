import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): any {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

describe("#1057 — String.prototype.split constructor === Array", () => {
  it("split result .constructor should be Array", () => {
    const result = compileAndRun(`
      export function test(): boolean {
        const parts = "a,b,c".split(",");
        return parts.constructor === Array;
      }
    `);
    expect(result).toBe(1);
  });

  it("split with no match returns array with constructor === Array", () => {
    const result = compileAndRun(`
      export function test(): boolean {
        const parts = "hello".split("xyz");
        return parts.constructor === Array;
      }
    `);
    expect(result).toBe(1);
  });
});
