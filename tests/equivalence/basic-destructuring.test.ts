import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("basic destructuring", () => {
  it("array destructuring from literal", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let [a, b, c] = [1, 2, 3];
        return a * 100 + b * 10 + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring from literal", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let {x, y} = {x: 10, y: 20};
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function parameter array destructuring", async () => {
    await assertEquivalent(
      `
      function f([a, b]: number[]): number { return a + b; }
      export function test(): number {
        return f([3, 7]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function parameter object destructuring", async () => {
    await assertEquivalent(
      `
      interface Pt { x: number; y: number; }
      function f({x, y}: Pt): number { return x + y; }
      export function test(): number {
        return f({x: 5, y: 15});
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("const array destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const [a, b] = [100, 200];
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("const object destructuring", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const {x, y} = {x: 42, y: 58};
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring with renamed properties", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const {x: a, y: b} = {x: 42, y: 58};
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring from function return", async () => {
    await assertEquivalent(
      `
      interface Pt { x: number; y: number; }
      function getPoint(): Pt {
        return {x: 3, y: 7};
      }
      export function test(): number {
        const {x, y} = getPoint();
        return x * 10 + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested object destructuring", async () => {
    await assertEquivalent(
      `
      interface Inner { value: number; }
      interface Outer { inner: Inner; label: number; }
      export function test(): number {
        const obj: Outer = { inner: { value: 42 }, label: 10 };
        const { inner: { value }, label } = obj;
        return value + label;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring return value usage", async () => {
    await assertEquivalent(
      `
      function getValues(): number[] {
        return [10, 20, 30];
      }
      export function test(): number {
        let [a, b, c] = getValues();
        return a + b + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple destructuring in sequence", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let [a, b] = [1, 2];
        let [c, d] = [3, 4];
        return a + b + c + d;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructuring with skipped elements", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let [a, , c] = [1, 2, 3];
        return a + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
