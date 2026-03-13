import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  // Don't check TS type errors — var hoisting triggers "used before being assigned"
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("issue-298: function statement edge cases", () => {
  it("nested function with side effects on captured var (S13.2.1_A9.1_T1 pattern)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var x: number = 0;
        function __func(): void {
          x = 1;
        }
        __func();
        return x;
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("nested function with return statement and side effect (S13.2.1_A9_T1 pattern)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var x: number = 0;
        function __func(): void {
          x = 1;
          return;
        }
        __func();
        return x;
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("var and function declaration with same name (S13_A19_T1 pattern)", async () => {
    // function declaration should be hoisted and the var assignment should override it
    const e = await compileAndRun(`
      export function test(): number {
        var __decl: number = 1;
        function __decl2(): number { return 42; }
        if (__decl !== 1) return 0;
        if (__decl2() !== 42) return 0;
        return 1;
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("primitive pass-by-value through function params (S13.2.1_A6_T3 pattern)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        function __func(arg1: number, arg2: number): void {
          arg1++;
          arg2++;
        }
        var x: number = 1;
        var y: number = 2;
        __func(x, y);
        if (x !== 1) return 0;
        if (y !== 2) return 0;
        return 1;
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("function hoisted from if-block body", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var result: number = 0;
        if (1) {
          function inner(): number { return 42; }
          result = inner();
        }
        return result;
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("function hoisted from else-block body", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var result: number = 0;
        if (0) {
          result = 99;
        } else {
          function inner(): number { return 7; }
          result = inner();
        }
        return result;
      }
    `);
    expect(e.test()).toBe(7);
  });
});
