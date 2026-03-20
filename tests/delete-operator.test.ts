import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("delete operator (#474)", () => {
  it("delete on object property returns truthy", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { a?: number } = { a: 1 };
        const result = delete obj.a;
        return result ? "yes" : "no";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete result used in condition", async () => {
    await assertEquivalent(
      `export function test(): string {
        const obj: { a?: number } = { a: 1 };
        if (delete obj.a) {
          return "deleted";
        }
        return "not deleted";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete on array element returns truthy", async () => {
    await assertEquivalent(
      `export function test(): string {
        const arr = [1, 2, 3];
        const result = delete arr[0];
        return result ? "yes" : "no";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("delete as expression value", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj: { x?: number } = { x: 10 };
        return (delete obj.x) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
