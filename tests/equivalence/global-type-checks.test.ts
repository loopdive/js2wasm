import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("global isNaN() (#941)", () => {
  it("isNaN(NaN) returns true (1)", async () => {
    await assertEquivalent(`export function test(): number { return isNaN(NaN) ? 1 : 0; }`, [{ fn: "test", args: [] }]);
  });

  it("isNaN(42) returns false (0)", async () => {
    await assertEquivalent(`export function test(): number { return isNaN(42) ? 1 : 0; }`, [{ fn: "test", args: [] }]);
  });

  it("isNaN(0) returns false (0)", async () => {
    await assertEquivalent(`export function test(): number { return isNaN(0) ? 1 : 0; }`, [{ fn: "test", args: [] }]);
  });

  it("isNaN(Infinity) returns false (0)", async () => {
    await assertEquivalent(`export function test(): number { return isNaN(Infinity) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });
});

describe("global isFinite() (#941)", () => {
  it("isFinite(42) returns true (1)", async () => {
    await assertEquivalent(`export function test(): number { return isFinite(42) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("isFinite(Infinity) returns false (0)", async () => {
    await assertEquivalent(`export function test(): number { return isFinite(Infinity) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("isFinite(-Infinity) returns false (0)", async () => {
    await assertEquivalent(`export function test(): number { return isFinite(-Infinity) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("isFinite(NaN) returns false (0)", async () => {
    await assertEquivalent(`export function test(): number { return isFinite(NaN) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("isFinite(0) returns true (1)", async () => {
    await assertEquivalent(`export function test(): number { return isFinite(0) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });
});
