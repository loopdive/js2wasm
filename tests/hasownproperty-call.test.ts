import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

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
