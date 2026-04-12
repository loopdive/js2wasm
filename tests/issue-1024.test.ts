import { describe, test, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compile error: ${r.errors[0]?.message}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, Function>).test() as number;
}

describe("#1024 — Destructuring defaults with holes/undefined", () => {
  test("[x = 23] = [,] — hole triggers default", async () => {
    expect(
      await compileAndRun(`
      export function test(): number { var [x = 23] = [,]; return x; }
    `),
    ).toBe(23);
  });

  test("[,, x = 10] = [1, 2, ,] — trailing hole triggers default", async () => {
    expect(
      await compileAndRun(`
      export function test(): number { var [,, x = 10] = [1, 2, ,]; return x; }
    `),
    ).toBe(10);
  });

  test("[x = 23] = [undefined] — undefined triggers default", async () => {
    expect(
      await compileAndRun(`
      export function test(): number { var [x = 23] = [undefined]; return x; }
    `),
    ).toBe(23);
  });

  test("[x = 23] = [42] — value overrides default", async () => {
    expect(
      await compileAndRun(`
      export function test(): number { var [x = 23] = [42]; return x; }
    `),
    ).toBe(42);
  });

  test("[x] = [42] — no default, value works", async () => {
    expect(
      await compileAndRun(`
      export function test(): number { var [x] = [42]; return x; }
    `),
    ).toBe(42);
  });

  test("[, , x] = [1, 2, 3] — elision skips elements", async () => {
    expect(
      await compileAndRun(`
      export function test(): number { var [, , x] = [1, 2, 3]; return x; }
    `),
    ).toBe(3);
  });

  test("[a, , b] = [1, 2, 3] — middle elision", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [a, , b] = [1, 2, 3];
        return (a === 1 && b === 3) ? 1 : 0;
      }
    `),
    ).toBe(1);
  });

  test("[...x] = [1, 2, 3] — rest captures all", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [...x] = [1, 2, 3];
        return (x.length === 3 && x[0] === 1 && x[2] === 3) ? 1 : 0;
      }
    `),
    ).toBe(1);
  });

  test("[a, ...rest] = [1, 2, 3] — rest after first", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [a, ...rest] = [1, 2, 3];
        return (a === 1 && rest.length === 2 && rest[0] === 2) ? 1 : 0;
      }
    `),
    ).toBe(1);
  });

  test("[x = 5] from empty array — exhausted triggers default", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [x = 5]: number[] = [];
        return x;
      }
    `),
    ).toBe(5);
  });

  test("[a = 1, b = 2, c = 3] = [,, 10] — mixed holes and values", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [a = 1, b = 2, c = 3] = [,, 10];
        return (a === 1 && b === 2 && c === 10) ? 1 : 0;
      }
    `),
    ).toBe(1);
  });

  test("[a, b, c] = [10, 20, 30] — no defaults regression", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [a, b, c] = [10, 20, 30];
        return a + b + c;
      }
    `),
    ).toBe(60);
  });

  test("[[a, b]] = [[1, 2]] — nested destructuring", async () => {
    expect(
      await compileAndRun(`
      export function test(): number {
        var [[a, b]] = [[1, 2]];
        return (a === 1 && b === 2) ? 1 : 0;
      }
    `),
    ).toBe(1);
  });
});
