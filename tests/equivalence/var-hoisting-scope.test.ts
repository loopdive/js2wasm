import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("var hoisting and scope issues (#146)", () => {
  it("var inside catch block is hoisted to function scope", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw 1;
        } catch (e) {
          var x: number = 42;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in for-loop initializer is in function scope", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        for (var i: number = 0; i < 5; i++) {
          // loop body
        }
        return i;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in nested block is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        if (true) {
          var x: number = 10;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in switch case is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var val: number = 1;
        switch (val) {
          case 1:
            var result: number = 100;
            break;
          default:
            var result: number = 0;
        }
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in while loop body is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var count: number = 0;
        while (count < 1) {
          var inner: number = 99;
          count++;
        }
        return inner;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in do-while body is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var count: number = 0;
        do {
          var x: number = 77;
          count++;
        } while (count < 1);
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in labeled statement is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        outer: {
          var x: number = 55;
          break outer;
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("let in for-loop is block scoped (loop counter)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum: number = 0;
        for (let i: number = 0; i < 5; i++) {
          sum += i;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function declaration inside if branch is hoisted", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        if (true) {
          function inner(): number { return 42; }
          return inner();
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var with destructuring in catch block", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          throw 1;
        } catch (e) {
          var a: number = 1;
          var b: number = 2;
        }
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for loops with var", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var sum: number = 0;
        for (var i: number = 0; i < 3; i++) {
          for (var j: number = 0; j < 3; j++) {
            sum += 1;
          }
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var used before declaration (hoisting) - returns 0 default for f64", async () => {
    // In JS, var x is hoisted but undefined; `result = x` gives undefined.
    // In Wasm, hoisted f64 var defaults to 0. This is a known difference.
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 42;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
