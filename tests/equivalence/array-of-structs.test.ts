import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("array of class instances (struct refs)", () => {
  it("create array of class instances and read property", async () => {
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
        var points: Point[] = [new Point(1, 2), new Point(3, 4)];
        return points[0].x + points[1].y;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Array() with class instances pushed", async () => {
    await assertEquivalent(
      `class Box {
        val: number;
        constructor(v: number) {
          this.val = v;
        }
      }
      export function test(): number {
        var boxes: Box[] = new Array<Box>();
        boxes.push(new Box(10));
        boxes.push(new Box(20));
        return boxes[0].val + boxes[1].val;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Array(n) with class instance assignment", async () => {
    await assertEquivalent(
      `class Item {
        value: number;
        constructor(v: number) {
          this.value = v;
        }
      }
      export function test(): number {
        var items: Item[] = new Array<Item>(3);
        items[0] = new Item(5);
        items[1] = new Item(10);
        items[2] = new Item(15);
        return items[0].value + items[1].value + items[2].value;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("array literal with class instances", async () => {
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
        var pairs = [new Pair(1, 2), new Pair(3, 4), new Pair(5, 6)];
        var sum = 0;
        for (var i = 0; i < pairs.length; i++) {
          sum = sum + pairs[i].a + pairs[i].b;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
