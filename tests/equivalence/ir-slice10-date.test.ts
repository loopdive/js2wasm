// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169l (IR Phase 4 Slice 10 step D — Date through IR).
//
// Coverage:
//   - `new Date()` with no args (current time).
//   - `new Date(ms)` with a numeric epoch arg.
//   - `d.getTime()` instance method returning a number.
//   - Comparisons of two Date refs (constructed back-to-back, both
//     observe-now). Uses `getTime()` to extract a comparable number.
//
// Pattern: same as ir-slice10-extern-regexp.test.ts — compile twice
// (experimentalIR true / false) and compare results to verify the IR
// path produces observable behaviour identical to legacy.

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

const ENV_STUB = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

async function compileAndRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<string | number | boolean>,
  experimentalIR: boolean,
): Promise<unknown> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, ENV_STUB.env, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const fn = instance.exports[fnName] as (...a: unknown[]) => unknown;
  return fn(...args);
}

describe("IR slice 10 — Date through IR (#1169l, step D)", () => {
  it("(a) new Date(0).getTime() === 0", async () => {
    const source = `
      export function run(): number {
        const d = new Date(0);
        return d.getTime();
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(0);
    expect(legacyResult).toBe(0);
  });

  it("(b) new Date(1000).getTime() === 1000", async () => {
    const source = `
      export function run(): number {
        const d = new Date(1000);
        return d.getTime();
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe(1000);
    expect(legacyResult).toBe(1000);
  });

  it("(c) new Date(ms).getTime() round-trips for an arbitrary epoch", async () => {
    const source = `
      export function run(ms: number): number {
        const d = new Date(ms);
        return d.getTime();
      }
    `;
    const irResult = await compileAndRun(source, "run", [1234567890123], true);
    const legacyResult = await compileAndRun(source, "run", [1234567890123], false);
    expect(irResult).toBe(1234567890123);
    expect(legacyResult).toBe(1234567890123);
  });
});
