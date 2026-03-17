import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";
import { compile } from "../../src/index.js";

describe("Global index shifting with string constants in try/catch (#429)", () => {
  it("boolean-to-string inside try body does not corrupt catch global indices", async () => {
    // This test exercises the bug where addStringConstantGlobal (for "true"/"false")
    // shifts module global indices but fails to update the moduleGlobals map.
    // Without the fix, the catch block's global.set for __fail would target an
    // immutable string constant global instead of the mutable __fail global.
    const exports = await compileToWasm(`
      let result: number = 0;

      export function test(): number {
        try {
          // Force boolean-to-string conversion (triggers addStringConstantGlobal
          // for "true" and "false") inside a try block
          const msg = "val:" + (1 > 0);
          throw new Error("expected");
        } catch (e) {
          // This assignment to module-level global must use the correct
          // global index AFTER the string constants shifted it
          result = 42;
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("multiple string constants added during nested try/catch", async () => {
    const exports = await compileToWasm(`
      let counter: number = 0;

      export function test(): number {
        try {
          try {
            const s1 = "prefix:" + (true);
            throw new Error("inner");
          } catch (e) {
            counter = 10;
          }
        } catch (e) {
          counter = -1;
        }
        return counter;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("global assignment after string concat in try does not produce immutable global error", async () => {
    // Regression: this pattern caused "immutable global cannot be assigned"
    // because the outer catch's global.set index was not updated when
    // string constant imports were added during inner try compilation
    const result = compile(`
      let flag: number = 0;

      export function test(): number {
        try {
          const x = "result: " + (2 > 1);
          throw new Error("test");
        } catch (e) {
          flag = 1;
        }
        return flag;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.errors.filter(e => e.severity === "error")).toHaveLength(0);

    // Instantiate and run - should not throw CompileError
    const { buildImports: rtBuildImports } = await import("../../src/runtime.js");
    const imports = rtBuildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    expect(testFn()).toBe(1);
  });
});
