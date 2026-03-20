import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Reflect API compile-time rewrites", () => {
  it("Reflect.get(obj, prop) reads a property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 42, y: 99 };
        return Reflect.get(obj, "x");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.set(obj, prop, val) sets a property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 0 };
        Reflect.set(obj, "x", 55);
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.has(obj, prop) checks property existence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10, y: 20 };
        return Reflect.has(obj, "x") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.has returns 0 for missing property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10 };
        return Reflect.has(obj, "z") ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.construct creates a new instance", async () => {
    await assertEquivalent(
      `
      class Foo {
        x: number;
        constructor(x: number) {
          this.x = x;
        }
        getX(): number { return this.x; }
      }
      export function test(): number {
        const foo: Foo = Reflect.construct(Foo, [42]) as Foo;
        return foo.getX();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.deleteProperty compiles without error", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10 };
        Reflect.deleteProperty(obj, "x");
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.isExtensible compiles (stub returns truthy)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        return Reflect.isExtensible(obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Reflect.preventExtensions compiles (stub returns truthy)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        return Reflect.preventExtensions(obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
