import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Number static methods (#938)", () => {
  it("Number.isNaN(NaN) returns true", async () => {
    await assertEquivalent(`export function test(): number { return Number.isNaN(NaN) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isNaN(42) returns false", async () => {
    await assertEquivalent(`export function test(): number { return Number.isNaN(42) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isFinite(42) returns true", async () => {
    await assertEquivalent(`export function test(): number { return Number.isFinite(42) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isFinite(Infinity) returns false", async () => {
    await assertEquivalent(`export function test(): number { return Number.isFinite(Infinity) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isFinite(NaN) returns false", async () => {
    await assertEquivalent(`export function test(): number { return Number.isFinite(NaN) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isInteger(5) returns true", async () => {
    await assertEquivalent(`export function test(): number { return Number.isInteger(5) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isInteger(5.5) returns false", async () => {
    await assertEquivalent(`export function test(): number { return Number.isInteger(5.5) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isSafeInteger(42) returns true", async () => {
    await assertEquivalent(`export function test(): number { return Number.isSafeInteger(42) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.isSafeInteger(2**53) returns false", async () => {
    await assertEquivalent(`export function test(): number { return Number.isSafeInteger(Math.pow(2, 53)) ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.EPSILON is positive", async () => {
    await assertEquivalent(`export function test(): number { return Number.EPSILON > 0 ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });

  it("Number.MAX_SAFE_INTEGER equals 2^53 - 1", async () => {
    await assertEquivalent(
      `export function test(): number { return Number.MAX_SAFE_INTEGER === Math.pow(2, 53) - 1 ? 1 : 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("Number.POSITIVE_INFINITY equals Infinity", async () => {
    await assertEquivalent(`export function test(): number { return Number.POSITIVE_INFINITY === Infinity ? 1 : 0; }`, [
      { fn: "test", args: [] },
    ]);
  });
});
