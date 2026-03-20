import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("for-of assignment destructuring on primitives (#336)", () => {
  it("empty object destructuring assignment over boolean array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var counter = 0;
        for ({} of [false]) {
          counter += 1;
        }
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("empty object destructuring assignment over number array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var counter = 0;
        for ({} of [0]) {
          counter += 1;
        }
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring assignment: for ([x] of [[0]])", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = -1;
        for ([x] of [[0]]) {
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array destructuring assignment with multiple elements", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var a: number = 0;
        var b: number = 0;
        for ([a, b] of [[10, 20]]) {
        }
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested obj in array assignment: for ([{ x }] of [[{ x: 2 }]])", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        for ([{ x }] of [[{ x: 2 }]]) {
        }
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring assignment with property extraction", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var a: number = 0;
        var counter = 0;
        for ({ a } of [{ a: 10 }, { a: 20 }]) {
          counter += a;
        }
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring assignment with default value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var x: number = 0;
        var counter = 0;
        for ({ x = 42 } of [{}]) {
          counter += x;
        }
        return counter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
