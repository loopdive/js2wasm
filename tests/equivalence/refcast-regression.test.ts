import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

/**
 * Regression test for the #706/#695 interaction.
 * When emitGuardedRefCast returns ref.null for a valid-but-wrong-type object,
 * property access should fall back to __extern_get instead of returning 0.
 */
describe("ref.cast regression: wrong struct type fallback", () => {
  it("property access on class instance with numeric fields", async () => {
    await assertEquivalent(
      `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      const p = new Point(3, 4);
      export function getX(): number { return p.x; }
      export function getY(): number { return p.y; }
      `,
      [
        { fn: "getX", args: [] },
        { fn: "getY", args: [] },
      ],
    );
  });

  it("property access on object literal with numeric fields", async () => {
    await assertEquivalent(
      `
      const obj = { a: 10, b: 20 };
      export function getA(): number { return obj.a; }
      export function getB(): number { return obj.b; }
      `,
      [
        { fn: "getA", args: [] },
        { fn: "getB", args: [] },
      ],
    );
  });

  it("property access on function return value", async () => {
    await assertEquivalent(
      `
      function makeObj() { return { val: 42 }; }
      export function test(): number {
        const o = makeObj();
        return o.val;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
