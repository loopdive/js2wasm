import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, jsApi } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.stringPool, jsApi);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("computed property names", () => {
  it("string literal computed key", async () => {
    expect(
      await run(
        `
      function make(): { x: number } {
        return { ["x"]: 42 };
      }
      export function test(): number {
        return make().x;
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("const variable computed key", async () => {
    expect(
      await run(
        `
      const key = "name";
      function make(): { name: number } {
        return { [key]: 99 };
      }
      export function test(): number {
        return make().name;
      }
    `,
        "test",
      ),
    ).toBe(99);
  });

  it("accessing computed properties normally after creation", async () => {
    expect(
      await run(
        `
      function make(): { a: number; b: number } {
        return { ["a"]: 10, ["b"]: 20 };
      }
      export function test(): number {
        const obj = make();
        return obj.a + obj.b;
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("multiple computed properties in one object", async () => {
    expect(
      await run(
        `
      const k1 = "x";
      const k2 = "y";
      function make(): { x: number; y: number } {
        return { [k1]: 3, [k2]: 7 };
      }
      export function test(): number {
        const pt = make();
        return pt.x * pt.y;
      }
    `,
        "test",
      ),
    ).toBe(21);
  });

  it("mixed regular and computed properties", async () => {
    expect(
      await run(
        `
      function make(): { a: number; b: number; c: number } {
        return { a: 1, ["b"]: 2, c: 3 };
      }
      export function test(): number {
        const obj = make();
        return obj.a + obj.b + obj.c;
      }
    `,
        "test",
      ),
    ).toBe(6);
  });

  it("string enum member as computed key", async () => {
    expect(
      await run(
        `
      enum Keys {
        Name = "name",
        Age = "age",
      }
      function make(): { name: number; age: number } {
        return { [Keys.Name]: 10, [Keys.Age]: 25 };
      }
      export function test(): number {
        const obj = make();
        return obj.name + obj.age;
      }
    `,
        "test",
      ),
    ).toBe(35);
  });
});
