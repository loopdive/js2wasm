import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.defineProperty getter/setter (#459)", () => {
  it("getter returning constant", async () => {
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

  it("getter returning computed value from backing field", async () => {
    await assertEquivalent(
      `
      class Rect {
        width: number = 3;
        height: number = 4;
        area: number = 0;
      }
      export function test(): number {
        const r = new Rect();
        Object.defineProperty(r, "area", {
          get(this: Rect) { return this.width * this.height; }
        });
        return r.area;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("getter and setter together", async () => {
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

  it("setter modifies backing field", async () => {
    await assertEquivalent(
      `
      class Container {
        _data: number = 0;
        data: number = 0;
      }
      export function test(): number {
        const c = new Container();
        Object.defineProperty(c, "data", {
          get(this: Container) { return this._data; },
          set(this: Container, v: number) { this._data = v + 100; }
        });
        c.data = 7;
        return c.data;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("getter with function expression syntax", async () => {
    await assertEquivalent(
      `
      class Obj {
        val: number = 0;
      }
      export function test(): number {
        const obj = new Obj();
        Object.defineProperty(obj, "val", { get: function(this: Obj) { return 99; } });
        return obj.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
