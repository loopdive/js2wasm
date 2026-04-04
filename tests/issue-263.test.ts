import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Helper: compile TS source, instantiate, and call the exported function.
 */
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  // Check for codegen errors (severity "error") that would block test262
  const codegenErrors = result.errors.filter((e) => e.severity === "error");
  if (codegenErrors.length > 0) {
    throw new Error(`Codegen errors:\n${codegenErrors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

/**
 * Helper: compile and assert no codegen errors (severity "error").
 */
function compileNoErrors(source: string, options?: { fileName?: string }): void {
  const result = compile(source, options);
  const codegenErrors = result.errors.filter((e) => e.severity === "error");
  expect(codegenErrors).toEqual([]);
}

describe("issue-263: dynamic property access", () => {
  describe("Function.name property", () => {
    it("compiles function.name without codegen errors", () => {
      compileNoErrors(`
        function foo() {}
        export function test(): string { return foo.name; }
      `);
    });

    it("function.name returns the function name", async () => {
      const result = await run(
        `
        function myFunc() {}
        export function test(): string { return myFunc.name; }
      `,
        "test",
      );
      expect(result).toBe("myFunc");
    });

    it("compiles arrow function .name without errors", () => {
      compileNoErrors(`
        const fn = () => {};
        export function test(): string { return fn.name; }
      `);
    });

    it("compiles generator function .name without errors", () => {
      compileNoErrors(`
        function* gen() { yield 1; }
        export function test(): string { return gen.name; }
      `);
    });
  });

  describe("Constructor.name property (typeof cls)", () => {
    it("compiles class.name without codegen errors", () => {
      compileNoErrors(`
        class Foo {}
        export function test(): string { return Foo.name; }
      `);
    });

    it("class.name returns the class name", async () => {
      const result = await run(
        `
        class MyClass {}
        export function test(): string { return MyClass.name; }
      `,
        "test",
      );
      expect(result).toBe("MyClass");
    });
  });

  describe("Constructor.length property", () => {
    it("compiles class.length (constructor arity)", async () => {
      const result = await run(
        `
        class Bar {
          x: number;
          y: number;
          constructor(a: number, b: number) { this.x = a; this.y = b; }
        }
        export function test(): number { return Bar.length; }
      `,
        "test",
      );
      expect(result).toBe(2);
    });
  });

  describe("Property on Object type", () => {
    it("compiles Object.prop access without codegen errors", () => {
      compileNoErrors(`
        export function test(): number {
          var obj = new Object();
          obj.prop = 1;
          return obj.prop;
        }
      `);
    });
  });

  describe("Property on empty object type {}", () => {
    it("compiles {}.prop access without codegen errors", () => {
      compileNoErrors(`
        export function test(): number {
          var o = {};
          o.x = 42;
          return o.x;
        }
      `);
    });
  });

  describe("Dynamic fallback for unresolvable properties", () => {
    it("does not produce codegen errors for unknown properties", () => {
      compileNoErrors(`
        function foo() {}
        foo.customProp = 42;
        export function test(): number { return foo.customProp; }
      `);
    });

    it("does not produce codegen errors for .name on various function types", () => {
      compileNoErrors(`
        const f1 = function() {};
        const f2 = () => {};
        function f3() {}
        export function test(): string {
          return f1.name + f2.name + f3.name;
        }
      `);
    });
  });
});
