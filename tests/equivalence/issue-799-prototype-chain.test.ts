import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("#799 Prototype chain — Object.prototype methods on class instances", () => {
  it("class instance toString()", () => {
    assertEquivalent(
      `
      class Foo { x = 1; }
      export function test(): string {
        const f = new Foo();
        return f.toString();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class instance valueOf()", () => {
    assertEquivalent(
      `
      class Bar { y = 2; }
      export function test(): any {
        const b = new Bar();
        return typeof b.valueOf();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class instance hasOwnProperty()", () => {
    assertEquivalent(
      `
      class Baz { z = 3; }
      export function test(): number {
        const b = new Baz();
        return b.hasOwnProperty("z") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("inherited method from parent class", () => {
    assertEquivalent(
      `
      class Animal { speak() { return "..."; } }
      class Dog extends Animal {}
      export function test(): string {
        const d = new Dog();
        return d.speak();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("method with underscore in name is inherited", () => {
    assertEquivalent(
      `
      class Base { get_name() { return "base"; } }
      class Child extends Base {}
      export function test(): string {
        const c = new Child();
        return c.get_name();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
