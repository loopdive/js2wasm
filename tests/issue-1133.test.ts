import { test, expect, describe } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(src: string): any {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`Compile error: ${r.errors?.[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(r.binary), imports);
  return (instance.exports as any).test();
}

describe("#1133 — any-typed string equality uses content comparison, not identity", () => {
  test("'hello' === 'hello' returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("'hello' === 'world' returns false for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = 'hello';
      let b: any = 'world';
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("'hello' == 'hello' returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("'hello' == 'world' returns false for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = 'hello';
      let b: any = 'world';
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("'hello' !== 'hello' returns false for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a !== b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("'hello' != 'hello' returns false for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = 'hello';
      let b: any = 'hello';
      export function test(): number {
        return (a != b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });
});
