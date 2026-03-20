import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Array HOF callbacks with 3 params (#445)", () => {
  it("filter callback receives (val, idx, arr)", async () => {
    const src = `
      var arr = [10, 20, 30, 40, 50];
      var result = arr.filter(function(val: number, idx: number, obj: number[]) {
        return val > 25;
      });
      export function test(): number { return result.length; }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("some callback receives (val, idx, arr)", async () => {
    const src = `
      var arr = [1, 2, 3, 4, 5];
      var lastIdx = -1;
      arr.some(function(val: number, idx: number, obj: number[]) {
        lastIdx = idx;
        return val > 3;
      });
      export function test(): number { return lastIdx; }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });

  it("every callback receives (val, idx, arr)", async () => {
    const src = `
      var arr = [2, 4, 6, 8];
      var count = 0;
      var result = arr.every(function(val: number, idx: number, obj: number[]) {
        count = count + 1;
        return val % 2 === 0;
      });
      export function test(): number { return count; }
    `;
    await assertEquivalent(src, [{ fn: "test", args: [] }]);
  });
});
