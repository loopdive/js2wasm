import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    buildImports(result),
  );
  return (instance.exports as any)[fn](...args);
}

describe("Issue #165: function statement hoisting and edge cases", () => {
  // -- Function declaration hoisting --

  it("function declared after call site is hoisted", async () => {
    const result = await run(
      `
      export function test(): number {
        return foo();
      }
      function foo(): number {
        return 42;
      }
      `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("multiple hoisted functions calling each other", async () => {
    const result = await run(
      `
      export function test(): number {
        return a() + b();
      }
      function a(): number { return 10; }
      function b(): number { return 20; }
      `,
      "test",
    );
    expect(result).toBe(30);
  });

  it("function hoisted from inside if-block", async () => {
    const result = await run(
      `
      export function test(x: number): number {
        if (x > 0) {
          function inner(): number { return 100; }
        }
        return inner();
      }
      function inner(): number { return 100; }
      `,
      "test",
      [1],
    );
    expect(result).toBe(100);
  });

  it("function hoisted from inside block statement", async () => {
    const result = await run(
      `
      export function test(): number {
        const r = foo();
        return r;
      }
      function foo(): number {
        {
          function bar(): number { return 7; }
        }
        return bar();
      }
      function bar(): number { return 7; }
      `,
      "test",
    );
    expect(result).toBe(7);
  });

  // -- IIFE patterns --

  it("basic IIFE with no params", async () => {
    const result = await run(
      `
      export function test(): number {
        return (function(): number { return 99; })();
      }
      `,
      "test",
    );
    expect(result).toBe(99);
  });

  it("IIFE with parameters", async () => {
    const result = await run(
      `
      export function test(): number {
        return (function(a: number, b: number): number { return a + b; })(3, 4);
      }
      `,
      "test",
    );
    expect(result).toBe(7);
  });

  it("arrow IIFE (concise body)", async () => {
    const result = await run(
      `
      export function test(): number {
        return ((x: number): number => x * 2)(21);
      }
      `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("arrow IIFE (block body)", async () => {
    const result = await run(
      `
      export function test(): number {
        return ((x: number): number => { return x * 3; })(10);
      }
      `,
      "test",
    );
    expect(result).toBe(30);
  });

  it("IIFE capturing outer variable (read-only)", async () => {
    const result = await run(
      `
      export function test(): number {
        const x = 10;
        return (function(): number { return x + 5; })();
      }
      `,
      "test",
    );
    expect(result).toBe(15);
  });

  it("IIFE capturing outer variable (mutable capture via ref cell)", async () => {
    const result = await run(
      `
      export function test(): number {
        let x = 10;
        (function(): void { x = 20; })();
        return x;
      }
      `,
      "test",
    );
    expect(result).toBe(20);
  });

  it("nested IIFE (2 levels deep)", async () => {
    const result = await run(
      `
      export function test(): number {
        return (function(): number {
          return (function(): number {
            return 77;
          })();
        })();
      }
      `,
      "test",
    );
    expect(result).toBe(77);
  });

  // -- Default parameters in nested functions --

  it("nested function with default parameter", async () => {
    const result = await run(
      `
      export function test(): number {
        function add(a: number, b: number = 10): number {
          return a + b;
        }
        return add(5);
      }
      `,
      "test",
    );
    expect(result).toBe(15);
  });

  it("nested function with default parameter overridden", async () => {
    const result = await run(
      `
      export function test(): number {
        function add(a: number, b: number = 10): number {
          return a + b;
        }
        return add(5, 3);
      }
      `,
      "test",
    );
    expect(result).toBe(8);
  });

  // -- Function hoisting with captures --

  it("hoisted nested function capturing outer param", async () => {
    const result = await run(
      `
      export function test(x: number): number {
        return inner();
        function inner(): number { return x * 2; }
      }
      `,
      "test",
      [5],
    );
    expect(result).toBe(10);
  });

  it("hoisted nested function capturing outer local (called after init)", async () => {
    const result = await run(
      `
      export function test(): number {
        const y = 7;
        function inner(): number { return y + 3; }
        return inner();
      }
      `,
      "test",
    );
    expect(result).toBe(10);
  });

  // -- Edge cases --

  it("IIFE result used in expression", async () => {
    const result = await run(
      `
      export function test(): number {
        const x = (function(): number { return 5; })() + 10;
        return x;
      }
      `,
      "test",
    );
    expect(result).toBe(15);
  });

  it("IIFE with extra arguments (should be evaluated and dropped)", async () => {
    const result = await run(
      `
      export function test(): number {
        return (function(a: number): number { return a; })(42, 99);
      }
      `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("IIFE with fewer arguments than params (defaults to 0)", async () => {
    const result = await run(
      `
      export function test(): number {
        return (function(a: number, b: number): number { return a + b; })(5);
      }
      `,
      "test",
    );
    // b defaults to 0 when not provided
    expect(result).toBe(5);
  });

  it("function hoisting order: later declaration shadows earlier in same scope", async () => {
    const result = await run(
      `
      export function test(): number {
        return foo();
      }
      function foo(): number { return 42; }
      `,
      "test",
    );
    expect(result).toBe(42);
  });
});
