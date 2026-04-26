// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169c — IR Phase 4 Slice 3: closures (captures, ref cells, transitive
// captures) through the IR path.
//
// Each case compiles the same source twice — once with the legacy path
// (experimentalIR off) and once through the IR (experimentalIR on) — and
// asserts the exported function returns the same value for the same
// inputs. Both string backends are exercised for cases whose result is
// JS-representable.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "compile_fail"; firstMessage: string }
  | { kind: "instantiate_fail" }
  | { kind: "invoke_fail" };

async function runOnce(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  experimentalIR: boolean,
  nativeStrings: boolean,
): Promise<Outcome> {
  const r = compile(source, { nativeStrings, experimentalIR });
  if (!r.success) {
    return { kind: "compile_fail", firstMessage: r.errors[0]?.message ?? "" };
  }
  let instance: WebAssembly.Instance;
  try {
    const imports = buildImports(r.imports, ENV_STUB.env, r.stringPool);
    ({ instance } = await WebAssembly.instantiate(r.binary, imports));
  } catch {
    return { kind: "instantiate_fail" };
  }
  try {
    const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
    return { kind: "ok", value: fn(...args) };
  } catch {
    return { kind: "invoke_fail" };
  }
}

async function dualRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  options: { nativeStrings: boolean },
): Promise<{ legacy: Outcome; ir: Outcome }> {
  const [legacy, ir] = await Promise.all([
    runOnce(source, fnName, args, false, options.nativeStrings),
    runOnce(source, fnName, args, true, options.nativeStrings),
  ]);
  return { legacy, ir };
}

interface Case {
  name: string;
  source: string;
  fn: string;
  args: ReadonlyArray<string | number | boolean>;
}

// Slice 3 cases — each builds + calls one or more closures inside the
// outer function so the host marshalling boundary stays primitive.
const CASES: Case[] = [
  // ---- nested function declaration with no captures ----------------------
  {
    name: "nested fn no-capture",
    source: `export function f(): number { function inner(y: number): number { return y * 2; } return inner(7); }`,
    fn: "f",
    args: [],
  },

  // ---- nested function with read-only capture ----------------------------
  {
    name: "nested fn 1-capture readonly",
    source: `export function f(x: number): number { function inner(y: number): number { return x + y; } return inner(2); }`,
    fn: "f",
    args: [10],
  },
  {
    name: "nested fn 2-captures readonly",
    source: `export function f(x: number, z: number): number { function inner(y: number): number { return x + y + z; } return inner(2); }`,
    fn: "f",
    args: [10, 3],
  },
  {
    name: "nested fn called twice",
    source: `export function f(x: number): number { function inner(y: number): number { return x + y; } return inner(2) + inner(3); }`,
    fn: "f",
    args: [10],
  },

  // ---- arrow function as const, no captures ------------------------------
  {
    name: "arrow no-capture",
    source: `export function f(): number { const inc = (y: number): number => y + 1; return inc(5); }`,
    fn: "f",
    args: [],
  },

  // ---- arrow with read-only capture --------------------------------------
  {
    name: "arrow 1-capture readonly",
    source: `export function f(x: number): number { const inc = (y: number): number => x + y; return inc(2); }`,
    fn: "f",
    args: [10],
  },
  {
    name: "arrow 1-capture string",
    source: `export function f(s: string): string { const wrap = (t: string): string => s + t; return wrap("X"); }`,
    fn: "f",
    args: ["A"],
  },

  // ---- function expression -----------------------------------------------
  {
    name: "anon function expression",
    source: `export function f(x: number): number { const g = function(y: number): number { return x + y; }; return g(2); }`,
    fn: "f",
    args: [10],
  },

  // ---- mutable capture (ref cell) ----------------------------------------
  {
    name: "mutable capture closure-write",
    source: `export function f(): number { let count = 0; const inc = (): number => { count = count + 1; return count; }; inc(); inc(); inc(); return count; }`,
    fn: "f",
    args: [],
  },

  // ---- transitive readonly captures --------------------------------------
  {
    name: "transitive readonly",
    source: `export function f(x: number): number { const a = (y: number): number => x + y; const b = (z: number): number => a(z) + x; return b(2); }`,
    fn: "f",
    args: [10],
  },

  // ---- composition with slice 1 ------------------------------------------
  {
    name: "closure returning string concat",
    source: `export function f(): number { const greet = (n: string): string => "hi " + n; return greet("world").length; }`,
    fn: "f",
    args: [],
  },

  // ---- ternary returning closure call -----------------------------------
  {
    name: "ternary on closure result",
    source: `export function f(b: boolean): number { const inc = (y: number): number => y + 1; return b ? inc(5) : inc(10); }`,
    fn: "f",
    args: [true],
  },
];

describe("#1169c — IR slice 3 (host strings)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: false });
      expect(ir).toStrictEqual(legacy);
    });
  }
});

// Native-strings: skip string-returning cases (opaque (ref $NativeString)
// values choke vitest's toStrictEqual).
const NATIVE_STRING_RETURNING = new Set(["arrow 1-capture string"]);

describe("#1169c — IR slice 3 (native strings, legacy-parity)", () => {
  for (const c of CASES) {
    if (NATIVE_STRING_RETURNING.has(c.name)) continue;
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: true });
      expect(ir).toStrictEqual(legacy);
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage assertions — every slice-3 source must compile cleanly with
// `experimentalIR: true` AND emit no IR-fallback errors. If the selector
// claimed a function and the lowerer threw mid-emission, those messages
// would show up in `result.errors`.
// ---------------------------------------------------------------------------

const COVERAGE_SOURCES = [
  // nested fn with capture
  `export function f(x: number): number { function inner(y: number): number { return x + y; } return inner(2); }`,
  // arrow with read-only capture
  `export function f(x: number): number { const inc = (y: number): number => x + y; return inc(2); }`,
  // mutable capture
  `export function f(): number { let c = 0; const inc = (): number => { c = c + 1; return c; }; inc(); return c; }`,
  // transitive
  `export function f(x: number): number { const a = (y: number): number => x + y; const b = (z: number): number => a(z); return b(3); }`,
];

describe("#1169c — slice 3 functions reach the IR path without errors", () => {
  for (const src of COVERAGE_SOURCES) {
    const label = src.slice(0, 80);
    it(`host: ${label}`, () => {
      const r = compile(src, { experimentalIR: true, nativeStrings: false });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) =>
          e.message.startsWith("IR path failed") ||
          e.message.startsWith("IR path: could not resolve") ||
          e.message.startsWith("ir/from-ast") ||
          e.message.startsWith("ir/lower"),
      );
      expect(irErrors).toEqual([]);
    });
    it(`native: ${label}`, () => {
      const r = compile(src, { experimentalIR: true, nativeStrings: true });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) =>
          e.message.startsWith("IR path failed") ||
          e.message.startsWith("IR path: could not resolve") ||
          e.message.startsWith("ir/from-ast") ||
          e.message.startsWith("ir/lower"),
      );
      expect(irErrors).toEqual([]);
    });
  }
});
