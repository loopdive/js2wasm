import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("null narrowing in if statements", () => {
  it("if (x !== null) narrows x to non-null for property access", async () => {
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
        let p: Point | null = new Point(3, 4);
        if (p !== null) {
          return p.x + p.y;
        }
        return -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("if (x === null) narrows x to non-null in else branch", async () => {
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
        let p: Point | null = new Point(5, 6);
        if (p === null) {
          return -1;
        } else {
          return p.x + p.y;
        }
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("if (x != null) with loose inequality", async () => {
    await assertEquivalent(
      `class Box {
        val: number;
        constructor(v: number) {
          this.val = v;
        }
      }
      export function test(): number {
        let b: Box | null = new Box(42);
        if (b != null) {
          return b.val;
        }
        return 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("null narrowing does not leak out of if scope", async () => {
    await assertEquivalent(
      `class Item {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        let a: Item | null = new Item(10);
        let result = 0;
        if (a !== null) {
          result = a.value;
        }
        // After if block, narrowing should not apply
        // but a is still non-null so this should still work
        if (a !== null) {
          result = result + a.value;
        }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("narrowing with null on left side: null !== x", async () => {
    await assertEquivalent(
      `class Pair {
        a: number;
        b: number;
        constructor(a: number, b: number) {
          this.a = a;
          this.b = b;
        }
      }
      export function test(): number {
        let p: Pair | null = new Pair(7, 8);
        if (null !== p) {
          return p.a * p.b;
        }
        return 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
