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

describe("issue-341: property introspection (hasOwnProperty, propertyIsEnumerable)", () => {
  describe("hasOwnProperty with static keys", () => {
    it("returns true for existing property", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { x: 1, y: 2 };
          return obj.hasOwnProperty("x") ? 1 : 0;
        }
      `),
      ).toBe(1);
    });

    it("returns false for non-existing property", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { x: 1, y: 2 };
          return obj.hasOwnProperty("z") ? 1 : 0;
        }
      `),
      ).toBe(0);
    });

    it("works with multiple property checks", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { a: 10, b: 20, c: 30 };
          let count = 0;
          if (obj.hasOwnProperty("a")) count = count + 1;
          if (obj.hasOwnProperty("b")) count = count + 1;
          if (obj.hasOwnProperty("c")) count = count + 1;
          if (obj.hasOwnProperty("d")) count = count + 1;
          return count;
        }
      `),
      ).toBe(3);
    });
  });

  describe("propertyIsEnumerable with static keys", () => {
    it("returns true for existing property", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { x: 1, y: 2 };
          return obj.propertyIsEnumerable("x") ? 1 : 0;
        }
      `),
      ).toBe(1);
    });

    it("returns false for non-existing property", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { x: 1, y: 2 };
          return obj.propertyIsEnumerable("z") ? 1 : 0;
        }
      `),
      ).toBe(0);
    });
  });

  describe("hasOwnProperty on class instances", () => {
    it("returns true for class fields", async () => {
      expect(
        await run(`
        class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
          }
        }
        export function test(): number {
          const p = new Point(1, 2);
          let count = 0;
          if (p.hasOwnProperty("x")) count = count + 1;
          if (p.hasOwnProperty("y")) count = count + 1;
          if (p.hasOwnProperty("z")) count = count + 1;
          return count;
        }
      `),
      ).toBe(2);
    });
  });

  describe("in operator (existing functionality)", () => {
    it("static key in object literal", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { x: 1, y: 2 };
          if (!("x" in obj)) return 0;
          if (!("y" in obj)) return 0;
          if ("z" in obj) return 0;
          return 1;
        }
      `),
      ).toBe(1);
    });
  });

  describe("hasOwnProperty with no arguments", () => {
    it("returns false when called with no args", async () => {
      expect(
        await run(`
        export function test(): number {
          const obj = { x: 1 };
          return (obj as any).hasOwnProperty() ? 1 : 0;
        }
      `),
      ).toBe(0);
    });
  });
});
