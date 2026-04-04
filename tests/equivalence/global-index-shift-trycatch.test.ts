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
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);

    // Instantiate and run - should not throw CompileError
    const { buildImports: rtBuildImports } = await import("../../src/runtime.js");
    const imports = rtBuildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    expect(testFn()).toBe(1);
  });

  it("multiple module globals with class and string constants do not produce immutable global error (#764)", async () => {
    // Regression test for #764: test262-style code with multiple module-scope
    // globals (like __fail, __assert_count, callCount) and class definitions
    // that trigger string constant additions during compilation.
    // Previously, 240+ tests failed with "immutable global cannot be assigned"
    // when addStringConstantGlobal shifted indices during function body compilation.
    const result = compile(`
      let __fail: number = 0;
      let __assert_count: number = 1;
      var callCount: number = 0;

      function assert_sameValue(actual: number, expected: number): void {
        __assert_count = __assert_count + 1;
        if (actual !== expected) {
          if (!__fail) __fail = __assert_count;
        }
      }

      export function test(): number {
        try {
          // String concatenation with boolean triggers addStringConstantGlobal
          const msg1 = "check:" + (1 > 0);
          callCount = callCount + 1;
          assert_sameValue(callCount, 1);
          // More string constants to increase import count
          const msg2 = "result:" + (2 > 1);
          callCount = callCount + 1;
          assert_sameValue(callCount, 2);
        } catch (e) {
          // This global.set must target the correct module global,
          // not an immutable string constant import
          if (!__fail) __fail = -1;
          throw e;
        }
        if (__fail) { return __fail; }
        return 1;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);

    const { buildImports: rtBuildImports } = await import("../../src/runtime.js");
    const imports = rtBuildImports(result.imports, undefined, result.stringPool);
    // This instantiate call would throw CompileError if global indices are wrong
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const testFn = (instance.exports as any).test;
    expect(testFn()).toBe(1);
  });
});
