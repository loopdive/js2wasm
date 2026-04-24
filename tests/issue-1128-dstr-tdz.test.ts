// Tests for #1128 — Destructuring TDZ and AnnexB B.3.3 function-in-block hoisting.
//
// Part A: TDZ for destructuring default initializers.
// Part B: AnnexB B.3.3 function-in-block hoisting TDZ.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string): Promise<{ pass: boolean; ret?: number; error?: string }> {
  const result = compile(src, { skipSemanticDiagnostics: true });
  if (!result.success) return { pass: false, error: result.errors?.[0]?.message ?? "compile error" };
  try {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as any);
    if (typeof (imports as any).setExports === "function") {
      (imports as any).setExports(instance.exports);
    }
    const ret = (instance.exports as any).test() as number;
    return { pass: ret === 1, ret };
  } catch (e: any) {
    return { pass: false, error: e.message ?? String(e) };
  }
}

describe("#1128 Part A — destructuring TDZ", () => {
  it("self-reference in object destructuring default throws", async () => {
    const src = `
      export function test(): number {
        try {
          let { x = x } = {};
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

  it("self-reference in array destructuring default throws", async () => {
    const src = `
      export function test(): number {
        try {
          let [ y = y ] = [];
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

  it("forward-reference to later sibling in object destructuring default throws", async () => {
    const src = `
      export function test(): number {
        try {
          let { a = b, b } = {};
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

  it("back-reference to earlier sibling (object) works", async () => {
    const src = `
      export function test(): number {
        let { a, b = a } = { a: 1 };
        return b === 1 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("const destructuring self-reference throws", async () => {
    const src = `
      export function test(): number {
        try {
          const { x = x } = {};
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

  it("var destructuring does NOT throw (TDZ is only for let/const)", async () => {
    // `var` has no TDZ — accessing a var before initialization gives `undefined`.
    const src = `
      export function test(): number {
        var { x = 42 } = {};
        return x === 42 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("unresolvable reference in destructuring default throws ReferenceError", async () => {
    const src = `
      export function test(): number {
        try {
          let { x = unresolvableReference } = {};
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

  it("property-form self-reference (obj-ptrn-prop-id-init-tdz)", async () => {
    // `let { x: y = y } = {}` — `y` is the binding, `x` is the property name.
    // The `y` in the default references the binding `y` in TDZ.
    const src = `
      export function test(): number {
        try {
          let { x: y = y } = {};
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
});
