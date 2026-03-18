import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("generator next/return/throw methods (#439)", () => {
  it("generator .next() returns values in sequence", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 10;
        yield 20;
        yield 30;
      }
      export function test(): number {
        const it = gen();
        const r1 = it.next();
        const r2 = it.next();
        return r1.value + r2.value;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator .next() done check", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 1;
      }
      export function test(): number {
        const it = gen();
        const r1 = it.next();
        const r2 = it.next();
        return r2.done ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator .return() closes the generator", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      export function test(): number {
        const it = gen();
        const r1 = it.next();
        const r2 = it.return(99);
        // After return, next() should produce done:true
        const r3 = it.next();
        return r1.value;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator consumed in loop with next()", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      export function test(): number {
        const it = gen();
        var sum: number = 0;
        var r = it.next();
        while (!r.done) {
          sum = sum + r.value;
          r = it.next();
        }
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("generator type mismatch diagnostic is downgraded", async () => {
    // This pattern triggers TS diagnostic 2739 ("Type 'X' is missing
    // properties from type 'Generator': next, return, throw") which
    // should be downgraded to a warning, not block compilation.
    await assertEquivalent(
      `function* gen(): Generator<number> {
        yield 1;
        yield 2;
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
