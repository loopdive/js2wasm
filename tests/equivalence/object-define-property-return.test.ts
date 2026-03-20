import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.defineProperty return value and chaining (#633)", () => {
  it("returns the target object for chaining", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        const result: any = Object.defineProperty(obj, "x", { value: 42 });
        return result.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("overwrite existing property value", async () => {
    await assertEquivalent(
      `
      class Obj {
        foo: number = 10;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "foo", { value: 20 });
        return obj.foo;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with value on widened object (any)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", { value: 42, writable: true, enumerable: true, configurable: true });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with string value descriptor", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj: any = {};
        Object.defineProperty(obj, "name", { value: "hello" });
        return obj.name;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty returns obj when descriptor has no value/get/set", async () => {
    await assertEquivalent(
      `
      class Obj {
        x: number = 5;
      }
      export function test(): number {
        const obj = new Obj();
        const result = Object.defineProperty(obj, "x", { writable: false });
        return result.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("shape inference works inside try block (test262 pattern)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          var obj = {};
          obj.x = 42;
          return obj.x;
        } catch (e) {
          return -1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty inside try block sets value (test262 pattern)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          var obj = {};
          obj.foo = 10;
          Object.defineProperty(obj, "foo", { value: 99 });
          return obj.foo;
        } catch (e) {
          return -1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty inside try block with assert pattern", async () => {
    await assertEquivalent(
      `
      let __fail: number = 0;
      export function test(): number {
        try {
          var obj = {};
          obj.foo = 10;
          Object.defineProperty(obj, "foo", { value: 99 });
          if (obj.foo !== 99) { __fail = 1; }
        } catch (e) {
          __fail = 1;
        }
        if (__fail) { return 0; }
        return 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple properties via defineProperty inside try block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          var obj = {};
          Object.defineProperty(obj, "a", { value: 10 });
          Object.defineProperty(obj, "b", { value: 20 });
          return obj.a + obj.b;
        } catch (e) {
          return -1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
