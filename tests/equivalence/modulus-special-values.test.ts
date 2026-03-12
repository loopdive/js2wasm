import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Modulus with special values (#216)", () => {
  it("x % Infinity should be x (finite x)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 5 % Infinity;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("x % -Infinity should be x (finite x)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 5 % -Infinity;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Infinity % x should be NaN", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return Infinity % 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("x % 0 should be NaN", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 5 % 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("basic modulo still works", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 7 % 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("negative modulo", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return -7 % 3;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
