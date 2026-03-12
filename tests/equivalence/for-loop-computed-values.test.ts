import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("for-loop computed values", () => {
  it("continue skips string concatenation", async () => {
    await assertEquivalent(
      `export function test(): string {
        let str = "";
        for (let index = 0; index < 10; index += 1) {
          if (index < 5) continue;
          str += index;
        }
        return str;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("break stops string concatenation", async () => {
    await assertEquivalent(
      `export function test(): string {
        let str = "";
        for (let index = 0; index < 10; index += 1) {
          if (index > 5) break;
          str += index;
        }
        return str;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for loop with number accumulation", async () => {
    await assertEquivalent(
      `export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          sum += i;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for loop with continue and number accumulation", async () => {
    await assertEquivalent(
      `export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          if (i % 2 === 0) continue;
          sum += i;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for loop with break and number accumulation", async () => {
    await assertEquivalent(
      `export function test(): number {
        let sum = 0;
        for (let i = 0; i < 10; i++) {
          if (i > 5) break;
          sum += i;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested for loops with continue", async () => {
    await assertEquivalent(
      `export function test(): string {
        let str = "";
        for (let i = 0; i < 4; i += 1) {
          for (let j = 0; j <= i; j++) {
            if (i * j === 6) continue;
            str += "" + i + j;
          }
        }
        return str;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for loop incrementor runs after continue", async () => {
    await assertEquivalent(
      `export function test(): number {
        let count = 0;
        for (let i = 0; i < 5; i++) {
          if (i === 2) continue;
          count++;
        }
        return count;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var-declared loop variable", async () => {
    await assertEquivalent(
      `export function test(): number {
        var sum = 0;
        for (var i = 0; i < 10; i += 1) {
          if (i < 5) continue;
          sum += i;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
