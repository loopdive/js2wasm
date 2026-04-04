import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("issue-352: delete operator", () => {
  it("delete obj.prop returns true (1)", async () => {
    const val = await run(
      `
      export function test(): number {
        const obj = { a: 1, b: 2 };
        const result = delete (obj as any).a;
        return result ? 1 : 0;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("delete variable returns false (0)", async () => {
    const val = await run(
      `
      export function test(): number {
        let x = 42;
        const result = delete (x as any);
        return result ? 1 : 0;
      }
    `,
      "test",
    );
    expect(val).toBe(0);
  });

  it("delete with literal returns true", async () => {
    const val = await run(
      `
      export function test(): number {
        const result = delete (0 as any);
        return result ? 1 : 0;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("delete result is usable as boolean in if", async () => {
    const val = await run(
      `
      export function test(): number {
        const obj = { x: 10 };
        if (delete (obj as any).x) {
          return 1;
        }
        return 0;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("delete compiles without errors", async () => {
    // Just verify it compiles - the main goal is to unblock test262 tests
    const result = compile(`
      export function test(): boolean {
        const obj = { a: 1 };
        return delete (obj as any).a;
      }
    `);
    expect(result.success).toBe(true);
  });
});
