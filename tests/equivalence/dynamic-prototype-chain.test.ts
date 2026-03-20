import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Dynamic prototype chain traversal (#678)", () => {
  it("Object.getPrototypeOf(instance) === ClassName.prototype", async () => {
    await assertEquivalent(
      `
      class Foo {
        x: number = 1;
      }
      export function test(): number {
        const f = new Foo();
        return Object.getPrototypeOf(f) === Foo.prototype ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.getPrototypeOf(Child.prototype) === Parent.prototype", async () => {
    await assertEquivalent(
      `
      class Parent {
        x: number = 1;
      }
      class Child extends Parent {
        y: number = 2;
      }
      export function test(): number {
        return Object.getPrototypeOf(Child.prototype) === Parent.prototype ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prototype chain: grandchild -> child -> parent", async () => {
    await assertEquivalent(
      `
      class A { a: number = 1; }
      class B extends A { b: number = 2; }
      class C extends B { c: number = 3; }
      export function test(): number {
        let r = 0;
        // C.prototype.__proto__ === B.prototype
        if (Object.getPrototypeOf(C.prototype) === B.prototype) r += 1;
        // B.prototype.__proto__ === A.prototype
        if (Object.getPrototypeOf(B.prototype) === A.prototype) r += 2;
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("instanceof works with __proto__ field present", async () => {
    await assertEquivalent(
      `
      class Animal {
        legs: number;
        constructor(legs: number) { this.legs = legs; }
      }
      class Dog extends Animal {
        constructor() { super(4); }
      }
      export function test(): number {
        const d = new Dog();
        let r = 0;
        if (d instanceof Dog) r += 1;
        if (d instanceof Animal) r += 2;
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Note: Object.getPrototypeOf(RootClass.prototype) returns null in our model
  // because we don't model Object.prototype. In JS it returns Object.prototype.
  // This is a known limitation — not tested via assertEquivalent.

  it("subclass field access works with __proto__ field", async () => {
    await assertEquivalent(
      `
      class Base {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      class Sub extends Base {
        y: number;
        constructor(x: number, y: number) {
          super(x);
          this.y = y;
        }
      }
      export function test(): number {
        const s = new Sub(10, 20);
        return s.x + s.y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
