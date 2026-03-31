import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const jsStringPolyfill = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
};

function buildImports(result: CompileResult): WebAssembly.Imports {
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
    __typeof: (v: unknown) => typeof v,
    __is_truthy: (v: unknown) => (v ? 1 : 0),
    __box_number: (v: number) => v,
    __box_boolean: (v: number) => Boolean(v),
    __unbox_number: (v: unknown) => Number(v),
    __unbox_boolean: (v: unknown) => (v ? 1 : 0),
    string_compare: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    __make_callback: () => null,
  };
  return {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  };
}

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  // Check for codegen errors (e.g. missing string registration)
  if (result.errors.length > 0) {
    throw new Error(`Codegen errors:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("Issue #282: Variable declaration complex initializers", () => {
  describe("string literals in module-level variable initializers", () => {
    it("module-level var with string literal is properly registered", async () => {
      const result = compile(`
        var x = "hello";
        export function test(): number {
          return x === "hello" ? 1 : 0;
        }
      `);
      expect(result.success).toBe(true);
      // Ensure no "String literal not registered" errors
      const strErrors = result.errors.filter((e) => e.message.includes("String literal not registered"));
      expect(strErrors).toHaveLength(0);
    });

    it("module-level var with string used only in init", async () => {
      const result = compile(`
        var x = "unique_init_only";
        export function test(): number { return 42; }
      `);
      expect(result.success).toBe(true);
      const strErrors = result.errors.filter((e) => e.message.includes("String literal not registered"));
      expect(strErrors).toHaveLength(0);
    });

    it("module-level var with template literal", async () => {
      const result = compile(`
        var greeting = "world";
        export function test(): number { return 1; }
      `);
      expect(result.success).toBe(true);
      expect(result.errors.filter((e) => e.message.includes("String literal not registered"))).toHaveLength(0);
    });
  });

  describe("ternary expression initializers", () => {
    it("const with ternary number initializer", async () => {
      expect(
        await run(
          `
        export function test(x: number): number {
          const a = x > 0 ? 10 : 20;
          return a;
        }
      `,
          "test",
          [5],
        ),
      ).toBe(10);
    });

    it("const with nested ternary", async () => {
      expect(
        await run(
          `
        export function test(x: number): number {
          const a = x > 10 ? 100 : x > 0 ? 50 : 0;
          return a;
        }
      `,
          "test",
          [5],
        ),
      ).toBe(50);
    });
  });

  describe("binary expression initializers", () => {
    it("const with arithmetic expression", async () => {
      expect(
        await run(
          `
        export function test(): number {
          const a = 1 + 2 * 3;
          return a;
        }
      `,
          "test",
        ),
      ).toBe(7);
    });

    it("const with logical expression", async () => {
      expect(
        await run(
          `
        export function test(x: number): number {
          const a = x || 42;
          return a;
        }
      `,
          "test",
          [0],
        ),
      ).toBe(42);
    });
  });

  describe("function expression initializers", () => {
    it("arrow function in variable", async () => {
      expect(
        await run(
          `
        export function test(): number {
          const f = (x: number): number => x * 2;
          return f(21);
        }
      `,
          "test",
        ),
      ).toBe(42);
    });

    it("function expression in variable", async () => {
      expect(
        await run(
          `
        export function test(): number {
          const f = function(x: number): number { return x + 1; };
          return f(41);
        }
      `,
          "test",
        ),
      ).toBe(42);
    });

    it("top-level arrow function", async () => {
      const result = compile(`
        const fn = (x: number): number => x * 2;
        export function test(): number { return fn(21); }
      `);
      expect(result.success).toBe(true);
    });

    it("top-level function expression", async () => {
      const result = compile(`
        const fn = function(x: number): number { return x * 2; };
        export function test(): number { return fn(21); }
      `);
      expect(result.success).toBe(true);
    });
  });

  describe("class expression initializers", () => {
    it("class expression at module level", async () => {
      expect(
        await run(
          `
        const C = class {
          x: number;
          constructor(x: number) { this.x = x; }
        };
        export function test(): number {
          return new C(42).x;
        }
      `,
          "test",
        ),
      ).toBe(42);
    });

    it("class expression inside function", async () => {
      expect(
        await run(
          `
        export function test(): number {
          const C = class {
            x: number;
            constructor(x: number) { this.x = x; }
          };
          return new C(42).x;
        }
      `,
          "test",
        ),
      ).toBe(42);
    });

    // Note: class expressions in block scopes (if/else) have a separate
    // property access issue tracked elsewhere, so not tested here.
  });

  describe("multiple variable declarations", () => {
    it("multiple var decls with same type", async () => {
      expect(
        await run(
          `
        export function test(): number {
          var a = 1, b = 2, c = 3;
          return a + b + c;
        }
      `,
          "test",
        ),
      ).toBe(6);
    });

    it("multiple let decls", async () => {
      expect(
        await run(
          `
        export function test(): number {
          let a = 10, b = 20;
          return a + b;
        }
      `,
          "test",
        ),
      ).toBe(30);
    });
  });

  describe("for-loop variable initializers", () => {
    it("simple for-loop var init", async () => {
      expect(
        await run(
          `
        export function test(): number {
          let sum = 0;
          for (var i = 0; i < 5; i++) { sum += i; }
          return sum;
        }
      `,
          "test",
        ),
      ).toBe(10);
    });

    it("complex for-loop init with ternary", async () => {
      expect(
        await run(
          `
        export function test(x: number): number {
          let sum = 0;
          for (var i = x > 0 ? 0 : 5; i < 10; i++) { sum += i; }
          return sum;
        }
      `,
          "test",
          [1],
        ),
      ).toBe(45);
    });
  });

  describe("call expression initializers", () => {
    it("variable initialized with function call", async () => {
      expect(
        await run(
          `
        function makeNumber(): number { return 42; }
        export function test(): number {
          const x = makeNumber();
          return x;
        }
      `,
          "test",
        ),
      ).toBe(42);
    });
  });

  describe("new expression initializers", () => {
    it("variable initialized with new", async () => {
      expect(
        await run(
          `
        class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) { this.x = x; this.y = y; }
        }
        export function test(): number {
          const p = new Point(10, 20);
          return p.x + p.y;
        }
      `,
          "test",
        ),
      ).toBe(30);
    });
  });

  describe("object literal initializers", () => {
    it("const with object literal", async () => {
      expect(
        await run(
          `
        export function test(): number {
          const obj = { a: 1, b: 2 };
          return obj.a + obj.b;
        }
      `,
          "test",
        ),
      ).toBe(3);
    });
  });
});
