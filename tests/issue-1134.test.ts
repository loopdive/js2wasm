import { test, expect, describe } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(src: string): any {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`Compile error: ${r.errors?.[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(r.binary), imports);
  return (instance.exports as any).test();
}

describe("#1134 — __any_eq cross-tag loose equality (§7.2.15)", () => {
  test("null == undefined returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = null;
      let b: any = undefined;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("undefined == null returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = undefined;
      let b: any = null;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("null !== undefined for strict equality", () => {
    const result = compileAndRun(`
      let a: any = null;
      let b: any = undefined;
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  test("true == 1 returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = true;
      let b: any = 1;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("false == 0 returns true for any-typed values", () => {
    const result = compileAndRun(`
      let a: any = false;
      let b: any = 0;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("null != 0 returns true for any-typed (null is not numeric)", () => {
    const result = compileAndRun(`
      let a: any = null;
      let b: any = 0;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    // Per spec: null == 0 is false (null only == null/undefined)
    expect(result).toBe(0);
  });

  // ── Cross-eqref / non-eqref loose equality (#1134 round 2) ───────────
  // V8 stores small integer JS Numbers (e.g. +0) as i31ref (an eqref) and
  // HeapNumbers (e.g. -0) as non-eqref. The ref-identity fast path in
  // `compileBinaryEquality` used to collapse "left is eqref, right isn't"
  // to a definitive `0` (false) — correct for strict `===` but wrong for
  // loose `==`, where JS coercion may still make them equal. The
  // canonical case is `0 == -0` (true). The fix pushes `-1` (sentinel)
  // for the loose case so the outer `if` routes through
  // `__host_loose_eq` (JS `==`); strict equality keeps the definitive `0`.
  test("0 == -0 (i31ref vs HeapNumber) → true via host fallback", () => {
    const result = compileAndRun(`
      let a: any = 0;
      let b: any = 0 * -1;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("false == '' (bool vs string) → true via host fallback", () => {
    const result = compileAndRun(`
      let a: any = false;
      let b: any = "";
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("'1' == 1 (string vs number) → true via host fallback", () => {
    const result = compileAndRun(`
      let a: any = "1";
      let b: any = 1;
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("regression guard: object identity ref.eq still works for ===", () => {
    const result = compileAndRun(`
      let a: any = { x: 1 };
      let b: any = a;
      export function test(): number {
        return (a === b) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  test("regression guard: distinct objects compare unequal under ==", () => {
    const result = compileAndRun(`
      let a: any = { x: 1 };
      let b: any = { x: 1 };
      export function test(): number {
        return (a == b) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  // Note: separate pre-existing bugs in the strict-equality numeric
  // fallback (`__unbox_number` coerces strings) cause cases like
  // `'1' === 1` and `0 === -0` to not match spec. Those are out of scope
  // for this issue (which targets only loose equality cross-tag coercion);
  // tracking via separate audit.
});
