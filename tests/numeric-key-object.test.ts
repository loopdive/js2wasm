import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("object literals with numeric keys", () => {
  it("numeric key access via bracket notation", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj: {0: string, 1: string} = {0: "hello", 1: "world"};
        return obj[0] + obj[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric key with length property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: {0: string, 1: string, length: number} = {0: "a", 1: "b", length: 2};
        return obj.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
