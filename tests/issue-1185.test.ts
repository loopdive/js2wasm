// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1185 — IR Phase 4: refactor LowerCtx + slot-binding `asType` widening.
//
// Two test surfaces:
//   1. Resolver thread-through doesn't break prior IR tests (covered
//      by re-running #1182 / #1183 / #1169e suites — verified at PR time).
//   2. The new slot-binding `asType` widening lets native-strings
//      string for-of compose with slice-1 string ops on the loop
//      variable. Before #1185 this threw `ir/from-ast: …` and fell
//      back to legacy. After: claims through the IR.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";
import ts from "typescript";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileAndCall(
  source: string,
  fnName: string,
  experimentalIR: boolean,
  nativeStrings: boolean,
): Promise<{ success: boolean; value?: unknown; error?: string }> {
  const r = compile(source, { experimentalIR, nativeStrings });
  if (!r.success) {
    return { success: false, error: r.errors[0]?.message ?? "" };
  }
  try {
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    });
    const fn = instance.exports[fnName] as () => unknown;
    return { success: true, value: fn() };
  } catch (e: unknown) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

describe("#1185 — slot-binding asType widening (native-strings string for-of)", () => {
  // Case 1: read .length on the loop var. Before #1185 the loop var
  // was `irVal((ref $AnyString))` and `.length` rejected the type.
  // After: loop var is `IrType.string` and `.length` lowers cleanly.
  it("native: c.length composes with the loop var", async () => {
    const source = `
      export function fn(): number {
        const s = "hello";
        let total = 0;
        for (const c of s) {
          total = total + c.length;
        }
        return total;
      }
    `;
    const r = await compileAndCall(source, "fn", true, true);
    if (!r.success) throw new Error(`run failed: ${r.error}`);
    // Each char has length 1, "hello" has 5 chars, so total = 5.
    expect(r.value).toBe(5);
  });

  // Case 2: string concat using the loop var. The body builds up a
  // result string by concatenating each loop-var char. Tests that
  // `result + c` lowers as `string.concat` when `c` carries
  // `IrType.string` instead of `(ref $AnyString)`.
  it("native: result = result + c composes with the loop var", async () => {
    const source = `
      export function fn(): string {
        const s = "abc";
        let result = "";
        for (const c of s) {
          result = result + c;
        }
        return result;
      }
    `;
    // Note: `result` is a string that needs to round-trip through JS.
    // We can only verify length here since native-string-to-JS-string
    // round-tripping requires #1187. Just compile and instantiate to
    // confirm Wasm is valid.
    const r = compile(source, { experimentalIR: true, nativeStrings: true });
    expect(r.success).toBe(true);
    const irErrors = r.errors.filter(
      (e) =>
        e.message.startsWith("IR path failed") ||
        e.message.startsWith("ir/from-ast") ||
        e.message.startsWith("ir/lower"),
    );
    expect(irErrors).toEqual([]);
    // Verify the Wasm at least validates.
    await WebAssembly.compile(r.binary);
  });

  // Case 3: triple equality on the loop var. Tests that `c === "x"`
  // composes — string.eq lowering accepts the loop-var SSA value as
  // a string operand. Uses a ternary (an IR-claimable expression
  // form) instead of if-else (which the body grammar rejects, sending
  // the function to legacy fall-back).
  it("native: c === literal composes with the loop var (ternary)", async () => {
    const source = `
      export function fn(): number {
        const s = "abcab";
        let count = 0;
        for (const c of s) {
          count = count + (c === "a" ? 1 : 0);
        }
        return count;
      }
    `;
    const r = await compileAndCall(source, "fn", true, true);
    if (!r.success) throw new Error(`run failed: ${r.error}`);
    expect(r.value).toBe(2); // 'a' appears twice in "abcab"
  });
});

describe("#1185 — selector still claims native-strings string for-of", () => {
  // Sanity check: the selector accepts these source shapes and the
  // IR is exercised. Without resolver threading the IR would have
  // thrown and fallen back to legacy.
  for (const [name, source] of [
    [
      "c.length in body",
      `export function fn(): number {
        const s = "hello";
        let n = 0;
        for (const c of s) { n = n + c.length; }
        return n;
      }`,
    ],
    [
      "string concat in body",
      `export function fn(): string {
        const s = "abc";
        let r = "";
        for (const c of s) { r = r + c; }
        return r;
      }`,
    ],
  ] as const) {
    it(`selector claims fn from "${name}"`, () => {
      const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ES2022, true);
      const sel = planIrCompilation(sf, { experimentalIR: true });
      expect([...sel.funcs]).toContain("fn");
    });
  }
});
