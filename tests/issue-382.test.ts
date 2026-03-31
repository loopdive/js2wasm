import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("issue-382: spread argument in super/function calls", () => {
  it("compiles spread in function call: fn(...args)", async () => {
    expect(
      await run(`
      function add(a: number, b: number): number {
        return a + b;
      }
      function wrapper(...args: number[]): number {
        return add(...args);
      }
      export function test(): number {
        return wrapper(3, 7);
      }
    `),
    ).toBe(10);
  });

  it("compiles spread in super() call", async () => {
    expect(
      await run(`
      class Parent {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
      }
      class Child extends Parent {
        constructor(...args: number[]) {
          super(...args);
        }
      }
      export function test(): number {
        const c = new Child(42);
        return c.x;
      }
    `),
    ).toBe(42);
  });

  it("compiles spread with multiple parent fields", async () => {
    expect(
      await run(`
      class Parent {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
      }
      class Child extends Parent {
        constructor(...args: number[]) {
          super(...args);
        }
      }
      export function test(): number {
        const c = new Child(10, 20);
        return c.a + c.b;
      }
    `),
    ).toBe(30);
  });

  it("spread rest params forwarded to another function", async () => {
    expect(
      await run(`
      function sum(a: number, b: number, c: number): number {
        return a + b + c;
      }
      function forward(...args: number[]): number {
        return sum(...args);
      }
      export function test(): number {
        return forward(1, 2, 3);
      }
    `),
    ).toBe(6);
  });

  it("TS2556 diagnostic is downgraded to warning", () => {
    // This should compile successfully (not fail with TS2556)
    const result = compile(`
      function foo(a: number, b: number): number {
        return a + b;
      }
      function bar(...args: number[]): number {
        return foo(...args);
      }
      export function test(): number {
        return bar(1, 2);
      }
    `);
    // Should not have any errors (warnings are OK)
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBe(0);
  });
});
