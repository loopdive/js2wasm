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

describe("instanceof", () => {
  it("returns 1 for matching class", async () => {
    expect(
      await run(
        `
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
      }
      export function test(): number {
        const a = new Animal(4);
        return a instanceof Animal ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("returns 0 for non-matching class", async () => {
    expect(
      await run(
        `
      class Cat {
        name: number;
        constructor(name: number) {
          this.name = name;
        }
      }
      class Dog {
        name: number;
        constructor(name: number) {
          this.name = name;
        }
      }
      export function test(): number {
        const c = new Cat(1);
        return c instanceof Dog ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(0);
  });

  it("works in if-statement condition", async () => {
    expect(
      await run(
        `
      class Circle {
        radius: number;
        constructor(r: number) {
          this.radius = r;
        }
      }
      class Square {
        side: number;
        constructor(s: number) {
          this.side = s;
        }
      }
      export function test(): number {
        const shape = new Circle(5);
        if (shape instanceof Circle) {
          return 1;
        }
        return 0;
      }
    `,
        "test",
      ),
    ).toBe(1);
  });

  it("works with multiple instanceof checks", async () => {
    expect(
      await run(
        `
      class A {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      class B {
        y: number;
        constructor(y: number) { this.y = y; }
      }
      export function test(): number {
        const a = new A(10);
        const b = new B(20);
        let result: number = 0;
        if (a instanceof A) result = result + 1;
        if (b instanceof B) result = result + 2;
        if (a instanceof B) result = result + 4;
        if (b instanceof A) result = result + 8;
        return result;
      }
    `,
        "test",
      ),
    ).toBe(3); // 1 + 2 = 3 (only first two checks pass)
  });
});
