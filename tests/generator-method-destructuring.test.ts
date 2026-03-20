import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<{
  exports: Record<string, Function>;
  instance: WebAssembly.Instance;
}> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as unknown as WebAssembly.Imports,
  );
  return { exports: instance.exports as any, instance };
}

describe("generator method destructuring (#629)", () => {
  it("untyped array destructuring: values accessible via addition", async () => {
    const { exports } = await compileAndRun(`
      let result: number = 0;
      export function test(): number {
        var C = class {
          method([x, y, z]) {
            result = x + y + z;
          }
        };
        new C().method([1, 2, 3]);
        return result;
      }
    `);
    expect((exports.test as Function)()).toBe(6);
  }, 30000);

  it("test262 pattern: generator method with untyped array destructuring", async () => {
    // Reproduces the exact test262 gen-meth-ary-ptrn-elem-id-iter-val.js pattern
    const { exports } = await compileAndRun(`
      let __fail: number = 0;
      function isSameValue(a: number, b: number): number {
        if (a === b) { return 1; }
        if (a !== a && b !== b) { return 1; }
        return 0;
      }
      function assert_sameValue(actual: number, expected: number): void {
        if (!isSameValue(actual, expected)) { __fail = 1; }
      }
      let callCount: number = 0;
      export function test(): number {
        try {
          var C = class {
            *method([x, y, z]) {
              assert_sameValue(x, 1);
              assert_sameValue(y, 2);
              assert_sameValue(z, 3);
              callCount = callCount + 1;
            }
          };
          new C().method([1, 2, 3]).next();
          assert_sameValue(callCount, 1);
        } catch (e) {
          __fail = 1;
        }
        if (__fail) { return 0; }
        return 1;
      }
    `);
    expect((exports.test as Function)()).toBe(1);
  }, 30000);

  it("non-generator method with untyped array destructuring and assert", async () => {
    const { exports } = await compileAndRun(`
      let __fail: number = 0;
      function assert_sameValue(actual: number, expected: number): void {
        if (actual !== expected) { __fail = 1; }
      }
      let callCount: number = 0;
      export function test(): number {
        var C = class {
          method([x, y, z]) {
            assert_sameValue(x, 1);
            assert_sameValue(y, 2);
            assert_sameValue(z, 3);
            callCount = callCount + 1;
          }
        };
        new C().method([1, 2, 3]);
        assert_sameValue(callCount, 1);
        if (__fail) { return 0; }
        return 1;
      }
    `);
    expect((exports.test as Function)()).toBe(1);
  }, 30000);

  it("standalone generator with untyped array destructuring", async () => {
    const { exports } = await compileAndRun(`
      let result: number = 0;
      export function test(): number {
        function* gen([a, b]) {
          result = a + b;
          yield result;
        }
        gen([10, 20]).next();
        return result;
      }
    `);
    expect((exports.test as Function)()).toBe(30);
  }, 30000);

  it("typed array destructuring still works (baseline)", async () => {
    const { exports } = await compileAndRun(`
      let result: number = 0;
      export function test(): number {
        var C = class {
          method([x, y, z]: number[]) {
            result = x + y + z;
          }
        };
        new C().method([1, 2, 3]);
        return result;
      }
    `);
    expect((exports.test as Function)()).toBe(6);
  }, 30000);
});
