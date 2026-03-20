import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #677: Property descriptor writable enforcement", () => {
  it("Object.defineProperty with writable:false prevents assignment (throws)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10 };
        Object.defineProperty(obj, "x", { value: 42, writable: false });
        try {
          obj.x = 99;
          return -1; // should not reach here
        } catch (e) {
          return 42; // caught the TypeError
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperty with writable:true allows assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10 };
        Object.defineProperty(obj, "x", { value: 42, writable: true });
        obj.x = 99;
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperty without writable allows assignment (default)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10 };
        Object.defineProperty(obj, "x", { value: 42 });
        obj.x = 99;
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("reading a non-writable property still works", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10 };
        Object.defineProperty(obj, "x", { value: 42, writable: false });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
