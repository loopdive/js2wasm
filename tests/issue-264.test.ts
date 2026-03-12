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

describe("issue-264: element access (bracket notation) on struct types", () => {
  it("read with string literal: obj['x']", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 10, y: 20 };
        }
        export function test(): number {
          const obj = make();
          return obj["x"] + obj["y"];
        }
        `,
        "test",
      ),
    ).toBe(30);
  });

  it("write with string literal: obj['x'] = 5", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 1, y: 2 };
        }
        export function test(): number {
          const obj = make();
          obj["x"] = 5;
          return obj["x"] + obj["y"];
        }
        `,
        "test",
      ),
    ).toBe(7);
  });

  it("read with const key variable", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 42, y: 99 };
        }
        export function test(): number {
          const key = "x";
          const obj = make();
          return obj[key];
        }
        `,
        "test",
      ),
    ).toBe(42);
  });

  it("write with const key variable", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 1, y: 2 };
        }
        export function test(): number {
          const key = "x";
          const obj = make();
          obj[key] = 100;
          return obj["x"];
        }
        `,
        "test",
      ),
    ).toBe(100);
  });

  it("mixed dot and bracket notation", async () => {
    expect(
      await run(
        `
        function make(): { a: number; b: number } {
          return { a: 3, b: 7 };
        }
        export function test(): number {
          const obj = make();
          obj["a"] = obj.b * 2;
          return obj.a;
        }
        `,
        "test",
      ),
    ).toBe(14);
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
          const p = new Point(5, 10);
          return p["x"] + p["y"];
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  it("bracket write on class instance", async () => {
    expect(
      await run(
        `
        class Vec2 {
          x: number;
          y: number;
          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
          }
        }
        export function test(): number {
          const v = new Vec2(1, 2);
          v["x"] = 10;
          v["y"] = 20;
          return v.x + v.y;
        }
        `,
        "test",
      ),
    ).toBe(30);
  });
});
