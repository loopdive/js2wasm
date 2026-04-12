import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndValidate(source: string): { valid: boolean; error?: string } {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    return { valid: false, error: `Compile error: ${result.errors?.map((e) => e.message).join("; ")}` };
  }
  try {
    const valid = WebAssembly.validate(result.binary);
    if (!valid) {
      return { valid: false, error: "WebAssembly.validate failed" };
    }
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const mod = new WebAssembly.Module(result.binary);
    new WebAssembly.Instance(mod, imports);
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}

describe("#1072 — wasm:js-string import name shadowing", () => {
  it("user function named 'charCodeAt' should not shadow import", () => {
    const { valid, error } = compileAndValidate(`
      function charCodeAt(s: string, i: number): number {
        return s.charCodeAt(i);
      }
      function trimEnd(s: string): string {
        const code = charCodeAt(s, s.length - 1);
        if (code === 10 || code === 13) {
          return s.slice(0, -1);
        }
        return s;
      }
      export function test(): number {
        return trimEnd("hello\\n").length;
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("user function named 'length' should not shadow import", () => {
    const { valid, error } = compileAndValidate(`
      function length(s: string): number {
        return s.length;
      }
      export function test(): number {
        return length("hello");
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("user function named 'concat' should not shadow import", () => {
    const { valid, error } = compileAndValidate(`
      function concat(a: string, b: string): string {
        return a + b;
      }
      export function test(): number {
        return concat("hello", " world").length;
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("prettier trimNewlinesEnd pattern (charCodeAt + if/|| + slice)", () => {
    const { valid, error } = compileAndValidate(`
      function charCodeAt(s: string, i: number): number {
        return s.charCodeAt(i);
      }
      function trimNewlinesEnd(str: string): string {
        const charCode = charCodeAt(str, str.length - 1);
        if (charCode === 10 || charCode === 13) {
          return str.slice(0, -1);
        }
        return str;
      }
      export function test(): number {
        return trimNewlinesEnd("hello\\n").length;
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("f64-returning function assigned to externref variable", () => {
    const { valid, error } = compileAndValidate(`
      function numFunc(): number {
        return 42;
      }
      function useAsAny(): any {
        return numFunc();
      }
      export function test(): number {
        return 1;
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });
});
