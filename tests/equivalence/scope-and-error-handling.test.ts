import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Scope and error handling (#180, #196, #197)", () => {
  it("var re-declaration with different types (#180)", async () => {
    await assertEquivalent(
      `
      var x: number = 1;
      var y: number = x + 10;
      export function test(): number {
        return y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration inside if-branch (#197)", async () => {
    await assertEquivalent(
      `
      function makeF(): number {
        if (true) {
          function inner(): number { return 42; }
          return inner();
        }
        return 0;
      }
      export function test(): number {
        return makeF();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration in else-branch (#197)", async () => {
    await assertEquivalent(
      `
      function makeF(cond: boolean): number {
        if (cond) {
          return 1;
        } else {
          function inner(): number { return 99; }
          return inner();
        }
      }
      export function test(): number {
        return makeF(false);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration inside try block (#196)", async () => {
    await assertEquivalent(
      `
      function wrapper(): number {
        try {
          function helper(): number { return 7; }
          return helper();
        } catch (e) {
          return -1;
        }
      }
      export function test(): number {
        return wrapper();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("try-catch with catch variable (#196)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var result: number = 0;
        try {
          result = 1;
        } catch (e) {
          result = -1;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
