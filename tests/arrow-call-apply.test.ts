import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("arrow function .call() and .apply()", () => {
  it("arrow.call() drops thisArg and passes arguments", async () => {
    await assertEquivalent(
      `
      const add = (a: number, b: number): number => a + b;
      export function test(): number {
        return add.call(null, 10, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow.apply() drops thisArg and passes arguments from array", async () => {
    await assertEquivalent(
      `
      const multiply = (a: number, b: number): number => a * b;
      export function test(): number {
        return multiply.apply(null, [6, 7]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow.call() with no extra args", async () => {
    await assertEquivalent(
      `
      const getFortyTwo = (): number => 42;
      export function test(): number {
        return getFortyTwo.call(null);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow.apply() with no args array", async () => {
    await assertEquivalent(
      `
      const getFortyTwo = (): number => 42;
      export function test(): number {
        return getFortyTwo.apply(null);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow.call() with undefined thisArg", async () => {
    await assertEquivalent(
      `
      const sub = (a: number, b: number): number => a - b;
      export function test(): number {
        return sub.call(undefined, 100, 58);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("regular function.call() still works", async () => {
    await assertEquivalent(
      `
      function add(a: number, b: number): number { return a + b; }
      export function test(): number {
        return add.call(null, 10, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("regular function.apply() still works", async () => {
    await assertEquivalent(
      `
      function multiply(a: number, b: number): number { return a * b; }
      export function test(): number {
        return multiply.apply(null, [6, 7]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("module-level arrow function plain call works", async () => {
    await assertEquivalent(
      `
      const add = (a: number, b: number): number => a + b;
      export function test(): number {
        return add(10, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow.call() with object thisArg ignored", async () => {
    await assertEquivalent(
      `
      const getValue = (x: number): number => x * 2;
      export function test(): number {
        return getValue.call({}, 21);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("local arrow function .call()", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const add = (a: number, b: number): number => a + b;
        return add.call(null, 3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("local arrow function .apply()", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const mul = (a: number, b: number): number => a * b;
        return mul.apply(null, [5, 6]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
