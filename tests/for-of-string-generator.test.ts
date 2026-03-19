import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

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
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as unknown as WebAssembly.Imports,
  );
  return { exports: instance.exports as any, instance };
}

describe("for-of string in generator", () => {
  it("should yield each character of a string", async () => {
    const { exports } = await compileAndRun(`
      export function* gen(s: string): Generator<string> {
        for (const c of s) {
          yield c;
        }
      }
    `);

    const g = (exports.gen as Function)("abc");
    const results: string[] = [];
    let r = g.next();
    while (!r.done) {
      results.push(r.value);
      r = g.next();
    }
    expect(results).toEqual(["a", "b", "c"]);
  });

  it("should handle early return inside for-of string in generator", async () => {
    const { exports } = await compileAndRun(`
      export function* gen(s: string): Generator<string> {
        for (const c of s) {
          if (c === "b") return;
          yield c;
        }
      }
    `);

    const g = (exports.gen as Function)("abcd");
    const results: string[] = [];
    let r = g.next();
    while (!r.done) {
      results.push(r.value);
      r = g.next();
    }
    expect(results).toEqual(["a"]);
  });
});
