import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
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

describe("issue #239: element access on struct types (bracket notation)", () => {
  it("string literal bracket access on object literal", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj = { x: 10, y: 20 };
        return obj["x"] + obj["y"];
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("string literal bracket access on returned object", async () => {
    expect(
      await run(
        `
      function make(): { a: number; b: number } {
        return { a: 5, b: 15 };
      }
      export function test(): number {
        const obj = make();
        return obj["a"] + obj["b"];
      }
    `,
        "test",
      ),
    ).toBe(20);
  });

  it("bracket access with const variable key", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const key = "value";
        const obj = { value: 42 };
        return obj[key];
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("bracket access on function parameter", async () => {
    expect(
      await run(
        `
      function getValue(obj: { x: number }): number {
        return obj["x"];
      }
      export function test(): number {
        return getValue({ x: 99 });
      }
    `,
        "test",
      ),
    ).toBe(99);
  });

  it("mixed dot and bracket notation", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        return obj.a + obj["b"] + obj.c;
      }
    `,
        "test",
      ),
    ).toBe(6);
  });

  it("bracket access in assignment", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj = { x: 0 };
        obj["x"] = 100;
        return obj["x"];
      }
    `,
        "test",
      ),
    ).toBe(100);
  });

  it("bracket access on class instance", async () => {
    expect(
      await run(
        `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Point(3, 4);
        return p["x"] + p["y"];
      }
    `,
        "test",
      ),
    ).toBe(7);
  });

  it("numeric literal bracket access on tuple-like", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const arr = [10, 20, 30];
        return arr[0] + arr[2];
      }
    `,
        "test",
      ),
    ).toBe(40);
  });

  it("bracket access with let variable (non-const) string key", async () => {
    expect(
      await run(
        `
      export function test(): number {
        let key: "x" = "x";
        const obj = { x: 42 };
        return obj[key];
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  // Union literal type keys require runtime dispatch -- deferred to #130
  it.skip("bracket access with parameter key (string literal type)", async () => {
    expect(
      await run(
        `
      function get(obj: { a: number; b: number }, key: "a" | "b"): number {
        return obj[key];
      }
      export function test(): number {
        return get({ a: 10, b: 20 }, "a");
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("bracket access with enum value key", async () => {
    expect(
      await run(
        `
      enum Keys { X = "x", Y = "y" }
      export function test(): number {
        const obj = { x: 100, y: 200 };
        return obj[Keys.X];
      }
    `,
        "test",
      ),
    ).toBe(100);
  });

  it("bracket access on nested object", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj = { inner: { val: 55 } };
        return obj["inner"]["val"];
      }
    `,
        "test",
      ),
    ).toBe(55);
  });

  // Record<string, number> (index signature) requires hashmap fallback -- deferred to #130
  it.skip("bracket access on Record<string, number>", async () => {
    expect(
      await run(
        `
      export function test(): number {
        const obj: Record<string, number> = { hello: 42 };
        return obj["hello"];
      }
    `,
        "test",
      ),
    ).toBe(42);
  });
});
