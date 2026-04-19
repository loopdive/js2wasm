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

describe("#1134 — __any_eq cross-tag loose equality (§7.2.15)", () => {
  test("null == undefined returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = null;
      let b: any = undefined;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("undefined == null returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = undefined;
      let b: any = null;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("null !== undefined for strict equality", () => {
    const result = compileAndRun(`
      let a: any = null;
      let b: any = undefined;
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("true == 1 returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = true;
      let b: any = 1;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("false == 0 returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = false;
      let b: any = 0;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("null != 0 returns true for any-typed (null is not numeric)", () => {
    const result = compileAndRun(`
      let a: any = null;
      let b: any = 0;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    // Per spec: null == 0 is false (null only == null/undefined)
    expect(result).toBe(0);
  });
});
