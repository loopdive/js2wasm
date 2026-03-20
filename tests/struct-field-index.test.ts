import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("struct field index validation (#423)", () => {
  it("subclass with own field and instanceof", async () => {
    const exports = await compileToWasm(`
      class Base {
        constructor() {}
      }
      class Sub extends Base {
        val: number;
        constructor(v: number) {
          super();
          this.val = v;
        }
      }
      export function test(): number {
        const s = new Sub(42);
        return s.val;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("child class accesses parent field correctly", async () => {
    const exports = await compileToWasm(`
      class Animal {
        legs: number;
        constructor(legs: number) {
          this.legs = legs;
        }
      }
      class Dog extends Animal {
        breed: number;
        constructor(breed: number) {
          super(4);
          this.breed = breed;
        }
      }
      export function test(): number {
        const d = new Dog(7);
        return d.legs + d.breed;
      }
    `);
    expect(exports.test()).toBe(11);
  });

  it("subclass of empty base with no own fields compiles without invalid field index", async () => {
    // Simulates the subclass-builtins pattern: extending a class that
    // has no struct fields. Before the fix, the child struct had no __tag
    // field, causing "invalid field index: 0" errors.
    const exports = await compileToWasm(`
      class Empty {
        constructor() {}
      }
      class Sub extends Empty {
        constructor() {
          super();
        }
      }
      export function test(): number {
        const s = new Sub();
        return s instanceof Sub ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("multi-level inheritance with fields", async () => {
    const exports = await compileToWasm(`
      class A {
        x: number;
        constructor(x: number) { this.x = x; }
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
    `);
    expect(exports.test()).toBe(6);
  });
});
