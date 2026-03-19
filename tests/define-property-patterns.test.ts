import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Object.defineProperty compile-time descriptors (#125)", () => {
  it("writable:true allows assignment on widened object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "b", { writable: true, value: 0 });
        obj.b = 11;
        return obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("writable flag with no value then assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "b", { writable: true });
        obj.b = 11;
        return obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("descriptor flags accepted but ignored", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", {
          value: 99,
          writable: false,
          enumerable: true,
          configurable: false
        });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("value descriptor on class instance", async () => {
    await assertEquivalent(
      `
      class Obj {
        x: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "x", { value: 42 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple defineProperty calls on class instance", async () => {
    await assertEquivalent(
      `
      class Obj {
        a: number = 0;
        b: number = 0;
        c: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "a", { value: 1 });
        Object.defineProperty(obj, "b", { value: 2 });
        Object.defineProperty(obj, "c", { value: 3 });
        return obj.a + obj.b + obj.c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("writable:false then read on widened object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "b", { writable: false, value: 42 });
        return obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("getter accessor on class", async () => {
    await assertEquivalent(
      `
      class Obj {
        x: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "x", { get() { return 42; } });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("getter and setter together on class", async () => {
    await assertEquivalent(
      `
      class Obj {
        _v: number = 0;
        v: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "v", {
          get(this: Obj) { return this._v; },
          set(this: Obj, val: number) { this._v = val * 2; }
        });
        obj.v = 5;
        return obj.v;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("writable:true then assignment on class instance", async () => {
    await assertEquivalent(
      `
      class Obj {
        b: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "b", { writable: true, value: 0 });
        obj.b = 11;
        return obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
