import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Issue #705: call argument count", () => {
  it("every with 1 param works", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [1, 2, 3];
        var result = arr.every(function(x: number): boolean { return x > 0; });
        return result ? 1 : 0;
      }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("some with 2 params works", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [10, 20, 30];
        var sum = 0;
        arr.some(function(val: number, idx: number): boolean {
          sum = sum + idx;
          return false;
        });
        return sum;
      }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("filter with 2 params works", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [10, 20, 30, 40, 50];
        var result = arr.filter(function(val: number, idx: number): boolean {
          return idx >= 2;
        });
        return result.length;
      }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("map with 2 params works", async () => {
    const src = `
      export function test(): number {
        var arr: number[] = [10, 20, 30];
        var result = arr.map(function(x: number, i: number): number { return x + i; });
        return result[0] + result[1] + result[2];
      }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("forEach with 2 params and capture works", async () => {
    const src = `
      export function test(): number {
        var indexSum = 0;
        var arr: number[] = [10, 20, 30];
        arr.forEach(function(x: number, i: number) { indexSum = indexSum + i; });
        return indexSum;
      }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });
});
