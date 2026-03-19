import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("string to number coercion", () => {
  it("unary + on string calls parseFloat", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var s: string = "42.5";
        return +s;
      }
    `);
    expect(e.test()).toBe(42.5);
  });

  it("unary + on number is no-op", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return +(3 + 4);
      }
    `);
    expect(e.test()).toBe(7);
  });

  it("Number() function converts string", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var s: string = "123";
        return Number(s);
      }
    `);
    expect(e.test()).toBe(123);
  });

  it("string in arithmetic gets coerced", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var s: string = "10";
        return (+s) * 2;
      }
    `);
    expect(e.test()).toBe(20);
  });
});

describe("string + null/undefined coercion", () => {
  it('"1" + null === "1null"', async () => {
    const e = await compileAndRun(`
      export function test(): string {
        return "1" + null;
      }
    `);
    expect(e.test()).toBe("1null");
  });

  it('null + "1" === "null1"', async () => {
    const e = await compileAndRun(`
      export function test(): string {
        return null + "1";
      }
    `);
    expect(e.test()).toBe("null1");
  });

  it('"1" + undefined === "1undefined"', async () => {
    const e = await compileAndRun(`
      export function test(): string {
        return "1" + undefined;
      }
    `);
    expect(e.test()).toBe("1undefined");
  });

  it('undefined + "1" === "undefined1"', async () => {
    const e = await compileAndRun(`
      export function test(): string {
        return undefined + "1";
      }
    `);
    expect(e.test()).toBe("undefined1");
  });
});
