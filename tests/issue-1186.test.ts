// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1186 — Legacy `compileForOfString` produced invalid Wasm in
// `nativeStrings: true` mode for `for (const c of s)`. Root cause:
// `ctx.nativeStrHelpers.get("__str_charAt")` captures funcIdx at
// registration time, but late-import shifts move `__str_charAt`'s
// position in the module — the captured index becomes stale.
//
// Fix: re-resolve `__str_charAt` by name against `ctx.mod.functions`
// at the call site (mirrors the IR resolver's #1183 pattern).
//
// Surface check: dual-run (legacy + IR, with nativeStrings: true) of
// `for (const c of s)` over inline string literals. Before #1186 the
// legacy path produced `WebAssembly.CompileError: call[0] expected
// type externref, found local.get of type i32`. After: both paths
// produce valid Wasm and identical runtime results.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "compile_fail"; first: string }
  | { kind: "instantiate_fail"; reason?: string }
  | { kind: "invoke_fail"; reason?: string };

async function runOnce(
  source: string,
  fnName: string,
  experimentalIR: boolean,
  nativeStrings: boolean,
): Promise<Outcome> {
  const r = compile(source, { experimentalIR, nativeStrings });
  if (!r.success) {
    return { kind: "compile_fail", first: r.errors[0]?.message ?? "" };
  }
  let instance: WebAssembly.Instance;
  try {
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    ({ instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    }));
  } catch (e: unknown) {
    return { kind: "instantiate_fail", reason: e instanceof Error ? e.message : String(e) };
  }
  try {
    const fn = instance.exports[fnName] as () => unknown;
    return { kind: "ok", value: fn() };
  } catch (e: unknown) {
    return { kind: "invoke_fail", reason: e instanceof Error ? e.message : String(e) };
  }
}

interface Case {
  name: string;
  source: string;
  expected: number;
}

const CASES: Case[] = [
  // ---- 1. Canonical reproducer for the staleness bug ---------------------
  {
    name: "count 5 chars in 'hello'",
    source: `
      export function fn(): number {
        const s = "hello";
        let n = 0;
        for (const c of s) { n = n + 1; }
        return n;
      }
    `,
    expected: 5,
  },

  // ---- 2. Empty string ---------------------------------------------------
  {
    name: "empty string returns 0",
    source: `
      export function fn(): number {
        const s = "";
        let n = 0;
        for (const c of s) { n = n + 1; }
        return n;
      }
    `,
    expected: 0,
  },

  // ---- 3. Single-char ----------------------------------------------------
  {
    name: "single-char string",
    source: `
      export function fn(): number {
        const s = "z";
        let n = 0;
        for (const c of s) { n = n + 1; }
        return n;
      }
    `,
    expected: 1,
  },

  // ---- 4. Body uses .length on the loop var (exercises the c value) ------
  {
    name: "uses c.length in body",
    source: `
      export function fn(): number {
        const s = "abc";
        let n = 0;
        for (const c of s) { n = n + c.length; }
        return n;
      }
    `,
    expected: 3,
  },

  // ---- 5. BMP unicode (counts code units) --------------------------------
  {
    name: "BMP unicode 'café' (4 code units)",
    source: `
      export function fn(): number {
        const s = "café";
        let n = 0;
        for (const c of s) { n = n + 1; }
        return n;
      }
    `,
    expected: 4,
  },
];

describe("#1186 — legacy compileForOfString re-resolves __str_charAt post-shift (nativeStrings)", () => {
  for (const tc of CASES) {
    it(`legacy + nativeStrings: ${tc.name}`, async () => {
      const r = await runOnce(tc.source, "fn", false, true);
      if (r.kind !== "ok") {
        throw new Error(`legacy run failed: ${JSON.stringify(r)}`);
      }
      expect(r.value).toBe(tc.expected);
    });
  }
});

describe("#1186 — legacy ↔ IR equivalence in nativeStrings mode (#1183 dual-run re-enabled)", () => {
  // Before #1186 these dual-runs were impossible because legacy was broken.
  // After #1186 the legacy path emits valid Wasm, so we can compare.
  for (const tc of CASES) {
    it(`equivalent: ${tc.name}`, async () => {
      const [legacy, ir] = await Promise.all([
        runOnce(tc.source, "fn", false, true),
        runOnce(tc.source, "fn", true, true),
      ]);
      if (legacy.kind !== "ok") throw new Error(`legacy run failed: ${JSON.stringify(legacy)}`);
      if (ir.kind !== "ok") throw new Error(`ir run failed: ${JSON.stringify(ir)}`);
      expect(legacy.value).toBe(ir.value);
      expect(legacy.value).toBe(tc.expected);
    });
  }
});

describe("#1186 — host-strings (default) for-of string iteration still works", () => {
  // Sanity check: the fix should be a no-op in host-strings mode (no
  // __str_charAt is registered there). Just confirm host-mode still
  // compiles and runs cleanly.
  it("host: count chars in 'hello'", async () => {
    const source = `
      export function fn(): number {
        const s = "hello";
        let n = 0;
        for (const c of s) { n = n + 1; }
        return n;
      }
    `;
    const r = await runOnce(source, "fn", false, false);
    if (r.kind !== "ok") throw new Error(`host run failed: ${JSON.stringify(r)}`);
    expect(r.value).toBe(5);
  });
});
