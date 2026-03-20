import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("compound assignment on unresolvable property type (#404)", () => {
  it("obj.prop += value on struct with known fields", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10, y: 20 };
        obj.x += 5;
        return obj.x;  // 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment on function return value property", async () => {
    await assertEquivalent(
      `
      function makeObj() {
        return { value: 10 };
      }
      export function test(): number {
        let obj = makeObj();
        obj.value += 7;
        return obj.value;  // 17
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment -= on nested property access", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let data = { count: 100 };
        data.count -= 42;
        return data.count;  // 58
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound *= assignment returns new value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 3 };
        let result = (obj.x *= 4);
        return result;  // 12
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment on object passed as parameter", async () => {
    await assertEquivalent(
      `
      function addToX(obj: { x: number }, amount: number): number {
        obj.x += amount;
        return obj.x;
      }
      export function test(): number {
        let o = { x: 10 };
        return addToX(o, 5);  // 15
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
