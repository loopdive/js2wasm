import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Math built-in methods (#936)", () => {
  it("Math.abs(-42) returns 42", async () => {
    await assertEquivalent(`export function test(): number { return Math.abs(-42); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.ceil(1.1) returns 2", async () => {
    await assertEquivalent(`export function test(): number { return Math.ceil(1.1); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.floor(1.9) returns 1", async () => {
    await assertEquivalent(`export function test(): number { return Math.floor(1.9); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.round(1.5) returns 2", async () => {
    await assertEquivalent(`export function test(): number { return Math.round(1.5); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.trunc(1.9) returns 1", async () => {
    await assertEquivalent(`export function test(): number { return Math.trunc(1.9); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.sign(-5) returns -1", async () => {
    await assertEquivalent(`export function test(): number { return Math.sign(-5); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.sqrt(144) returns 12", async () => {
    await assertEquivalent(`export function test(): number { return Math.sqrt(144); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.clz32(1) returns 31", async () => {
    await assertEquivalent(`export function test(): number { return Math.clz32(1); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.imul(2, 3) returns 6", async () => {
    await assertEquivalent(`export function test(): number { return Math.imul(2, 3); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.min(1, 2, 3) returns 1", async () => {
    await assertEquivalent(`export function test(): number { return Math.min(1, 2, 3); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.max(1, 2, 3) returns 3", async () => {
    await assertEquivalent(`export function test(): number { return Math.max(1, 2, 3); }`, [{ fn: "test", args: [] }]);
  });

  it("Math.pow(2, 10) returns 1024", async () => {
    await assertEquivalent(`export function test(): number { return Math.pow(2, 10); }`, [{ fn: "test", args: [] }]);
  });
});
