import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

/**
 * #1048 — boxed-capture function called from nested fn emitted illegal cast.
 *
 * When a `var`-declared function variable is captured by a nested closure,
 * the captured local is a ref cell. compileClosureCall previously only
 * unwrapped externref locals, so it emitted a direct `ref.cast` on the ref
 * cell, trapping as "illegal cast". Fix unwraps the ref cell via
 * `struct.get $value` before coercing the externref to the closure struct.
 */
describe("issue-1048 — boxed capture called as closure", () => {
  it("plain var-captured function called from nested fn", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var f: (n: number) => number;
        f = function(n: number): number { return n + 1; };
        function outer(): number { return f(41); }
        return outer();
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var-captured function called from nested fn with multiple captures", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var f: (n: number) => number;
        var k = 10;
        f = function(n: number): number { return n * k; };
        function outer(): number { return f(5); }
        return outer();
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var-captured function reassigned mid-scope still calls through ref cell", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var f: () => number;
        f = function(): number { return 1; };
        function callF(): number { return f(); }
        const a = callF();
        f = function(): number { return 2; };
        const b = callF();
        return a + b;
      }
    `,
      [{ fn: "test", args: [] }],
    );
  });
});
