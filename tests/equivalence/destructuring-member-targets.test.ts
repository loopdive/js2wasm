import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("destructuring assignment to member expression targets", () => {
  it("array destructuring to property access targets", async () => {
    await assertEquivalent(
      `
      interface Point { x: number; y: number; }
      export function test(): number {
        let obj: Point = { x: 0, y: 0 };
        [obj.x, obj.y] = [10, 20];
        return obj.x + obj.y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring to property access targets", async () => {
    await assertEquivalent(
      `
      interface Target { prop: number; }
      interface Source { a: number; b: number; }
      export function test(): number {
        let obj: Target = { prop: 0 };
        let obj2: Target = { prop: 0 };
        let source: Source = { a: 42, b: 99 };
        ({a: obj.prop, b: obj2.prop} = source);
        return obj.prop + obj2.prop;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring to element access targets", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr: number[] = [0, 0, 0];
        [arr[0], arr[1]] = [10, 20];
        return arr[0] + arr[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("mixed identifier and member targets in array destructuring", async () => {
    await assertEquivalent(
      `
      interface Point { x: number; y: number; }
      export function test(): number {
        let obj: Point = { x: 0, y: 0 };
        let z: number = 0;
        [obj.x, z, obj.y] = [5, 10, 15];
        return obj.x + z + obj.y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested destructuring with member targets", async () => {
    await assertEquivalent(
      `
      interface Result { value: number; }
      interface Pair { a: number; b: number; }
      export function test(): number {
        let r: Result = { value: 0 };
        let pair: Pair = { a: 1, b: 2 };
        ({a: r.value} = pair);
        return r.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring with plain identifiers from array literal", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        let z: number = 0;
        let vals: number[] = [1, 2, 3];
        [x, y, z] = vals;
        return x + y + z;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained array destructuring assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        let vals: number[] = [10, 20];
        let result: number[] = [x, y] = vals;
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("parenthesized assignment target", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        (x) = 42;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("parenthesized property access assignment", async () => {
    await assertEquivalent(
      `
      interface Obj { val: number; }
      export function test(): number {
        let obj: Obj = { val: 0 };
        (obj.val) = 99;
        return obj.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("empty array destructuring assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let vals: number[] = [1, 2, 3];
        let result: number[] = [] = vals;
        return result.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array elision destructuring assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let vals: number[] = [42, 99];
        let result: number[];
        [, x] = vals;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array rest after element", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number[] = [];
        let vals: number[] = [1, 2, 3];
        [x, ...y] = vals;
        return x + y.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array destructuring assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let vals: number[][] = [[7]];
        [[x]] = vals;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
