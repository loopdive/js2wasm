import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Object.prototype.hasOwnProperty.call", () => {
  it("returns true for existing property (static key)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { x: 1, y: 2 };
        return Object.prototype.hasOwnProperty.call(obj, "x") ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns false for non-existing property (static key)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { x: 1, y: 2 };
        return Object.prototype.hasOwnProperty.call(obj, "z") ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("works with multiple property checks", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { a: 10, b: 20, c: 30 };
        let count = 0;
        if (Object.prototype.hasOwnProperty.call(obj, "a")) count = count + 1;
        if (Object.prototype.hasOwnProperty.call(obj, "b")) count = count + 1;
        if (Object.prototype.hasOwnProperty.call(obj, "c")) count = count + 1;
        if (Object.prototype.hasOwnProperty.call(obj, "d")) count = count + 1;
        return count;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("works on class instances", async () => {
    await assertEquivalent(
      `class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Point(1, 2);
        let count = 0;
        if (Object.prototype.hasOwnProperty.call(p, "x")) count = count + 1;
        if (Object.prototype.hasOwnProperty.call(p, "y")) count = count + 1;
        if (Object.prototype.hasOwnProperty.call(p, "z")) count = count + 1;
        return count;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns false for class methods (they live on prototype)", async () => {
    await assertEquivalent(
      `class C {
        x: number;
        constructor(x: number) { this.x = x; }
        getX(): number { return this.x; }
      }
      export function test(): number {
        const c = new C(42);
        let result = 0;
        // x is an own data property — hasOwnProperty should return true
        if (Object.prototype.hasOwnProperty.call(c, "x")) result = result + 1;
        // getX is a method on the prototype — hasOwnProperty should return false
        if (Object.prototype.hasOwnProperty.call(c, "getX")) result = result + 10;
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns false for private methods", async () => {
    await assertEquivalent(
      `class C {
        x: number;
        constructor(x: number) { this.x = x; }
        #secret(): number { return this.x * 2; }
        getSecret(): number { return this.#secret(); }
      }
      export function test(): number {
        const c = new C(21);
        let result = 0;
        // x is an own data property — true
        if (Object.prototype.hasOwnProperty.call(c, "x")) result = result + 1;
        // "secret" (without #) should NOT be an own property
        if (Object.prototype.hasOwnProperty.call(c, "secret")) result = result + 10;
        // "getSecret" is a prototype method — should be false
        if (Object.prototype.hasOwnProperty.call(c, "getSecret")) result = result + 100;
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns false when called with no key argument", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = { x: 1 };
        return (Object.prototype.hasOwnProperty as any).call(obj) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
