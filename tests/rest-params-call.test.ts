import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Rest parameters with .call() and .apply()", () => {
  it("rest param function called via .call(null) with no extra args", async () => {
    await assertEquivalent(
      `
      function af(...a: number[]): number {
        return a.length;
      }
      export function test(): number {
        return af.call(null);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest param function called via .call(null, 1)", async () => {
    await assertEquivalent(
      `
      function af(...a: number[]): number {
        return a.length;
      }
      export function test(): number {
        return af.call(null, 1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("rest param function called via .call(null, 1, 2)", async () => {
    await assertEquivalent(
      `
      function af(...a: number[]): number {
        return a.length;
      }
      export function test(): number {
        return af.call(null, 1, 2);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string.slice with void argument (IIFE returning undefined)", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "report".slice((() => {})() as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
