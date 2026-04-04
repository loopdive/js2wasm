import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Math constants (#939)", () => {
  it("Math.PI floor(PI * 1000) = 3141", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.PI * 1000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.E floor(E * 1000) = 2718", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.E * 1000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.LN2 floor(LN2 * 10000) = 6931", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.LN2 * 10000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.LN10 floor(LN10 * 10000) = 23025", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.LN10 * 10000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.SQRT2 floor(SQRT2 * 10000) = 14142", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.SQRT2 * 10000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.SQRT1_2 floor(SQRT1_2 * 10000) = 7071", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.SQRT1_2 * 10000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.LOG2E floor(LOG2E * 10000) = 14426", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.LOG2E * 10000); }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Math.LOG10E floor(LOG10E * 10000) = 4342", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(Math.LOG10E * 10000); }`, [
      { fn: "test", args: [] },
    ]);
  });
});
