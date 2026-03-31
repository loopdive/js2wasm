import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Helper to compile and run a generator test with the standard runtime imports
async function compileAndRun(source: string): Promise<{
  exports: Record<string, Function>;
  instance: WebAssembly.Instance;
}> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return { exports: instance.exports as any, instance };
}

describe("generators", () => {
  it("simple generator that yields numbers", async () => {
    const { exports } = await compileAndRun(`
      export function* count(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
    `);

    const gen = (exports.count as Function)();
    const r1 = gen.next();
    expect(r1.value).toBe(1);
    expect(r1.done).toBe(false);

    const r2 = gen.next();
    expect(r2.value).toBe(2);
    expect(r2.done).toBe(false);

    const r3 = gen.next();
    expect(r3.value).toBe(3);
    expect(r3.done).toBe(false);

    const r4 = gen.next();
    expect(r4.value).toBeUndefined();
    expect(r4.done).toBe(true);
  }, 30000);

  it("generator with a for loop and yield", async () => {
    const { exports } = await compileAndRun(`
      export function* range(start: number, end: number): Generator<number> {
        for (let i = start; i <= end; i++) {
          yield i;
        }
      }
    `);

    const gen = (exports.range as Function)(1, 5);
    const values: number[] = [];
    let result = gen.next();
    while (!result.done) {
      values.push(result.value);
      result = gen.next();
    }
    expect(values).toEqual([1, 2, 3, 4, 5]);
  }, 30000);

  it("calling .next() on a generator from wasm", async () => {
    const { exports } = await compileAndRun(`
      function* nums(): Generator<number> {
        yield 10;
        yield 20;
      }

      export function getFirst(): number {
        const gen = nums();
        const result = gen.next();
        return result.value;
      }
    `);

    expect((exports.getFirst as Function)()).toBe(10);
  }, 30000);

  it("generator with while loop", async () => {
    const { exports } = await compileAndRun(`
      export function* countdown(n: number): Generator<number> {
        let i = n;
        while (i > 0) {
          yield i;
          i = i - 1;
        }
      }
    `);

    const gen = (exports.countdown as Function)(3);
    const values: number[] = [];
    let result = gen.next();
    while (!result.done) {
      values.push(result.value);
      result = gen.next();
    }
    expect(values).toEqual([3, 2, 1]);
  }, 30000);

  it("generator with conditional yield", async () => {
    const { exports } = await compileAndRun(`
      export function* evens(limit: number): Generator<number> {
        for (let i = 0; i <= limit; i++) {
          if (i % 2 === 0) {
            yield i;
          }
        }
      }
    `);

    const gen = (exports.evens as Function)(8);
    const values: number[] = [];
    let result = gen.next();
    while (!result.done) {
      values.push(result.value);
      result = gen.next();
    }
    expect(values).toEqual([0, 2, 4, 6, 8]);
  }, 30000);

  it("generator with no yields produces empty iterator", async () => {
    const { exports } = await compileAndRun(`
      export function* empty(): Generator<number> {
      }
    `);

    const gen = (exports.empty as Function)();
    const result = gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  }, 30000);

  it("generator with parameters used in yield expressions", async () => {
    const { exports } = await compileAndRun(`
      export function* addPairs(a: number, b: number): Generator<number> {
        yield a + b;
        yield a * b;
        yield a - b;
      }
    `);

    const gen = (exports.addPairs as Function)(10, 3);
    const r1 = gen.next();
    expect(r1.value).toBe(13); // 10 + 3

    const r2 = gen.next();
    expect(r2.value).toBe(30); // 10 * 3

    const r3 = gen.next();
    expect(r3.value).toBe(7); // 10 - 3

    const r4 = gen.next();
    expect(r4.done).toBe(true);
  }, 30000);

  it("consuming a generator with .done check from wasm", async () => {
    const { exports } = await compileAndRun(`
      function* twoValues(): Generator<number> {
        yield 42;
        yield 99;
      }

      export function sum(): number {
        const gen = twoValues();
        let total: number = 0;
        let r = gen.next();
        while (!r.done) {
          total = total + r.value;
          r = gen.next();
        }
        return total;
      }
    `);

    expect((exports.sum as Function)()).toBe(141); // 42 + 99
  }, 30000);

  it("compiles successfully with success flag", () => {
    const result = compile(`
      export function* simple(): Generator<number> {
        yield 1;
      }
    `);
    expect(result.success).toBe(true);
  }, 15000);
});
