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

describe("instanceof", { timeout: 15000 }, () => {
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

  it("supports class hierarchy — child instanceof Parent", async () => {
    expect(
      await run(
        `
      class Animal {
        legs: number;
        constructor(legs: number) { this.legs = legs; }
      }
      class Dog extends Animal {
        name: number;
        constructor(name: number) {
          super(4);
          this.name = name;
        }
      }
      export function test(): number {
        const d = new Dog(1);
        let result: number = 0;
        if (d instanceof Animal) result = result + 1;
        if (d instanceof Dog) result = result + 2;
        return result;
      }
    `,
        "test",
      ),
    ).toBe(3); // Dog is both an Animal and a Dog
  });

  it("supports deep class hierarchy — grandchild instanceof Grandparent", async () => {
    expect(
      await run(
        `
      class Base {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      class Middle extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
      }
      class Leaf extends Middle {
        z: number;
        constructor(x: number, y: number, z: number) {
          super(x, y);
          this.z = z;
        }
      }
      export function test(): number {
        const leaf = new Leaf(1, 2, 3);
        let result: number = 0;
        if (leaf instanceof Base) result = result + 1;
        if (leaf instanceof Middle) result = result + 2;
        if (leaf instanceof Leaf) result = result + 4;
        return result;
      }
    `,
        "test",
      ),
    ).toBe(7); // Leaf is Base, Middle, and Leaf
  });

  it("parent is not instanceof child", async () => {
    expect(
      await run(
        `
      class Parent {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      class Child extends Parent {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Parent(1);
        return p instanceof Child ? 1 : 0;
      }
    `,
        "test",
      ),
    ).toBe(0); // Parent is NOT a Child
  });
});
