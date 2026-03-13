import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("assignment expression return value", () => {
  it("simple assignment returns value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number = (x = 5);
        return y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained assignment a = b = c = value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        let c: number = 0;
        a = b = c = 42;
        return a + b + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property assignment returns value", async () => {
    await assertEquivalent(
      `
      interface Point { x: number; y: number; }
      export function test(): number {
        let p: Point = { x: 0, y: 0 };
        let result: number = (p.x = 10);
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property assignment in expression context", async () => {
    await assertEquivalent(
      `
      interface Obj { val: number; }
      export function test(): number {
        let o: Obj = { val: 0 };
        return (o.val = 7) + 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained property assignment", async () => {
    await assertEquivalent(
      `
      interface Obj { val: number; }
      export function test(): number {
        let a: Obj = { val: 0 };
        let result: number = (a.val = 5);
        return result + a.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("assignment used as condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        if ((x = 10) > 5) {
          return x;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("assignment in while condition", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum: number = 0;
        let i: number = 0;
        while ((i = i + 1) <= 5) {
          sum = sum + i;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
