import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("compound assignment on property access (#195)", () => {
  it("obj.prop += value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        obj.x += 5;
        return obj.x;  // 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.prop -= value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        obj.x -= 3;
        return obj.x;  // 7
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.prop *= value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        obj.x *= 4;
        return obj.x;  // 20
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arr[i] += value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let arr = [10, 20, 30];
        arr[1] += 5;
        return arr[1];  // 25
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment returns new value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        let result = (obj.x += 5);
        return result;  // 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
