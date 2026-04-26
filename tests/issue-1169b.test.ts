// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169b — IR Phase 4 Slice 2: object literals + property access.
//
// Each case compiles the same source twice — once with the legacy path
// (experimentalIR off) and once through the IR (experimentalIR on) — and
// asserts the exported function returns the same value for the same inputs.
// Both string backends are exercised (`nativeStrings: true` and
// `nativeStrings: false`) for cases whose result is JS-representable.
//
// The test suite is the gate for #1169b: if any case here fails with
// experimentalIR on, the slice 2 widening is wrong.

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

// Slice-2 test cases. Each builds an object literal inside the function
// (so the host marshalling boundary stays primitive) and reads a field
// or composes with slice-1 string ops.
const CASES: Case[] = [
  // ---- single-field literal ----------------------------------------------
  {
    name: "literal field read .x",
    source: `export function f(): number { const o = { x: 42 }; return o.x; }`,
    fn: "f",
    args: [],
  },

  // ---- two-field literal -------------------------------------------------
  {
    name: "literal two fields summed",
    source: `export function f(): number { const o = { a: 1, b: 2 }; return o.a + o.b; }`,
    fn: "f",
    args: [],
  },

  // ---- shorthand --------------------------------------------------------
  {
    name: "shorthand property",
    source: `export function f(x: number): number { const o = { x }; return o.x; }`,
    fn: "f",
    args: [42],
  },

  // ---- string field -----------------------------------------------------
  {
    name: "string field length",
    source: `export function f(): number { const o = { name: "hello" }; return o.name.length; }`,
    fn: "f",
    args: [],
  },

  // ---- boolean field ----------------------------------------------------
  {
    name: "boolean field returns through",
    source: `export function f(b: boolean): boolean { const o = { flag: b }; return o.flag; }`,
    fn: "f",
    args: [true],
  },

  // ---- element access (string-literal key) -----------------------------
  {
    name: "element access string-literal key",
    source: `export function f(): number { const o = { x: 99 }; return o["x"]; }`,
    fn: "f",
    args: [],
  },

  // ---- canonical ordering — same shape, different source order --------
  {
    name: "field order independent (a-then-b vs b-then-a)",
    source: `export function f(): number { const o1 = { a: 10, b: 1 }; const o2 = { b: 1, a: 10 }; return o1.a + o2.a; }`,
    fn: "f",
    args: [],
  },

  // ---- nested objects ---------------------------------------------------
  {
    name: "nested object access",
    source: `export function f(): number { const o = { a: { b: 7 } }; return o.a.b; }`,
    fn: "f",
    args: [],
  },

  // ---- composition with slice 1 ----------------------------------------
  {
    name: "object string field concat",
    source: `export function f(): string { const o = { greeting: "hi" }; return o.greeting + " world"; }`,
    fn: "f",
    args: [],
  },
  {
    name: "object + typeof",
    source: `export function f(): boolean { const o = { x: 1 }; return typeof o.x === "number"; }`,
    fn: "f",
    args: [],
  },

  // ---- conditional with object branches --------------------------------
  {
    name: "ternary on field",
    source: `export function f(b: boolean): number { const o = { x: 5, y: 7 }; return b ? o.x : o.y; }`,
    fn: "f",
    args: [true],
  },
];

describe("#1169b — IR slice 2 (host strings)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: false });
      // IR must produce the same outcome (value or error mode) as legacy.
      expect(ir).toStrictEqual(legacy);
    });
  }
});

// Native-strings mode: skip string-returning cases (they return opaque
// (ref $NativeString) values that vitest's toStrictEqual chokes on).
const NATIVE_STRING_RETURNING = new Set(["object string field concat"]);

describe("#1169b — IR slice 2 (native strings, legacy-parity)", () => {
  for (const c of CASES) {
    if (NATIVE_STRING_RETURNING.has(c.name)) continue;
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: true });
      expect(ir).toStrictEqual(legacy);
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage / no-fallback assertions.
//
// Every slice-2 source compiles cleanly with `experimentalIR: true` AND
// emits no "IR path failed" / "IR path: could not resolve" warnings.
// ---------------------------------------------------------------------------

const COVERAGE_SOURCES = [
  `export function f(): number { const o = { x: 42 }; return o.x; }`,
  `export function f(): number { const o = { a: 1, b: 2 }; return o.a + o.b; }`,
  `export function f(x: number): number { const o = { x }; return o.x; }`,
  `export function f(): number { const o = { a: { b: 7 } }; return o.a.b; }`,
  `export function f(): number { const o = { x: 99 }; return o["x"]; }`,
];

describe("#1169b — slice 2 functions reach the IR path without errors", () => {
  for (const src of COVERAGE_SOURCES) {
    const label = src.slice(0, 60);
    it(`host: ${label}`, () => {
      const r = compile(src, { experimentalIR: true, nativeStrings: false });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) => e.message.startsWith("IR path failed") || e.message.startsWith("IR path: could not resolve"),
      );
      expect(irErrors).toEqual([]);
    });
    it(`native: ${label}`, () => {
      const r = compile(src, { experimentalIR: true, nativeStrings: true });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) => e.message.startsWith("IR path failed") || e.message.startsWith("IR path: could not resolve"),
      );
      expect(irErrors).toEqual([]);
    });
  }
});
