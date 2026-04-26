// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169a — IR Phase 4 Slice 1: strings, typeof, null/undefined checks.
//
// Each case compiles the same source twice — once with the legacy path
// (experimentalIR off) and once through the IR (experimentalIR on) — and
// asserts the exported function returns the same value for the same inputs.
// Both string backends are exercised (`nativeStrings: true` and
// `nativeStrings: false`).
//
// The test suite is the gate for #1169a: if any case here fails with
// experimentalIR on, the slice 1 widening is wrong.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Minimal env stub for compiled modules that don't need any host imports.
// Native-strings mode is fully self-contained at the Wasm level.
const ENV_STUB = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

async function instantiate(result: CompileResult): Promise<WebAssembly.Instance> {
  // host-string mode: build full imports incl. wasm:js-string + string_constants.
  // native-strings mode: still uses the same buildImports helper which is a
  //                     superset (wasm:js-string + string_constants are unused
  //                     but harmless to provide).
  const imports = buildImports(result.imports, ENV_STUB.env, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance;
}

/**
 * Run the same source through legacy and IR pipelines and compare the
 * results. Returns "outcome" objects rather than raw values so we can
 * compare error modes too — native-strings mode currently has known
 * legacy bugs around JS↔native string marshalling that make some test
 * cases throw during instantiation or invocation. As long as IR throws
 * the same way as legacy, we treat that as equivalence.
 */
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

const CASES: Case[] = [
  // ---- string literal returns ---------------------------------------------
  { name: "string literal", source: `export function f(): string { return "hi"; }`, fn: "f", args: [] },
  { name: "empty string literal", source: `export function f(): string { return ""; }`, fn: "f", args: [] },
  { name: "string literal w/ ascii", source: `export function f(): string { return "abc def"; }`, fn: "f", args: [] },

  // ---- string concat ------------------------------------------------------
  {
    name: "string concat literals",
    source: `export function f(): string { return "foo" + "bar"; }`,
    fn: "f",
    args: [],
  },
  {
    name: "string concat params",
    source: `export function f(a: string, b: string): string { return a + b; }`,
    fn: "f",
    args: ["foo", "bar"],
  },
  {
    name: "string concat 3-way",
    source: `export function f(a: string, b: string, c: string): string { return a + b + c; }`,
    fn: "f",
    args: ["x", "y", "z"],
  },

  // ---- string equality ----------------------------------------------------
  {
    name: "string === equal",
    source: `export function f(a: string, b: string): boolean { return a === b; }`,
    fn: "f",
    args: ["x", "x"],
  },
  {
    name: "string === unequal",
    source: `export function f(a: string, b: string): boolean { return a === b; }`,
    fn: "f",
    args: ["x", "y"],
  },
  {
    name: "string !== unequal",
    source: `export function f(a: string, b: string): boolean { return a !== b; }`,
    fn: "f",
    args: ["x", "y"],
  },
  {
    name: "string !== equal",
    source: `export function f(a: string, b: string): boolean { return a !== b; }`,
    fn: "f",
    args: ["x", "x"],
  },
  {
    name: "string === literal",
    source: `export function f(s: string): boolean { return s === "hi"; }`,
    fn: "f",
    args: ["hi"],
  },

  // ---- .length ------------------------------------------------------------
  {
    name: "string .length empty",
    source: `export function f(s: string): number { return s.length; }`,
    fn: "f",
    args: [""],
  },
  {
    name: "string .length 5",
    source: `export function f(s: string): number { return s.length; }`,
    fn: "f",
    args: ["hello"],
  },
  {
    name: "string .length on literal",
    source: `export function f(): number { return "abcd".length; }`,
    fn: "f",
    args: [],
  },

  // ---- template literals --------------------------------------------------
  {
    name: "template no subs",
    source: `export function f(): string { return \`hello world\`; }`,
    fn: "f",
    args: [],
  },
  {
    name: "template with single string sub",
    source: `export function f(name: string): string { return \`hi \${name}!\`; }`,
    fn: "f",
    args: ["bob"],
  },
  {
    name: "template with two string subs",
    source: `export function f(a: string, b: string): string { return \`<\${a}|\${b}>\`; }`,
    fn: "f",
    args: ["x", "y"],
  },

  // ---- typeof folding -----------------------------------------------------
  {
    name: "typeof number === 'number' true",
    source: `export function f(x: number): boolean { return typeof x === "number"; }`,
    fn: "f",
    args: [42],
  },
  {
    name: "typeof number === 'string' false",
    source: `export function f(x: number): boolean { return typeof x === "string"; }`,
    fn: "f",
    args: [42],
  },
  {
    name: "typeof string === 'string' true",
    source: `export function f(s: string): boolean { return typeof s === "string"; }`,
    fn: "f",
    args: ["x"],
  },
  {
    name: "typeof bool === 'boolean' true",
    source: `export function f(b: boolean): boolean { return typeof b === "boolean"; }`,
    fn: "f",
    args: [true],
  },

  // ---- null compare folding ----------------------------------------------
  {
    name: "x === null on number is false",
    source: `export function f(x: number): boolean { return x === null; }`,
    fn: "f",
    args: [0],
  },
  {
    name: "x !== null on number is true",
    source: `export function f(x: number): boolean { return x !== null; }`,
    fn: "f",
    args: [0],
  },
  {
    name: "null === x on string is false",
    source: `export function f(s: string): boolean { return null === s; }`,
    fn: "f",
    args: ["x"],
  },
];

describe("#1169a — IR slice 1 (host strings)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: false });
      // IR must produce the same outcome (value or error mode) as legacy.
      expect(ir).toStrictEqual(legacy);
      // Slice 1 should reach a successful invoke for host-string mode —
      // every case in CASES is in slice 1's scope. If we land in
      // compile_fail / instantiate_fail / invoke_fail here, something is
      // genuinely wrong (not just legacy-parity).
      expect(ir.kind).toBe("ok");
    });
  }
});

