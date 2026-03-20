import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("super property access", () => {
  it("super.method() calls parent class method", async () => {
    await assertEquivalent(
      `
      class Parent {
        greet(): string { return 'hello'; }
      }
      class Child extends Parent {
        greet(): string {
          return super.greet();
        }
      }
      export function test(): string {
        const c = new Child();
        return c.greet();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super.method() with string concatenation", async () => {
    await assertEquivalent(
      `
      class Parent {
        greet(): string { return 'hello'; }
      }
      class Child extends Parent {
        greet(): string {
          return super.greet() + ' world';
        }
      }
      export function test(): string {
        const c = new Child();
        return c.greet();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super.method() with arguments", async () => {
    await assertEquivalent(
      `
      class Parent {
        add(a: number, b: number): number { return a + b; }
      }
      class Child extends Parent {
        add(a: number, b: number): number {
          return super.add(a, b) * 2;
        }
      }
      export function test(): number {
        const c = new Child();
        return c.add(3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super.prop accesses parent class property via getter", async () => {
    await assertEquivalent(
      `
      class Parent {
        get value(): number { return 42; }
      }
      class Child extends Parent {
        getValue(): number {
          return super.value;
        }
      }
      export function test(): number {
        const c = new Child();
        return c.getValue();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super.method() across multiple inheritance levels", async () => {
    await assertEquivalent(
      `
      class A {
        value(): number { return 1; }
      }
      class B extends A {
        value(): number { return super.value() + 10; }
      }
      class C extends B {
        value(): number { return super.value() + 100; }
      }
      export function test(): number {
        const c = new C();
        return c.value();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super.method() in constructor", async () => {
    await assertEquivalent(
      `
      class Parent {
        x: number;
        constructor(x: number) { this.x = x; }
        getX(): number { return this.x; }
      }
      class Child extends Parent {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
        getSum(): number {
          return super.getX() + this.y;
        }
      }
      export function test(): number {
        const c = new Child(10, 20);
        return c.getSum();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super.method() returning string in override", async () => {
    await assertEquivalent(
      `
      class Base {
        toString(): string { return 'Base'; }
      }
      class Sub extends Base {
        toString(): string { return super.toString() + ':Sub'; }
      }
      export function test(): string {
        const s = new Sub();
        return s.toString();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
