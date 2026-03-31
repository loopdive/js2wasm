import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./helpers.js";

describe("String relational operators (#214)", () => {
  it("string < string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "apple";
        const b: string = "banana";
        return (a < b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string > string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "banana";
        const b: string = "apple";
        return (a > b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string <= string (equal)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "hello";
        const b: string = "hello";
        return (a <= b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string >= string (greater)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "xyz";
        const b: string = "abc";
        return (a >= b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string comparison with prefix", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "abc";
        const b: string = "abcd";
        return (a < b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string comparison - not less than", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "banana";
        const b: string = "apple";
        return (a < b) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
