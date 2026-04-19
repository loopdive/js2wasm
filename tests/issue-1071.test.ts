/**
 * Issue #1071: for-of over non-array iterables (Map/Set/generator)
 *
 * Tests that for-of compiles successfully for Map, Set, and generator iterables,
 * not just T[] arrays.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

function expectCompileSuccess(source: string, description: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    const msgs = result.errors.map((e) => e.message).join("; ");
    expect.fail(`Should compile: ${description} — errors: ${msgs}`);
  }
}

function expectNoForOfError(source: string, description: string) {
  const result = compile(source, { fileName: "test.ts" });
  const forOfErrors = result.errors?.filter(
    (e) => e.message.includes("for-of requires an array") || e.message.includes("for-of on non-array"),
  );
  expect(forOfErrors?.length ?? 0, `No for-of errors: ${description}`).toBe(0);
}

describe("Issue #1071: for-of over non-array iterables", () => {
  it("compiles for-of over Map", () => {
    expectNoForOfError(
      `
      function test(): number {
        const m = new Map<string, number>();
        let sum = 0;
        for (const [k, v] of m) {
          sum += v;
        }
        return sum;
      }
      `,
      "for-of over Map",
    );
  });

  it("compiles for-of over Set", () => {
    expectNoForOfError(
      `
      function test(): number {
        const s = new Set<number>();
        let sum = 0;
        for (const v of s) {
          sum += v;
        }
        return sum;
      }
      `,
      "for-of over Set",
    );
  });

  it("compiles for-of over Map.entries()", () => {
    expectNoForOfError(
      `
      function test(): number {
        const m = new Map<string, number>();
        let sum = 0;
        for (const [k, v] of m.entries()) {
          sum += v;
        }
        return sum;
      }
      `,
      "for-of over Map.entries()",
    );
  });

  it("compiles for-of over generator function", () => {
    expectNoForOfError(
      `
      function* gen(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      function test(): number {
        let sum = 0;
        for (const v of gen()) {
          sum += v;
        }
        return sum;
      }
      `,
      "for-of over generator",
    );
  });

  it("still compiles for-of over arrays", () => {
    expectCompileSuccess(
      `
      function test(): number {
        const arr = [1, 2, 3];
        let sum = 0;
        for (const v of arr) {
          sum += v;
        }
        return sum;
      }
      `,
      "for-of over array (regression check)",
    );
  });

  it("still compiles for-of over strings", () => {
    expectNoForOfError(
      `
      function test(): number {
        let count = 0;
        for (const c of "hello") {
          count++;
        }
        return count;
      }
      `,
      "for-of over string (regression check)",
    );
  });
});
