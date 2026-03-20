import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("generator function expressions and methods", () => {
  it("generator function expression with yield", async () => {
    await assertEquivalent(
      `const gen = function*(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      };
      export function test(): number {
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator function expression with yield in loop", async () => {
    await assertEquivalent(
      `const range = function*(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          yield i;
        }
      };
      export function test(): number {
        var sum: number = 0;
        for (const x of range(5)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator declaration with yield in for-loop", async () => {
    await assertEquivalent(
      `function* range(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          yield i;
        }
      }
      export function test(): number {
        var sum: number = 0;
        for (const x of range(4)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator with yield in nested for-loops", async () => {
    await assertEquivalent(
      `function* pairs(): Generator<number> {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 2; j++) {
            yield i * 10 + j;
          }
        }
      }
      export function test(): number {
        var sum: number = 0;
        for (const x of pairs()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator with yield in while-loop", async () => {
    await assertEquivalent(
      `function* countdown(n: number): Generator<number> {
        let i: number = n;
        while (i > 0) {
          yield i;
          i = i - 1;
        }
      }
      export function test(): number {
        var sum: number = 0;
        for (const x of countdown(4)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator with yield in do-while loop", async () => {
    await assertEquivalent(
      `function* gen(n: number): Generator<number> {
        let i: number = 0;
        do {
          yield i;
          i = i + 1;
        } while (i < n);
      }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen(3)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator with yield in if/else", async () => {
    await assertEquivalent(
      `function* gen(flag: boolean): Generator<number> {
        if (flag) {
          yield 10;
        } else {
          yield 20;
        }
        yield 30;
      }
      export function testTrue(): number {
        var sum: number = 0;
        for (const x of gen(true)) {
          sum = sum + x;
        }
        return sum;
      }
      export function testFalse(): number {
        var sum: number = 0;
        for (const x of gen(false)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [
        { fn: "testTrue", args: [] },
        { fn: "testFalse", args: [] },
      ],
    );
  });

  it("generator with early return", async () => {
    await assertEquivalent(
      `function* gen(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          yield i;
          if (i >= 2) {
            return;
          }
        }
      }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen(10)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator with try-catch yield", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        try {
          yield 1;
          yield 2;
        } catch (e) {
          yield 99;
        }
        yield 3;
      }
      export function test(): number {
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
