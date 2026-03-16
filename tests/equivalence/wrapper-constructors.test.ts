import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("wrapper constructors", () => {
  it("new Number(42) returns numeric value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var n = new Number(42);
        return n.valueOf();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Number(0) defaults to zero", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var n = new Number(0);
        return n + 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Number(42) in arithmetic", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var n = new Number(42);
        return n + 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new String('abc') returns string value", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var s = new String("abc");
        return s.valueOf();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new String('x') + 'y' concatenation", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        var s = new String("x");
        return s + "y";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Boolean(true) returns boolean value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var b = new Boolean(true);
        return b.valueOf() ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Boolean(false) is falsy", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var b = new Boolean(false);
        return b.valueOf() ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Number().valueOf() defaults to 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return new Number().valueOf();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
