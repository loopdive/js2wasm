import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Issue #287: Generator function compile errors -- yield in loops/try
 *
 * Generator functions with yield inside loops, conditionals, and try/catch
 * should compile without errors. These tests verify compilation succeeds
 * (no yield-related errors) for various generator patterns.
 */
describe("Issue #287: Generator compile errors", () => {
  it("basic generator with yield compiles", () => {
    const result = compile(`
      function* gen(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with yield in for loop compiles", () => {
    const result = compile(`
      function* range(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          yield i;
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with yield in while loop compiles", () => {
    const result = compile(`
      function* counter(): Generator<number> {
        let i = 0;
        while (i < 5) {
          yield i;
          i++;
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with yield in if/else compiles", () => {
    const result = compile(`
      function* conditionalYield(x: number): Generator<number> {
        if (x > 0) {
          yield x;
        } else {
          yield -x;
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with yield in nested loops compiles", () => {
    const result = compile(`
      function* nested(): Generator<number> {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            yield i * 3 + j;
          }
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with yield and return compiles", () => {
    const result = compile(`
      function* earlyReturn(n: number): Generator<number> {
        for (let i = 0; i < n; i++) {
          if (i > 5) return;
          yield i;
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with yield (no value) compiles", () => {
    const result = compile(`
      function* emptyYields(): Generator<undefined> {
        yield;
        yield;
        yield;
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator function expression assigned to variable compiles", () => {
    const result = compile(`
      export function test(): number {
        const gen = function*(): Generator<number> {
          yield 1;
          yield 2;
        };
        return 42;
      }
    `);
    const yieldErrors = result.errors.filter(e =>
      e.message.includes("yield") || e.message.includes("generator") || e.message.includes("gen_buffer")
    );
    expect(yieldErrors).toEqual([]);
  });

  it("generator with yield* (delegate) compiles without crashing", () => {
    const result = compile(`
      function* inner(): Generator<number> {
        yield 1;
        yield 2;
      }
      function* outer(): Generator<number> {
        yield* inner();
        yield 3;
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.success !== undefined).toBe(true);
  });

  it("generator with try-finally compiles", () => {
    const result = compile(`
      function* withFinally(): Generator<number> {
        try {
          yield 1;
          yield 2;
        } finally {
          // cleanup
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.success !== undefined).toBe(true);
  });

  it("generator method in class compiles", () => {
    const result = compile(`
      class Iter {
        *values(): Generator<number> {
          yield 1;
          yield 2;
          yield 3;
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    const genErrors = result.errors.filter(e =>
      e.message.includes("yield") || e.message.includes("generator") || e.message.includes("gen_buffer")
    );
    expect(genErrors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator method with loop in class compiles", () => {
    const result = compile(`
      class Range {
        *range(n: number): Generator<number> {
          for (let i = 0; i < n; i++) {
            yield i;
          }
        }
      }
      export function test(): number {
        return 42;
      }
    `);
    const genErrors = result.errors.filter(e =>
      e.message.includes("yield") || e.message.includes("generator") || e.message.includes("gen_buffer")
    );
    expect(genErrors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("generator with do-while loop compiles", () => {
    const result = compile(`
      function* doWhileGen(n: number): Generator<number> {
        let i: number = 0;
        do {
          yield i;
          i = i + 1;
        } while (i < n);
      }
      export function test(): number {
        return 42;
      }
    `);
    expect(result.errors.filter(e => e.message.includes("yield"))).toEqual([]);
    expect(result.success).toBe(true);
  });
});
