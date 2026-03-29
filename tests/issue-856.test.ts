/**
 * Issue #856 — Expected TypeError but got wrong error type
 * Tests that Object.defineProperty/defineProperties throw TypeError for
 * non-configurable property redefinition violations (ES spec 9.1.6.3).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(source: string): Promise<number> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors.map(e => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if ((imports as any).setExports) (imports as any).setExports(instance.exports);
  return (instance.exports as any).test();
}

describe("Issue #856: TypeError for non-configurable property redefinition", () => {
  it("struct obj: configurable false→true throws", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { prop: 0 };
        Object.defineProperty(obj, "prop", { value: 11, configurable: false });
        try {
          Object.defineProperties(obj, { prop: { value: 12, configurable: true } });
          return 0;
        } catch (e) { return 1; }
      }
    `);
    expect(result).toBe(1);
  });

  it("array numeric index: configurable false→true throws", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr: string[] = [];
        Object.defineProperty(arr, 0, { value: "test", configurable: false });
        try {
          Object.defineProperty(arr, 0, { configurable: true });
          return 0;
        } catch (e) { return 1; }
      }
    `);
    expect(result).toBe(1);
  });

  it("function obj: defineProperties configurable false→true throws", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const fun = function() {};
        Object.defineProperty(fun, "prop", { value: 11, configurable: false });
        try {
          Object.defineProperties(fun, { prop: { value: 12, configurable: true } });
          return 0;
        } catch (e) { return 1; }
      }
    `);
    expect(result).toBe(1);
  });

  it("SameValue: -0/+0 value change throws", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const arr: number[] = [];
        Object.defineProperty(arr, "0", { value: -0 });
        try {
          Object.defineProperty(arr, "0", { value: +0 });
          return 0;
        } catch (e) { return 1; }
      }
    `);
    expect(result).toBe(1);
  });

  it("writable false→true on non-configurable throws", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { x: 0 };
        Object.defineProperty(obj, "x", { writable: false, configurable: false, value: 1 });
        try {
          Object.defineProperty(obj, "x", { writable: true });
          return 0;
        } catch (e) { return 1; }
      }
    `);
    expect(result).toBe(1);
  });

  it("same value on non-writable non-configurable is OK", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { x: 0 };
        Object.defineProperty(obj, "x", { writable: false, configurable: false, value: 42 });
        Object.defineProperty(obj, "x", { value: 42 });
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("configurable property allows redefinition", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const obj = { x: 0 };
        Object.defineProperty(obj, "x", { writable: false, configurable: true, value: 42 });
        Object.defineProperty(obj, "x", { value: 99 });
        return 1;
      }
    `);
    expect(result).toBe(1);
  });
});
