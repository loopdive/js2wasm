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

describe("classes", () => {
  it("constructor and property access", async () => {
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

  it("method call", async () => {
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
        sum(): number {
          return this.x + this.y;
        }
      }
      export function test(): number {
        const p = new Point(10, 20);
        return p.sum();
      }
    `,
        "test",
      ),
    ).toBe(30);
  });

  it("method with parameters", async () => {
    expect(
      await run(
        `
      class Counter {
        value: number;
        constructor(initial: number) {
          this.value = initial;
        }
        add(n: number): number {
          this.value = this.value + n;
          return this.value;
        }
      }
      export function test(): number {
        const c = new Counter(10);
        c.add(5);
        c.add(3);
        return c.value;
      }
    `,
        "test",
      ),
    ).toBe(18);
  });

  it("passing instance between functions", async () => {
    expect(
      await run(
        `
      class Rect {
        w: number;
        h: number;
        constructor(w: number, h: number) {
          this.w = w;
          this.h = h;
        }
        area(): number {
          return this.w * this.h;
        }
      }
      function doubleArea(r: Rect): number {
        return r.area() * 2;
      }
      export function test(): number {
        const r = new Rect(3, 4);
        return doubleArea(r);
      }
    `,
        "test",
      ),
    ).toBe(24);
  });

  it("multiple instances", async () => {
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
        const a = new Vec2(1, 2);
        const b = new Vec2(3, 4);
        return a.x + a.y + b.x + b.y;
      }
    `,
        "test",
      ),
    ).toBe(10);
  });

  it("property declaration without constructor assignment", async () => {
    expect(
      await run(
        `
      class Box {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
      }
      export function test(): number {
        const b = new Box(5, 3);
        return b.width * b.height;
      }
    `,
        "test",
      ),
    ).toBe(15);
  });

  it("method returning boolean", async () => {
    expect(
      await run(
        `
      class Range {
        min: number;
        max: number;
        constructor(min: number, max: number) {
          this.min = min;
          this.max = max;
        }
        contains(v: number): boolean {
          return v >= this.min && v <= this.max;
        }
      }
      export function test(): number {
        const r = new Range(0, 10);
        if (r.contains(5)) {
          return 1;
        }
        return 0;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });
});
