import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object-to-primitive coercion (#327)", () => {
  it("prefix ++ on any-typed plain object gives NaN", async () => {
    await assertEquivalent(
      `
      var x: any = {};
      ++x;
      export function test(): number {
        return isNaN(x) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix ++ on any-typed plain object gives NaN", async () => {
    await assertEquivalent(
      `
      var x: any = {};
      x++;
      export function test(): number {
        return isNaN(x) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix -- on any-typed plain object gives NaN", async () => {
    await assertEquivalent(
      `
      var x: any = {};
      --x;
      export function test(): number {
        return isNaN(x) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix -- on any-typed plain object gives NaN", async () => {
    await assertEquivalent(
      `
      var x: any = {};
      x--;
      export function test(): number {
        return isNaN(x) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix ++ on any-typed number gives incremented value", async () => {
    await assertEquivalent(
      `
      var x: any = 5;
      ++x;
      export function test(): number {
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix ++ on any-typed number returns old value", async () => {
    await assertEquivalent(
      `
      var x: any = 5;
      var y: any = x++;
      export function test(): number {
        return y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
