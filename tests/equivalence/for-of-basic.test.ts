import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("for-of basic iteration", () => {
  it("for-of over number array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30, 40];
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of over empty array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [];
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of over single-element array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [42];
        let result = 0;
        for (const x of arr) {
          result = x;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with let binding", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [1, 2, 3, 4, 5];
        let count = 0;
        for (let x of arr) {
          x = x * 2;
          count += x;
        }
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with index tracking via separate counter", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        let i = 0;
        let weighted = 0;
        for (const x of arr) {
          weighted += x * i;
          i++;
        }
        return weighted;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with break", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [1, 2, 3, 4, 5];
        let sum = 0;
        for (const x of arr) {
          if (x === 4) break;
          sum += x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of accumulating product", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [2, 3, 4];
        let product = 1;
        for (const x of arr) {
          product = product * x;
        }
        return product;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
