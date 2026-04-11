import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string) {
  const result = compile(source);
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    return { ce: result.errors.map((e) => e.message).join("; ") };
  }
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    return { result: (instance.exports as any).test?.() };
  } catch (e: any) {
    return { err: e.message };
  }
}

describe("yield* delegation", () => {
  it("yield* from generator", async () => {
    const { ce, err, result } = await run(`
      function* inner(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      function* outer(): Generator<number> {
        yield* inner();
      }
      export function test(): number {
        let sum = 0;
        for (const v of outer()) { sum += v; }
        return sum;
      }
    `);
    expect(ce, "compile error").toBeUndefined();
    expect(err, "runtime error").toBeUndefined();
    expect(result).toBe(6);
  });

  it("yield* chaining two generators", async () => {
    const { ce, err, result } = await run(`
      function* a(): Generator<number> { yield 10; yield 20; }
      function* b(): Generator<number> { yield 30; yield 40; }
      function* combined(): Generator<number> {
        yield* a();
        yield* b();
      }
      export function test(): number {
        let sum = 0;
        for (const v of combined()) { sum += v; }
        return sum;
      }
    `);
    expect(ce, "compile error").toBeUndefined();
    expect(err, "runtime error").toBeUndefined();
    expect(result).toBe(100);
  });

  it("yield* mixed with regular yield", async () => {
    const { ce, err, result } = await run(`
      function* inner(): Generator<number> { yield 2; yield 3; }
      function* outer(): Generator<number> {
        yield 1;
        yield* inner();
        yield 4;
      }
      export function test(): number {
        let sum = 0;
        for (const v of outer()) { sum += v; }
        return sum;
      }
    `);
    expect(ce, "compile error").toBeUndefined();
    expect(err, "runtime error").toBeUndefined();
    expect(result).toBe(10);
  });
});
