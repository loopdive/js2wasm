import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Switch fallthrough", () => {
  it("fallthrough: case 1 falls through to case 2", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (1) {
          case 1: x += 10;
          case 2: x += 20; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(30);
  });
  it("no fallthrough with break", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (1) {
          case 1: x = 10; break;
          case 2: x = 20; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(10);
  });
  it("multiple cases sharing body", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (2) {
          case 1:
          case 2: x = 42; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(42);
  });
  it("default fallthrough (no match)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (99) {
          case 1: x += 10; break;
          default: x += 5;
          case 2: x += 20; break;
        }
        return x;
      }
    `);
    expect(exports.test()).toBe(25);
  });
  it("default in middle, later case matches", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (2) {
          case 1: x += 10; break;
          default: x += 5;
          case 2: x += 20; break;
        }
        return x;
      }
    `);
    // case 2 matches, so only case 2 body runs (not default)
    expect(exports.test()).toBe(20);
  });
  it("default first, later case matches", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (3) {
          default: x += 1;
          case 2: x += 2;
          case 3: x += 4; break;
        }
        return x;
      }
    `);
    // case 3 matches, only case 3 body runs
    expect(exports.test()).toBe(4);
  });
  it("default first, no match falls through all", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 0;
        switch (99) {
          default: x += 1;
          case 2: x += 2;
          case 3: x += 4;
        }
        return x;
      }
    `);
    // No match: default reached, falls through case 2 and case 3
    expect(exports.test()).toBe(7);
  });
});

describe("String and ternary operations", () => {
  it("string concatenation with variables", async () => {
    await assertEquivalent(
      `
      export function greetFull(first: string, last: string): string {
        return first + " " + last;
      }
      `,
      [
        { fn: "greetFull", args: ["Jane", "Doe"] },
        { fn: "greetFull", args: ["", "Solo"] },
        { fn: "greetFull", args: ["One", ""] },
      ],
    );
  });
  it("string += compound assignment", async () => {
    await assertEquivalent(
      `
      export function buildGreeting(name: string): string {
        let result: string = "Hello";
        result += ", ";
        result += name;
        result += "!";
        return result;
      }
      `,
      [
        { fn: "buildGreeting", args: ["World"] },
        { fn: "buildGreeting", args: ["Alice"] },
      ],
    );
  });
  it("multi-variable string concat chain", async () => {
    await assertEquivalent(
      `
      export function join3(a: string, b: string, c: string): string {
        return a + b + c;
      }
      `,
      [
        { fn: "join3", args: ["x", "y", "z"] },
        { fn: "join3", args: ["hello", " ", "world"] },
        { fn: "join3", args: ["", "", ""] },
      ],
    );
  });
  it("ternary with non-boolean return values", async () => {
    await assertEquivalent(
      `
      export function pickNum(flag: boolean): number {
        return flag ? 10 : 20;
      }
      export function pickNested(x: number): number {
        return x > 0 ? 100 : x < 0 ? -100 : 0;
      }
      export function ternaryMath(a: number, b: number): number {
        return a > b ? a - b : b - a;
      }
      `,
      [
        { fn: "pickNum", args: [true] },
        { fn: "pickNum", args: [false] },
        { fn: "pickNested", args: [5] },
        { fn: "pickNested", args: [-3] },
        { fn: "pickNested", args: [0] },
        { fn: "ternaryMath", args: [10, 3] },
        { fn: "ternaryMath", args: [3, 10] },
      ],
    );
  });
});
