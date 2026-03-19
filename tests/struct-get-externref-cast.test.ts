import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

/**
 * Test for issue #581: struct.get on ref.null in Wasm:test function.
 * When a class instance variable is typed as externref but actually holds a
 * struct ref, struct.get needs a cast from externref to the struct type.
 */
describe("struct.get on externref cast (#581)", () => {
  it("should access properties on class instances", async () => {
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
        return p.x + p.y;
      }
    `,
        "test",
      ),
    ).toBe(7);
  });

  it("should access properties after reassignment", async () => {
    expect(
      await run(
        `
      class Box {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        let b: Box = new Box(10);
        b = new Box(20);
        return b.value;
      }
    `,
        "test",
      ),
    ).toBe(20);
  });

  it("should handle class with multiple fields accessed separately", async () => {
    expect(
      await run(
        `
      class Rect {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
      }
      export function test(): number {
        const r = new Rect(5, 10);
        return r.width * r.height;
      }
    `,
        "test",
      ),
    ).toBe(50);
  });

  it("should handle class property access in function returns", async () => {
    expect(
      await run(
        `
      class Counter {
        count: number;
        constructor() {
          this.count = 0;
        }
      }
      function getCount(c: Counter): number {
        return c.count;
      }
      export function test(): number {
        const counter = new Counter();
        return getCount(counter);
      }
    `,
        "test",
      ),
    ).toBe(0);
  });

  it("should handle class property access with conditional", async () => {
    expect(
      await run(
        `
      class Pair {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
      }
      export function test(): number {
        const p = new Pair(1, 2);
        return p.a < p.b ? p.b : p.a;
      }
    `,
        "test",
      ),
    ).toBe(2);
  });
});
