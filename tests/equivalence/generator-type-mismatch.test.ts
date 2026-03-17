import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("generator type mismatch fixes (#422)", () => {
  it("generator with return value expression", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 1;
        yield 2;
        return 42;
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

  it("generator with mixed yield and return types", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 10;
        if (true) {
          return;
        }
        yield 20;
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

  it("generator called multiple times produces separate iterators", async () => {
    await assertEquivalent(
      `function* counter(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      export function test(): number {
        var sum1: number = 0;
        for (const x of counter()) {
          sum1 = sum1 + x;
        }
        var sum2: number = 0;
        for (const x of counter()) {
          sum2 = sum2 + x;
        }
        return sum1 + sum2;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator expression assigned to variable", async () => {
    await assertEquivalent(
      `export function test(): number {
        var gen = function*(): Generator<number> {
          yield 5;
          yield 10;
        };
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested generator with closure capture and yield", async () => {
    await assertEquivalent(
      `export function test(): number {
        var base: number = 100;
        function* gen(): Generator<number> {
          yield base + 1;
          yield base + 2;
        }
        var sum: number = 0;
        for (const x of gen()) {
          sum = sum + x;
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator yielding string values", async () => {
    await assertEquivalent(
      `function* words(): Generator<string> {
        yield "hello";
        yield " ";
        yield "world";
      }
      export function test(): string {
        var result: string = "";
        for (const w of words()) {
          result = result + w;
        }
        return result;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator with conditional yield and fall-through", async () => {
    await assertEquivalent(
      `function* gen(n: number): Generator<number> {
        if (n > 0) {
          yield n;
          yield n * 2;
        }
        yield 0;
      }
      export function testPositive(): number {
        var sum: number = 0;
        for (const x of gen(5)) {
          sum = sum + x;
        }
        return sum;
      }
      export function testZero(): number {
        var sum: number = 0;
        for (const x of gen(0)) {
          sum = sum + x;
        }
        return sum;
      }`,
      [
        { fn: "testPositive", args: [] },
        { fn: "testZero", args: [] },
      ],
    );
  });

  it("function with optional ref param using default", async () => {
    await assertEquivalent(
      `function f(x: number = 42): number {
        return x;
      }
      export function testDefault(): number {
        return f();
      }
      export function testProvided(): number {
        return f(7);
      }`,
      [
        { fn: "testDefault", args: [] },
        { fn: "testProvided", args: [] },
      ],
    );
  });
});
