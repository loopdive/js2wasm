import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  // Don't check TS type errors — var hoisting triggers "used before being assigned"
  // which is a TS diagnostic, not a real codegen failure
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("var hoisting", () => {
  it("var in for-loop initializer accessible after loop", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        for (var i: number = 0; i < 3; i++) {}
        return i;
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("var declared inside for-loop body accessible after loop", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        for (var i: number = 0; i < 3; i++) {
          var x: number = i * 10;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(20);
  });

  it("var reused across multiple for-loops (test262 pattern)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        for (var i: number = 0; i < 3; i++) {
          var x: number = i;
        }
        for (i = 10; i < 13; i++) {
          x = i;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(12);
  });

  it("var inside if-block accessible outside", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var cond: number = 1;
        if (cond) {
          var x: number = 42;
        }
        return x;
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("var redeclaration does not create new local", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var x: number = 1;
        var x: number = 2;
        return x;
      }
    `);
    expect(e.test()).toBe(2);
  });
});
