/**
 * Tests for issue #1374 (Path B): IR inline-small SSA-rename bug for
 * callees that contain body-buffer instrs (forof.iter, forof.string,
 * forof.vec, try, while.loop, for.loop).
 *
 * Pre-fix symptom: any caller of a function whose body has a `forof.iter`
 * (most commonly: `for (const c of stringValue) ...`) failed IR-lowering
 * with `ir/lower: duplicate SSA def for N in <caller>`. The for-of
 * function itself was IR-claimed; only callers fell back to legacy.
 *
 * Root cause: inline-small renamed top-level callee body instr results
 * to fresh caller-scope ids but did NOT walk into nested body buffers
 * (forof.iter.body, etc.). Nested instr results stayed as callee-scope
 * ids, which the lower pass `registerInstrDefs` (which DOES recurse into
 * body buffers) then flagged as duplicates against caller's already-
 * registered ids.
 *
 * The probe-discovered second-order bug: when first written, the deep
 * rename helper let `renameInstrOperands` recurse into body buffers
 * (renaming operands once) AND then recursed itself on each sub
 * (re-applying the rename), so any fresh caller id that happened to
 * coincide with a callee id got DOUBLE-mapped — producing
 * `binary { lhs: 4, rhs: 5, result: 5 }` (rhs and result point at the
 * same value), which infinite-loops in `lower.ts:emitValue`. Fixed by
 * splitting the deep helper to handle body-bearing instrs directly
 * without delegating to `renameInstrOperands` (which has its own body
 * recursion).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface CompileWarning {
  message: string;
  severity: string;
}

async function runTest(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

function irFallbacks(src: string): string[] {
  const r = compile(src, { fileName: "test.ts", experimentalIR: true });
  return ((r.errors ?? []) as CompileWarning[])
    .filter((e) => e.message.includes("IR path failed"))
    .map((e) => e.message);
}

describe("issue #1374: IR inline-small handles callees with body-buffer instrs", () => {
  it("caller of a string-for-of helper compiles via IR (no duplicate SSA def)", () => {
    const src = `
function f(s: string): number { let n = 0; for (const c of s) n++; return n; }
export function test(): number { return f("hi") === 2 ? 1 : 0; }
`;
    const fbs = irFallbacks(src);
    expect(fbs.filter((m) => m.includes("test"))).toEqual([]);
    expect(fbs.filter((m) => m.includes("duplicate SSA def"))).toEqual([]);
  });

  it("caller of a string-for-of helper produces correct runtime result", async () => {
    expect(
      await runTest(`
function countChars(s: string): number { let n = 0; for (const c of s) n++; return n; }
export function test(): number { return countChars("hello") === 5 ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("string-for-of helper with no comparison in caller compiles via IR", () => {
    const src = `
function f(s: string): number { let n = 0; for (const c of s) n++; return n; }
export function test(): number { return f("hi"); }
`;
    expect(irFallbacks(src).filter((m) => m.includes("test"))).toEqual([]);
  });

  it("two-level call chain through a string-for-of helper compiles via IR", () => {
    const src = `
function f(s: string): number { let n = 0; for (const c of s) n++; return n; }
function g(): number { return f("hi"); }
export function test(): number { return g() === 2 ? 1 : 0; }
`;
    const fbs = irFallbacks(src);
    expect(fbs.filter((m) => m.includes("duplicate SSA def"))).toEqual([]);
    expect(fbs.filter((m) => m.includes("Maximum call stack"))).toEqual([]);
  });

  it("vec-for-of caller still works (regression check — previously OK)", async () => {
    expect(
      await runTest(`
function sumArr(a: number[]): number { let s = 0; for (const v of a) s += v; return s; }
export function test(): number { return sumArr([1, 2, 3]) === 6 ? 1 : 0; }
`),
    ).toBe(1);
  });

  it("standalone string-for-of (no caller) still works (regression check)", async () => {
    expect(
      await runTest(`
export function test(): number {
  let n = 0;
  for (const c of "hello") n++;
  return n === 5 ? 1 : 0;
}
`),
    ).toBe(1);
  });

  it("identifier-only function call (no body-buffer in callee) still inlines fine", async () => {
    expect(
      await runTest(`
function add(a: number, b: number): number { return a + b; }
export function test(): number { return add(2, 3) === 5 ? 1 : 0; }
`),
    ).toBe(1);
  });
});
