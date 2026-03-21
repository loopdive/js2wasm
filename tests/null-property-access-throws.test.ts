import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #695: TypeError on null/undefined property access", () => {
  it("property access on null throws (caught by try/catch returns 1)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const obj: any = null;
          obj.foo;
          return 0; // should not reach
        } catch (e) {
          return 1; // caught TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property access on undefined throws (caught by try/catch returns 1)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const obj: any = undefined;
          obj.bar;
          return 0; // should not reach
        } catch (e) {
          return 1; // caught TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property access on valid object does not throw", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const obj = { x: 42 };
          const val = obj.x;
          return val;
        } catch (e) {
          return -1; // should not reach
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function returning null - property access on result throws", async () => {
    await assertEquivalent(
      `
      function getNull(): any { return null; }
      export function test(): number {
        try {
          const obj = getNull();
          obj.foo;
          return 0; // should not reach
        } catch (e) {
          return 1; // caught TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
