import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #202: Variable scope and hoisting", () => {
  it("var used before declaration", async () => {
    await assertEquivalent(
      `export function test(): number { x = 5; var x; return x; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in if-block accessible outside", async () => {
    await assertEquivalent(
      `export function test(): number { if (true) { var x = 42; } return x; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in for-loop accessible after loop", async () => {
    await assertEquivalent(
      `export function test(): number { for (var i = 0; i < 5; i++) {} return i; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var hoisted with default value (undefined -> 0 for f64)", async () => {
    await assertEquivalent(
      `export function test(): number { var x; return x || 0; }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in nested blocks accessible at function scope", async () => {
    await assertEquivalent(
      `export function test(): number {
        var result = 0;
        if (true) {
          if (true) {
            var x = 10;
          }
        }
        result = x;
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in while loop accessible after", async () => {
    await assertEquivalent(
      `export function test(): number {
        var i = 0;
        while (i < 3) {
          var x = i;
          i++;
        }
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in switch case accessible after", async () => {
    await assertEquivalent(
      `export function test(): number {
        var n = 1;
        switch (n) {
          case 1: var x = 42; break;
          case 2: var y = 99; break;
        }
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple var declarations in different branches", async () => {
    await assertEquivalent(
      `export function test(n: number): number {
        if (n > 0) {
          var a = 1;
        } else {
          var b = 2;
        }
        return (a || 0) + (b || 0);
      }`,
      [
        { fn: "test", args: [1] },
        { fn: "test", args: [-1] },
      ],
    );
  });

  it("var in do-while loop", async () => {
    await assertEquivalent(
      `export function test(): number {
        var count = 0;
        do {
          var x = count;
          count++;
        } while (count < 3);
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var in labeled statement", async () => {
    await assertEquivalent(
      `export function test(): number {
        outer: {
          var x = 42;
          break outer;
        }
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var re-declaration (same name in different blocks)", async () => {
    await assertEquivalent(
      `export function test(): number {
        var x = 1;
        if (true) {
          var x = 2;
        }
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("var assignment before declaration in nested scope", async () => {
    await assertEquivalent(
      `export function test(): number {
        x = 10;
        if (true) {
          var x = 20;
        }
        return x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
