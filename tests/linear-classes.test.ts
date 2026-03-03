import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("linear-memory classes", { timeout: 30_000 }, () => {
  it("compiles class construction and field access", async () => {
    const result = compile(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function getX(px: number, py: number): number {
        const p = new Point(px, py);
        return p.x;
      }
      export function getY(px: number, py: number): number {
        const p = new Point(px, py);
        return p.y;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const { getX, getY } = instance.exports as any;
    expect(getX(10, 20)).toBe(10);
    expect(getY(10, 20)).toBe(20);
  });

  it("compiles class methods", async () => {
    const result = compile(`
      class Counter {
        value: number;
        constructor(init: number) {
          this.value = init;
        }
        increment(): void {
          this.value = this.value + 1;
        }
        get(): number {
          return this.value;
        }
      }
      export function test(): number {
        const c = new Counter(10);
        c.increment();
        c.increment();
        return c.get();
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as any).test()).toBe(12);
  });

  it("compiles string literals and equality", async () => {
    const result = compile(`
      export function test(): number {
        const a = "hello";
        const b = "hello";
        const c = "world";
        if (a === b) {
          if (a === c) return 0;
          return 1;
        }
        return 2;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as any).test()).toBe(1);
  });
});
