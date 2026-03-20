import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("super element access", () => {
  it("super['method']() calls parent method via computed key", async () => {
    await assertEquivalent(
      `
      class Parent {
        greet(): string { return 'hello'; }
      }
      class Child extends Parent {
        greet(): string {
          return super['greet']();
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

  it("super['method']() with arguments", async () => {
    await assertEquivalent(
      `
      class Parent {
        add(a: number, b: number): number { return a + b; }
      }
      class Child extends Parent {
        add(a: number, b: number): number {
          return super['add'](a, b) * 2;
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

  it("super['method']() across inheritance chain", async () => {
    await assertEquivalent(
      `
      class A {
        value(): number { return 1; }
      }
      class B extends A {
        value(): number { return super['value']() + 10; }
      }
      class C extends B {
        value(): number { return super['value']() + 100; }
      }
      export function test(): number {
        const c = new C();
        return c.value();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super['getter'] accesses parent getter via element access", async () => {
    await assertEquivalent(
      `
      class Parent {
        get val(): number { return 99; }
      }
      class Child extends Parent {
        getVal(): number {
          return super['val'];
        }
      }
      export function test(): number {
        const c = new Child();
        return c.getVal();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
