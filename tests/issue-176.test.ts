import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = compile(source);
  if (!result.success)
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as WebAssembly.Imports,
  );
  return instance.exports as Record<string, Function>;
}

describe("unicode escape sequences in property names (#176)", () => {
  it("resolves unicode escape in property assignment on empty object", async () => {
    // obj.\u0065lse = 42 -> obj.else = 42
    const exports = await run(
      "export function test(): number { var obj: any = {}; obj.\\u0065lse = 42; return obj['else']; }"
    );
    expect(exports.test()).toBe(42);
  });

  it("resolves unicode escape in property read on inferred-type object", async () => {
    // obj.\u0078 -> obj.x (without any annotation so TS infers the struct type)
    const exports = await run(
      "export function test(): number { var obj = { x: 99 }; return obj.\\u0078; }"
    );
    expect(exports.test()).toBe(99);
  });

  it("resolves unicode escape in widened empty object (no type annotation)", async () => {
    // Like test262: var obj = {}; obj.bre\u0061k = 42;
    const exports = await run(
      "export function test(): number { var obj = {}; obj.bre\\u0061k = 42; return obj['break']; }"
    );
    expect(exports.test()).toBe(42);
  });

  it("resolves unicode escape in multiple property accesses", async () => {
    const exports = await run(
      "export function test(): number { var obj = {}; obj.\\u0065lse = 10; obj.\\u0069f = 20; return obj['else'] + obj['if']; }"
    );
    expect(exports.test()).toBe(30);
  });

  it("test262 pattern: reserved words as property names after escape resolution", async () => {
    // Simulate the test262 pattern where resolveUnicodeEscapes in the runner
    // pre-processes the source before compilation, turning bre\u0061k into break
    const exports = await run(`
      export function test(): number {
        var obj = {};
        obj.break = 42;
        return obj['break'];
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
