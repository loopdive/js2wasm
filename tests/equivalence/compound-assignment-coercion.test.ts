import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("compound assignment type coercion (#283)", () => {
  it("local var += with number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 10;
        x += 5;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("local var -= with number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 20;
        x -= 7;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("local var *= with number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 6;
        x *= 7;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("local var /= with number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 42;
        x /= 6;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("local var %= with number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 17;
        x %= 5;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment with bitwise |=", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 5;
        x |= 3;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment with bitwise &=", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 15;
        x &= 9;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment with bitwise <<=", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 1;
        x <<= 3;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compound assignment with bitwise >>=", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x = 16;
        x >>= 2;
        return x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
