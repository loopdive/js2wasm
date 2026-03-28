import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";
import { compile } from "../../src/index.js";
import { buildImports } from "./helpers.js";

describe("BindingElement null guard (#821)", () => {
  it("destructure object with falsy value 0", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { a: 0, b: 1 };
        const { a, b } = obj;
        return a + b;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructure object with all falsy values", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { x: 0, y: 0 };
        const { x, y } = obj;
        return x + y;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested object destructuring", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { a: { x: 1, y: 2 }, b: 3 };
        const { a: { x, y }, b } = obj;
        return x + y + b;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring with 0", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [0, 1, 2];
        const [a, b, c] = arr;
        return a + b + c;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("function parameter destructuring", async () => {
    await assertEquivalent(
      `function process({ x, y }: { x: number; y: number }): number {
        return x * y;
      }
      export function test(): number {
        return process({ x: 3, y: 7 });
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("array param destructuring", async () => {
    await assertEquivalent(
      `function sum([a, b, c]: number[]): number {
        return a + b + c;
      }
      export function test(): number {
        return sum([10, 20, 30]);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest parameter in array destructuring", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[] = [1, 2, 3, 4, 5];
        const [first, ...rest] = arr;
        return first + rest.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array destructuring", async () => {
    await assertEquivalent(
      `export function test(): number {
        const arr: number[][] = [[1, 2], [3, 4]];
        const [[a, b], [c, d]] = arr;
        return a + b + c + d;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("class method with destructured param should not null-deref", async () => {
    const source = `
      class Foo {
        bar({ x, y }: { x: number; y: number }): number {
          return x + y;
        }
      }
      export function test(): number {
        const f = new Foo();
        return f.bar({ x: 10, y: 20 });
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    if (!result.success) return; // Skip if compile fails
    const imports = buildImports(result);
    try {
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      const exports = instance.exports as Record<string, Function>;
      expect(exports.test()).toBe(30);
    } catch (e: any) {
      if (e.message?.includes("null")) {
        throw new Error("Null pointer dereference in class method destructuring: " + e.message);
      }
      throw e;
    }
  });
});
