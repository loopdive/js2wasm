import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.defineProperty extended patterns (#1113)", () => {
  it("defineProperty with boolean value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "flag", { value: true });
        return obj.flag ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty value 0 (falsy)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", { value: 0 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty value null", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", { value: null });
        return obj.x === null ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty returns the target object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        const ret: any = Object.defineProperty(obj, "x", { value: 42 });
        return ret.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained defineProperty calls on class", async () => {
    await assertEquivalent(
      `
      class Obj {
        a: number = 0;
        b: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "a", { value: 10 });
        Object.defineProperty(obj, "b", { value: 20 });
        return obj.a + obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with negative value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", { value: -5 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with configurable and enumerable flags", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", {
          value: 42,
          configurable: true,
          enumerable: true
        });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty getter and setter on class", async () => {
    await assertEquivalent(
      `
      class Counter {
        _count: number = 0;
        count: number = 0;
      }
      export function test(): number {
        const c = new Counter();
        Object.defineProperty(c, "count", {
          get(this: Counter) { return this._count; },
          set(this: Counter, v: number) { this._count = v; }
        });
        c.count = 5;
        c.count = c.count + 1;
        return c.count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with expression value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        const val = 21;
        Object.defineProperty(obj, "x", { value: val * 2 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty overwrite existing value", async () => {
    await assertEquivalent(
      `
      class Obj {
        x: number = 10;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "x", { value: 99 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty on non-empty object adds new field", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = { a: 1 };
        Object.defineProperty(obj, "b", { value: 2 });
        return obj.a + obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with writable true then mutation", async () => {
    await assertEquivalent(
      `
      class Obj {
        x: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "x", { value: 10, writable: true });
        obj.x = 20;
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty inside try block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const obj: any = {};
          Object.defineProperty(obj, "x", { value: 42 });
          return obj.x;
        } catch (e) {
          return -1;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with getter using function expression", async () => {
    await assertEquivalent(
      `
      class Obj {
        _val: number = 100;
        val: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "val", {
          get: function(this: Obj) { return this._val; }
        });
        return obj.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple defineProperty with different types on widened object", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj: any = {};
        Object.defineProperty(obj, "num", { value: 42 });
        Object.defineProperty(obj, "str", { value: "hello" });
        return obj.str;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty value is function result", async () => {
    await assertEquivalent(
      `
      function compute(): number { return 7 * 6; }
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", { value: compute() });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
