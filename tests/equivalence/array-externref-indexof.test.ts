import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("array indexOf/includes with externref elements (#448)", () => {
  it("indexOf on empty array returns -1", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [];
        return arr.indexOf(42);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes on number array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        return arr.includes(2) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("includes returns false for missing element", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2, 3];
        return arr.includes(5) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("prefix increment on boolean variable", async () => {
    await assertEquivalent(
      `export function test(): number {
        var x: any = false;
        ++x;
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("postfix increment on boolean variable", async () => {
    await assertEquivalent(
      `export function test(): number {
        var x: any = true;
        var old = x++;
        return old;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
