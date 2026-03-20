import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
  };
  env["number_toString"] = (v: number) => String(v);

  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };

  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("local.set type mismatch (#625)", () => {
  it("array variable type updated when expression produces different vec type", async () => {
    // When resolveWasmType infers one vec struct type for the variable
    // but compileExpression produces a different vec struct type,
    // the local's declared type should be updated to match.
    const src = `
      export function test(): number {
        var a: any[] = [1, 2, 3];
        return 1;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  }, 15000);

  it("object literal assigned to variable with inferred struct type", async () => {
    // When TS infers a specific struct type for a variable but the expression
    // produces a different struct, the local type should be updated.
    const src = `
      export function test(): number {
        var obj = { x: 1, y: 2 };
        return obj.x + obj.y;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  }, 15000);

  it("coerceType no-op does not hide struct type mismatch", async () => {
    // Regression: when coerceType cannot convert between unrelated struct types,
    // the stackType must remain the actual result type so emitCoercedLocalSet
    // can detect and fix the mismatch by updating the local's declared type.
    const result = compile(`
      export function test(): number {
        var a: any[] = [1, 2, 3];
        return 1;
      }
    `);
    // Should compile successfully without Wasm validation errors
    expect(result.success).toBe(true);
    // Instantiation should not fail with local.set type mismatch
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
        console_log_string: () => {},
      },
      "wasm:js-string": {
        concat: (a: string, b: string) => a + b,
        length: (s: string) => s.length,
        equals: (a: string, b: string) => (a === b ? 1 : 0),
        substring: (s: string, start: number, end: number) => s.substring(start, end),
        charCodeAt: (s: string, i: number) => s.charCodeAt(i),
      },
      string_constants: buildStringConstants(result.stringPool),
    } as WebAssembly.Imports);
    expect((instance.exports as any).test()).toBe(1);
  }, 15000);
});
