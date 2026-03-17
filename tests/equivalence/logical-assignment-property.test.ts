import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("logical assignment on property access (#415)", () => {
  it("obj.x ??= default when x is defined", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 10 };
        obj.x ??= 99;
        return obj.x;  // 10
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x ||= default when x is falsy (0)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 0 };
        obj.x ||= 42;
        return obj.x;  // 42
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x ||= default when x is truthy", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        obj.x ||= 42;
        return obj.x;  // 5
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x &&= value when x is truthy", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 5 };
        obj.x &&= 99;
        return obj.x;  // 99
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("obj.x &&= value when x is falsy (0)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 0 };
        obj.x &&= 99;
        return obj.x;  // 0
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("logical assignment returns result value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { x: 0 };
        let result = (obj.x ||= 77);
        return result;  // 77
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained logical assignment on different properties", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let obj = { a: 0, b: 10 };
        obj.a ||= 1;
        obj.b &&= 20;
        return obj.a + obj.b;  // 1 + 20 = 21
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("logical assignment on function return value property", async () => {
    await assertEquivalent(
      `
      function makeObj() {
        return { value: 0 };
      }
      export function test(): number {
        let obj = makeObj();
        obj.value ||= 55;
        return obj.value;  // 55
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
