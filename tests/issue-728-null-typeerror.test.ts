import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #728: Null dereference should throw TypeError, not trap", () => {
  it("element access on null array throws (caught by try/catch)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const arr: number[] | null = null;
          const x = arr![0];
          return 0; // should not reach
        } catch (e) {
          return 1; // caught TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("property access on null struct throws (caught by try/catch)", async () => {
    await assertEquivalent(
      `
      interface Obj { x: number }
      export function test(): number {
        try {
          const obj: Obj | null = null;
          const x = obj!.x;
          return 0; // should not reach
        } catch (e) {
          return 1; // caught TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("destructuring null throws (caught by try/catch)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        try {
          const obj: any = null;
          const { a } = obj;
          return 0; // should not reach
        } catch (e) {
          return 1; // caught TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("valid object property access still works", async () => {
    await assertEquivalent(
      `
      interface Obj { x: number }
      export function test(): number {
        const obj: Obj | null = { x: 42 };
        return obj!.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
