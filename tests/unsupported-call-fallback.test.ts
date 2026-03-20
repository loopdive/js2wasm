/**
 * Test that previously-unsupported call expression patterns no longer
 * produce hard compile errors (#621). The graceful fallback should compile
 * them (returning a default value) rather than failing compilation entirely.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function compileSource(source: string) {
  return compile(source);
}

async function compileAndRun(source: string): Promise<number> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const env: Record<string, Function> = {
    console_log_number: () => {},
    console_log_bool: () => {},
    console_log_string: () => {},
    number_toString: (v: number) => String(v),
  };
  const jsStringPolyfill = {
    concat: (a: string, b: string) => a + b,
    length: (s: string) => s.length,
    equals: (a: string, b: string) => (a === b ? 1 : 0),
    substring: (s: string, start: number, end: number) => s.substring(start, end),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  };
  const { buildStringConstants } = await import("../src/runtime.js");
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env,
    "wasm:js-string": jsStringPolyfill,
    string_constants: buildStringConstants(result.stringPool),
  } as WebAssembly.Imports);
  return (instance.exports as any).test();
}

describe("unsupported call fallback (#621)", () => {
  it("basic function call still works", async () => {
    const r = await compileAndRun(`
      function add(a: number, b: number): number { return a + b; }
      export function test(): number { return add(10, 20); }
    `);
    expect(r).toBe(30);
  });

  it("compilation succeeds with class static field", () => {
    const result = compileSource(`
      class C {
        static val = 42;
      }
      export function test(): number {
        return C.val;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("method call on class instance works", async () => {
    const r = await compileAndRun(`
      class Dog {
        age: number;
        constructor(a: number) { this.age = a; }
        getAge(): number { return this.age; }
      }
      export function test(): number {
        var d = new Dog(5);
        return d.getAge();
      }
    `);
    expect(r).toBe(5);
  });

  it("does not hard-error on unrecognized call patterns", () => {
    // Previously this would produce a hard "Unsupported call expression" compile error.
    // With the graceful fallback, compilation should succeed (possibly with runtime
    // default value for the unsupported call).
    const result = compile(`
      function factory(): any { return null; }
      var x: any = factory();
      export function test(): number { return 0; }
    `);
    // The key assertion: no hard errors
    expect(result.success).toBe(true);
  });

  it("no Unsupported call expression errors for valid code", () => {
    // This verifies the fallback converts hard errors to successful compilation
    // for patterns the compiler cannot yet handle natively
    const result = compile(`
      function add(a: number, b: number): number { return a + b; }
      var fn = add;
      export function test(): number {
        return fn(1, 2);
      }
    `);
    const unsupErrors = result.errors.filter(
      (e: any) => e.message === "Unsupported call expression"
    );
    expect(unsupErrors.length).toBe(0);
  });
});
