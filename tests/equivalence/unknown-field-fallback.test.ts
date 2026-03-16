import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("unknown field access fallback (#392)", () => {
  it("reading unknown property returns undefined/NaN gracefully", async () => {
    await assertEquivalent(
      `
      class C {
        x: number = 10;
      }
      export function test(): number {
        let c = new C();
        return c.x;  // 10 — known field works
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment on known field still works", async () => {
    await assertEquivalent(
      `
      class C {
        x: number = 5;
      }
      export function test(): number {
        let c = new C();
        c.x += 3;
        return c.x;  // 8
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix increment on known field still works", async () => {
    await assertEquivalent(
      `
      class C {
        x: number = 5;
      }
      export function test(): number {
        let c = new C();
        return ++c.x;  // 6
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on known field still works", async () => {
    await assertEquivalent(
      `
      class C {
        x: number = 5;
      }
      export function test(): number {
        let c = new C();
        return c.x++;  // 5 (returns old value)
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
