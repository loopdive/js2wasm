import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("optional direct closure call (call_ref funcref fix)", () => {
  it("fn?.() on a locally-defined closure", async () => {
    const code = `
      export function test(): number {
        const fn = (x: number): number => x * 2;
        return fn?.(5) ?? -1;
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });

  it("fn?.() on a closure that captures a variable", async () => {
    const code = `
      export function test(): number {
        let base = 100;
        const fn = (x: number): number => base + x;
        return fn?.(42) ?? -1;
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });
});
