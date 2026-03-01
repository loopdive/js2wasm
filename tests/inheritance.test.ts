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

describe("class inheritance", () => {
  it("child accesses parent fields via extends", async () => {
    expect(
      await run(
        `
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
      }
      class Dog extends Animal {
        constructor() {
          super(4);
        }
      }
      export function test(): number {
        const d = new Dog();
        return d.legs;
      }
    `,
        "test",
      ),
    ).toBe(4);
  });

  it("child has own fields alongside parent fields", async () => {
    expect(
      await run(
        `
      class Shape {
        sides: number;
        constructor(sides: number) {
          this.sides = sides;
        }
      }
      class Rectangle extends Shape {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          super(4);
          this.width = w;
          this.height = h;
        }
      }
      export function test(): number {
        const r = new Rectangle(5, 3);
        return r.sides + r.width + r.height;
      }
    `,
        "test",
      ),
    ).toBe(12);
  });

  it("method override: child overrides parent method", async () => {
    expect(
      await run(
        `
      class Animal {
        sound: number;
        constructor(s: number) {
          this.sound = s;
        }
        speak(): number {
          return this.sound;
        }
      }
      class Dog extends Animal {
        constructor() {
          super(0);
        }
        speak(): number {
          return 42;
        }
      }
      export function test(): number {
        const d = new Dog();
        return d.speak();
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("method inheritance: child calls inherited method", async () => {
    expect(
      await run(
        `
      class Base {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
        double(): number {
          return this.value * 2;
        }
      }
      class Child extends Base {
        constructor(v: number) {
          super(v);
        }
      }
      export function test(): number {
        const c = new Child(7);
        return c.double();
      }
    `,
        "test",
      ),
    ).toBe(14);
  });

  it("super.method() calls parent method explicitly", async () => {
    expect(
      await run(
        `
      class Animal {
        val: number;
        constructor(v: number) {
          this.val = v;
        }
        score(): number {
          return this.val;
        }
      }
      class Dog extends Animal {
        bonus: number;
        constructor(v: number, b: number) {
          super(v);
          this.bonus = b;
        }
        score(): number {
          return super.score() + this.bonus;
        }
      }
      export function test(): number {
        const d = new Dog(10, 5);
        return d.score();
      }
    `,
        "test",
      ),
    ).toBe(15);
  });

  it("multi-level inheritance: grandchild extends child", async () => {
    expect(
      await run(
        `
      class A {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
      }
      class B extends A {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
      }
      class C extends B {
        z: number;
        constructor(x: number, y: number, z: number) {
          super(x, y);
          this.z = z;
        }
      }
      export function test(): number {
        const c = new C(1, 2, 3);
        return c.x + c.y + c.z;
      }
    `,
        "test",
      ),
    ).toBe(6);
  });

  it("parent method on parent instance still works", async () => {
    expect(
      await run(
        `
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
        getLegs(): number {
          return this.legs;
        }
      }
      class Dog extends Animal {
        constructor() {
          super(4);
        }
      }
      export function test(): number {
        const a = new Animal(2);
        const d = new Dog();
        return a.getLegs() + d.getLegs();
      }
    `,
        "test",
      ),
    ).toBe(6);
  });
});
