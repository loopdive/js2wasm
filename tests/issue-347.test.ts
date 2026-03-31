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

describe("Function/class .name property completion (#347)", () => {
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

  it("class declaration name", async () => {
    expect(
      await run(
        `
      class Foo {
        x: number;
        constructor() { this.x = 1; }
      }
      export function test(): string {
        return Foo.name;
      }
    `,
        "test",
      ),
    ).toBe("Foo");
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

  it("named class expression keeps its own name", async () => {
    expect(
      await run(
        `
      const Baz = class MyClass {
        x: number;
        constructor() { this.x = 1; }
      };
      export function test(): string {
        return Baz.name;
      }
    `,
        "test",
      ),
    ).toBe("MyClass");
  });

  it("function expression name inferred from parameter context", async () => {
    // Test that the .name resolution works for named function expressions
    expect(
      await run(
        `
      function myFunc(a: number) { return a + 1; }
      export function test(): string {
        return myFunc.name;
      }
    `,
        "test",
      ),
    ).toBe("myFunc");
  });

  it("function .name returns string type usable in comparison", async () => {
    expect(
      await run(
        `
      function add(a: number, b: number) { return a + b; }
      export function test(): boolean {
        return add.name === "add";
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("class .name returns string type usable in comparison", async () => {
    expect(
      await run(
        `
      class Calculator {
        x: number;
        constructor() { this.x = 0; }
      }
      export function test(): boolean {
        return Calculator.name === "Calculator";
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("arrow function .name via local variable access", async () => {
    // Arrow functions stored in local variables (not module-level const)
    expect(
      await run(
        `
      export function test(): string {
        const f = (x: number) => x + 1;
        return f.name;
      }
    `,
        "test",
      ),
    ).toBe("f");
  });

  it("anonymous function expression .name via local", async () => {
    expect(
      await run(
        `
      export function test(): string {
        const g = function(x: number) { return x + 1; };
        return g.name;
      }
    `,
        "test",
      ),
    ).toBe("g");
  });

  it("named function expression .name via local keeps own name", async () => {
    expect(
      await run(
        `
      export function test(): string {
        const h = function myFunc(x: number) { return x + 1; };
        return h.name;
      }
    `,
        "test",
      ),
    ).toBe("myFunc");
  });
});
