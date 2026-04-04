import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Strict equality edge cases (#296)", () => {
  it("-0 === 0 returns true", async () => {
    await assertEquivalent(`export function test(): number { return (-0 === 0) ? 1 : 0; }`, [{ fn: "test", args: [] }]);
  });

  it("0 === -0 returns true", async () => {
    await assertEquivalent(`export function test(): number { return (0 === -0) ? 1 : 0; }`, [{ fn: "test", args: [] }]);
  });

  it("NaN === NaN returns false", async () => {
    await assertEquivalent(`export function test(): number { return (NaN === NaN) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("NaN !== NaN returns true", async () => {
    await assertEquivalent(`export function test(): number { return (NaN !== NaN) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("-0 !== 0 returns false", async () => {
    await assertEquivalent(`export function test(): number { return (-0 !== 0) ? 1 : 0; }`, [{ fn: "test", args: [] }]);
  });

  it("NaN equality in conditional", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x: number = NaN;
        if (x === x) return 1;
        return 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("-0 equality in conditional", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x: number = -0;
        const y: number = 0;
        if (x === y) return 1;
        return 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("-0 strict not-equals", async () => {
    await assertEquivalent(
      `export function test(): number {
        const x: number = -0;
        const y: number = 0;
        if (x !== y) return 1;
        return 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
