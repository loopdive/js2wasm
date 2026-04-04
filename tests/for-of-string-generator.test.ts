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
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return { exports: instance.exports as any, instance };
}

describe("for-of string in generator (#590)", () => {
  it("yields each character of a string", async () => {
    const { exports } = await compileAndRun(`
      export function* chars(s: string): Generator<string> {
        for (const c of s) {
          yield c;
        }
      }
    `);

    const gen = (exports.chars as Function)("abc");
    const values: string[] = [];
    let r = gen.next();
    while (!r.done) {
      values.push(r.value);
      r = gen.next();
    }
    expect(values).toEqual(["a", "b", "c"]);
  }, 30000);

  it("handles early return inside for-of string in generator", async () => {
    const { exports } = await compileAndRun(`
      export function* firstTwo(s: string): Generator<string> {
        let count: number = 0;
        for (const c of s) {
          yield c;
          count = count + 1;
          if (count >= 2) {
            return;
          }
        }
      }
    `);

    const gen = (exports.firstTwo as Function)("hello");
    const values: string[] = [];
    let r = gen.next();
    while (!r.done) {
      values.push(r.value);
      r = gen.next();
    }
    expect(values).toEqual(["h", "e"]);
  }, 30000);
});
