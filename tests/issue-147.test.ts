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
  const { instance } = await WebAssembly.instantiate(result.binary, buildImports(result));
  return (instance.exports as any)[fn](...args);
}

describe("Function.name property (#147)", () => {
  it("named function declaration", async () => {
    expect(
      await run(
        `
      function hello() { return 42; }
      export function test(): string {
        return hello.name;
      }
    `,
        "test",
      ),
    ).toBe("hello");
  });

  it("class constructor name", async () => {
    expect(
      await run(
        `
      class MyClass {
        x: number;
        constructor() { this.x = 1; }
      }
      export function test(): string {
        return MyClass.name;
      }
    `,
        "test",
      ),
    ).toBe("MyClass");
  });

  it("class expression with explicit name", async () => {
    expect(
      await run(
        `
      const Foo = class NamedClass {
        x: number;
        constructor() { this.x = 1; }
      };
      export function test(): string {
        return Foo.name;
      }
    `,
        "test",
      ),
    ).toBe("NamedClass");
  });

  it("anonymous class expression gets variable name", async () => {
    expect(
      await run(
        `
      const Bar = class {
        x: number;
        constructor() { this.x = 1; }
      };
      export function test(): string {
        return Bar.name;
      }
    `,
        "test",
      ),
    ).toBe("Bar");
  });

  it("function .name returns string type", async () => {
    expect(
      await run(
        `
      function add(a: number, b: number) { return a + b; }
      export function test(): string {
        return add.name;
      }
    `,
        "test",
      ),
    ).toBe("add");
  });

  it("class with methods - name still works", async () => {
    expect(
      await run(
        `
      class Calculator {
        x: number;
        constructor() { this.x = 0; }
        add(n: number): number { return this.x + n; }
      }
      export function test(): string {
        return Calculator.name;
      }
    `,
        "test",
      ),
    ).toBe("Calculator");
  });
});