describe("#1169a — IR slice 1 (native strings, IR-correctness)", () => {
  // Static `typeof`-fold in native-strings mode is a known correctness
  // win over legacy: legacy produces a runtime NativeString for
  // `typeof x` and compares it to a NativeString literal via
  // `__str_equals`, which currently mis-classifies some primitives.
  // The IR slice-1 path folds `typeof <typed-operand>` to the JS-spec
  // tag at compile time, so the result is always the spec answer.
  it("typeof number === 'number' on number param folds to true", async () => {
    const o = await runOnce(
      `export function f(x: number): boolean { return typeof x === "number"; }`,
      "f",
      [42],
      true,
      true,
    );
    expect(o).toEqual({ kind: "ok", value: 1 });
  });
  it("typeof bool === 'boolean' on bool param folds to true", async () => {
    const o = await runOnce(
      `export function f(b: boolean): boolean { return typeof b === "boolean"; }`,
      "f",
      [true],
      true,
      true,
    );
    expect(o).toEqual({ kind: "ok", value: 1 });
  });
});

describe("#1169a — IR slice 1 (native strings, legacy-parity)", () => {
  // Native-strings mode is the second backend: same IR, different
  // resolver. We restrict the comparison to cases whose return value is
  // representable in JS (not an opaque WasmGC ref) — string-returning
  // functions in native mode return a `(ref $NativeString)` that is
  // opaque to JS, so vitest's `toStrictEqual` chokes on it. The
  // string-returning cases are still exercised by the host-string suite
  // above.
  //
  // Additionally, slice-1's `typeof` static-fold diverges from legacy
  // in native mode for some operand types (legacy compares native-
  // string typeof tags to externref typeof tags, producing false; IR
  // folds at compile time to the JS-correct tag). That's an
  // intentional improvement; the cases involved are listed in
  // KNOWN_NATIVE_TYPEOF_DIVERGENCES below.
  const STRING_RETURNING = new Set([
    "string literal",
    "empty string literal",
    "string literal w/ ascii",
    "string concat literals",
    "string concat params",
    "string concat 3-way",
    "template no subs",
    "template with single string sub",
    "template with two string subs",
  ]);
  const KNOWN_NATIVE_TYPEOF_DIVERGENCES = new Set([
    "typeof number === 'number' true",
    "typeof bool === 'boolean' true",
  ]);
  for (const c of CASES) {
    if (STRING_RETURNING.has(c.name)) continue;
    if (KNOWN_NATIVE_TYPEOF_DIVERGENCES.has(c.name)) continue;
    it(c.name, async () => {
      const { legacy, ir } = await dualRun(c.source, c.fn, c.args, { nativeStrings: true });
      expect(ir).toStrictEqual(legacy);
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage / no-fallback assertions.
//
// The IR path doesn't surface `report.compiled` through the public `compile`
// API. We assert the next-best thing: every slice-1 source compiles cleanly
// with `experimentalIR: true` AND emits no "IR path failed" / "IR path:
// could not resolve" warnings. If the selector claimed a function and the
// lowerer threw mid-emission, those messages are how it would show up in
// `result.errors`.
// ---------------------------------------------------------------------------

const COVERAGE_SOURCES = [
  `export function f(s: string): number { return s.length; }`,
  `export function f(a: string, b: string): string { return a + b; }`,
  `export function f(s: string): boolean { return typeof s === "string"; }`,
  `export function f(x: number): boolean { return x === null; }`,
  `export function f(): string { return "hi"; }`,
  `export function f(name: string): string { return \`hi \${name}!\`; }`,
];

describe("#1169a — slice 1 functions reach the IR path without errors", () => {
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
