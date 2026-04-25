// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1164 — Dynamic eval via JS host import: compile eval string to ad-hoc
 * Wasm module via the Wasm JS API.
 *
 * These tests cover the *dynamic* eval path — calls where the source argument
 * is not a compile-time constant string and therefore can't be statically
 * inlined (#1163).  They exercise the new `__extern_eval` host shim that
 * compiles the eval string with `js2wasm.compileSource` and runs it as a
 * fresh Wasm module rather than invoking the JS `eval` builtin.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { createEvalShim } from "../src/runtime-eval.js";

async function runTest(src: string): Promise<{ pass: boolean; ret?: unknown; error?: string }> {
  const result = compile(src, { skipSemanticDiagnostics: true });
  if (!result.success) return { pass: false, error: result.errors[0]?.message };
  const importObj = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
  if (typeof (importObj as any).setExports === "function") {
    (importObj as any).setExports(instance.exports);
  }
  try {
    const ret = (instance.exports as any).test();
    return { pass: ret === 1, ret };
  } catch (e: any) {
    return { pass: false, error: String(e) };
  }
}

describe("#1164 — dynamic eval via Wasm-module compilation", () => {
  it("dynamic arithmetic eval returns the value", async () => {
    const src = `
      export function test(): number {
        const s: any = "1 + 2";
        const r: any = eval(s);
        return r === 3 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval can return a string", async () => {
    const src = `
      export function test(): number {
        const s: any = '"hello"';
        const r: any = eval(s);
        return r === "hello" ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic indirect eval (0, eval)(s) returns the value", async () => {
    const src = `
      export function test(): number {
        const s: any = "10 + 5";
        const r: any = (0, eval)(s);
        return r === 15 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval with non-string input returns input unchanged (spec step 2)", async () => {
    const src = `
      export function test(): number {
        const v: any = 42;
        const r: any = eval(v);
        return r === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval syntax error propagates as catchable exception", async () => {
    const src = `
      export function test(): number {
        try {
          const s: any = "@@@";
          eval(s);
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval runtime throw propagates as catchable exception", async () => {
    const src = `
      export function test(): number {
        try {
          const s: any = "(function(){ throw 'boom'; })()";
          eval(s);
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("nested dynamic eval works", async () => {
    const src = `
      export function test(): number {
        const s: any = 'eval("40 + 2")';
        const r: any = eval(s);
        return r === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval with multiplication", async () => {
    const src = `
      export function test(): number {
        const s: any = "6 * 7";
        const r: any = eval(s);
        return r === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval with conditional expression", async () => {
    const src = `
      export function test(): number {
        const s: any = "true ? 100 : 200";
        const r: any = eval(s);
        return r === 100 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("dynamic eval result is forwarded to caller", async () => {
    const src = `
      export function test(): number {
        const s: any = "1 + 2";
        const r1: any = eval(s);
        const r2: any = eval(s);
        return (r1 === 3 && r2 === 3) ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});

describe("#1164 — createEvalShim API (reference shim)", () => {
  it("creates a shim that returns non-string args unchanged", () => {
    const shim = createEvalShim();
    expect(shim(42, 1)).toBe(42);
    expect(shim(null, 0)).toBe(null);
    expect(shim({ a: 1 }, 0)).toEqual({ a: 1 });
  });

  it("evaluates an arithmetic expression", () => {
    const shim = createEvalShim();
    expect(shim("1 + 2", 0)).toBe(3);
  });

  it("evaluates a string expression", () => {
    const shim = createEvalShim();
    expect(shim('"hi"', 0)).toBe("hi");
  });

  it("propagates SyntaxError on malformed source", () => {
    const shim = createEvalShim();
    expect(() => shim("@@@@", 0)).toThrow(SyntaxError);
  });

  it("invokes onCompiled telemetry callback", () => {
    const calls: { src: string; binarySize: number; isDirect: boolean }[] = [];
    const shim = createEvalShim({ onCompiled: (info) => calls.push(info) });
    shim("1 + 2", 1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.src).toBe("1 + 2");
    expect(calls[0]!.isDirect).toBe(true);
    expect(calls[0]!.binarySize).toBeGreaterThan(0);
  });

  it("recursive eval inside the child module is forwarded to the same shim", () => {
    const shim = createEvalShim();
    // Note: this only works because we wire env.__extern_eval recursively
    // when filling in missing imports for the child module.
    expect(shim('eval("40 + 2")', 0)).toBe(42);
  });

  it("default selectiveImports={} produces a sandboxed child (no JS surface)", () => {
    const shim = createEvalShim({ selectiveImports: {} });
    // A pure expression that needs no host imports compiles fine.
    expect(shim("100 - 1", 0)).toBe(99);
  });
});
