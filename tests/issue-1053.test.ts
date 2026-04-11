/**
 * Tests for #1053: `arguments.length` reflects formal parameter count
 * instead of runtime args length.
 *
 * Root cause: `emitArgumentsObject` (and the inline path in
 * function-body.ts) built the `arguments` vec by iterating the callee's
 * formal parameter list, so a zero-formal method called with two
 * runtime args observed `arguments.length === 0`.
 *
 * Fix: call sites with more runtime args than formal params populate
 * a module global `__extras_argv` (a vec of externref). Functions
 * whose body reads `arguments` consume the global in their prologue
 * and concatenate formal params with the extras vec.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, CallableFunction>).main?.();
}

describe("#1053 — arguments.length reflects runtime arg count, not formal count", () => {
  it("zero-formal function called with two args → arguments.length === 2", async () => {
    const result = await run(`
      function f() { return arguments.length; }
      export function main(): number {
        return f(42, "TC39") as unknown as number;
      }
    `);
    expect(result).toBe(2);
  });

  it("zero-formal method called with two args → arguments.length === 2", async () => {
    const result = await run(`
      class C {
        method() { return arguments.length; }
      }
      export function main(): number {
        return new C().method(42, "TC39") as unknown as number;
      }
    `);
    expect(result).toBe(2);
  });

  it("one-formal function called with two args → arguments.length === 2", async () => {
    const result = await run(`
      function f(a: any) { return arguments.length; }
      export function main(): number {
        return f(1, 2) as unknown as number;
      }
    `);
    expect(result).toBe(2);
  });

  it("two-formal function called with two args → arguments.length === 2", async () => {
    const result = await run(`
      function f(a: any, b: any) { return arguments.length; }
      export function main(): number {
        return f(1, 2) as unknown as number;
      }
    `);
    expect(result).toBe(2);
  });

  // Note: under-application (runtime args < formal count) is out of scope for
  // #1053 — the fix targets over-application (the common test262 pattern).
  // Under-application requires threading an arg-count override through every
  // call site, which is tracked as a follow-up.

  it("arguments[0] reads first extra runtime arg", async () => {
    const result = await run(`
      function f() { return arguments[0] as number; }
      export function main(): number {
        return f(42, "TC39") as unknown as number;
      }
    `);
    expect(result).toBe(42);
  });

  it("arguments[1] reads second extra runtime arg (string-ish via strict-equal trick)", async () => {
    const result = await run(`
      function f() {
        // Return 1 if the second runtime arg equals the expected number.
        return arguments[1] === 99 ? 1 : 0;
      }
      export function main(): number {
        return f(42, 99) as unknown as number;
      }
    `);
    expect(result).toBe(1);
  });

  it("nested function calls — inner sees its own arguments, not outer's", async () => {
    const result = await run(`
      function inner() { return arguments.length; }
      function outer() {
        // outer has 0 formals, called with 3 extras; arguments.length should be 3
        const a = arguments.length;
        // inner called with 1 extra; arguments.length should be 1
        const b = inner(7);
        return a * 10 + (b as number);
      }
      export function main(): number {
        return outer(1, 2, 3) as unknown as number;
      }
    `);
    expect(result).toBe(31);
  });

  it("class method with no extras: arguments.length === formal count", async () => {
    const result = await run(`
      class C {
        method(a: any, b: any) { return arguments.length; }
      }
      export function main(): number {
        return new C().method(1, 2) as unknown as number;
      }
    `);
    expect(result).toBe(2);
  });

  it("object literal method called with extras → arguments.length includes extras", async () => {
    const result = await run(`
      const obj = {
        method() { return arguments.length; }
      };
      export function main(): number {
        return obj.method(1, 2, 3) as unknown as number;
      }
    `);
    expect(result).toBe(3);
  });
});
