// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1181 — IR Phase 4 Slice 6 part 2: AST→IR bridge for vec for-of.
//
// Activates the slice-6 IR scaffolding shipped by #1169e (PR #63) by
// landing the AST→IR bridge so functions containing
// `for (const x of arr)` over a typed array stop falling through to
// legacy codegen.
//
// Each test case compiles the same source twice — once with the legacy
// path (`experimentalIR: false`) and once through the IR
// (`experimentalIR: true`) — and asserts the exported function returns
// the same value when called through both paths. A separate "selector"
// suite verifies the IR actually CLAIMS the test function (so we'd
// catch a future regression that silently routes back to legacy).
//
// Vec construction in the test sources uses a `builder()` function
// that returns a `number[]` literal. The builder stays on the legacy
// path because array-literal lowering isn't in the IR's expression
// surface yet (deferred to a later slice); the IR-claimed function
// just consumes the vec ref the legacy builder produces. The
// call-graph closure normally rejects mixed legacy↔IR calls, but
// CALLER-of-IR is the rejected direction — IR-CALLED-from-JS is fine,
// and that's what JS does when it invokes the export here.

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

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "compile_fail"; firstMessage: string }
  | { kind: "instantiate_fail"; reason?: string }
  | { kind: "invoke_fail"; reason?: string };

async function runOnce(source: string, builderName: string, fnName: string, experimentalIR: boolean): Promise<Outcome> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    return { kind: "compile_fail", firstMessage: r.errors[0]?.message ?? "" };
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
    const builder = instance.exports[builderName] as () => unknown;
    const arr = builder();
    const fn = instance.exports[fnName] as (a: unknown) => unknown;
    return { kind: "ok", value: fn(arr) };
  } catch (e: unknown) {
    return { kind: "invoke_fail", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function dualRun(source: string, builderName: string, fnName: string): Promise<{ legacy: Outcome; ir: Outcome }> {
  const [legacy, ir] = await Promise.all([
    runOnce(source, builderName, fnName, false),
    runOnce(source, builderName, fnName, true),
  ]);
  return { legacy, ir };
}

interface Case {
  name: string;
  source: string;
  builder: string;
  fn: string;
  /** Names of IR-claimable functions in the source. */
  expectedClaimed: string[];
}

// Each case has TWO functions:
//   - `builder()` — legacy-compiled, returns the test's input array.
//     Stays on legacy because array-literal lowering isn't in the
//     IR's expression surface yet.
//   - `fn(arr)` — IR-claimed via the slice-6 part-2 vec for-of bridge.
//     Tests the actual feature: the for-of body, slot bindings,
//     compound assignment, etc.
const CASES: Case[] = [
  // ---- 1. last-element kernel (slot binding + slot.write in body) -----------
  {
    name: "for-of (T[]): last-element returns last value",
    source: `
      export function builder(): number[] { return [10, 20, 30]; }
      export function fn(arr: number[]): number {
        let result = 0;
        for (const x of arr) { result = x; }
        return result;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },

  // ---- 2. Array<T> param (parallel to T[] — both shapes recognised) -------
  {
    name: "for-of (Array<T>): same as last-element kernel",
    source: `
      export function builder(): number[] { return [5, 15, 25]; }
      export function fn(arr: Array<number>): number {
        let result = 0;
        for (const x of arr) { result = x; }
        return result;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },

  // ---- 3. accumulator pattern (slot.read + slot.write inside body) --------
  {
    name: "for-of: sum via plain assignment (sum = sum + x)",
    source: `
      export function builder(): number[] { return [1, 2, 3, 4, 5]; }
      export function fn(arr: number[]): number {
        let sum = 0;
        for (const x of arr) { sum = sum + x; }
        return sum;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },

  // ---- 4. compound assignment desugaring (`+=`) ---------------------------
  {
    name: "for-of: sum via compound assignment (sum += x)",
    source: `
      export function builder(): number[] { return [1, 2, 3, 4, 5]; }
      export function fn(arr: number[]): number {
        let sum = 0;
        for (const x of arr) { sum += x; }
        return sum;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },

  // ---- 5. empty array (no iterations, slot keeps initial value) -----------
  {
    name: "for-of: empty array returns initializer",
    source: `
      export function builder(): number[] { return []; }
      export function fn(arr: number[]): number {
        let result = 42;
        for (const x of arr) { result = x; }
        return result;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },

  // ---- 6. single-element array ---------------------------------------------
  {
    name: "for-of: single-element array",
    source: `
      export function builder(): number[] { return [99]; }
      export function fn(arr: number[]): number {
        let result = 0;
        for (const x of arr) { result = x; }
        return result;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },

  // ---- 7. multiple compound ops (`*=`) -------------------------------------
  {
    name: "for-of: product via *=",
    source: `
      export function builder(): number[] { return [2, 3, 4]; }
      export function fn(arr: number[]): number {
        let product = 1;
        for (const x of arr) { product *= x; }
        return product;
      }
    `,
    builder: "builder",
    fn: "fn",
    expectedClaimed: ["fn"],
  },
];

describe("#1181 — vec for-of through IR (slice 6 part 2)", () => {
  for (const tc of CASES) {
    it(tc.name, async () => {
      const { legacy, ir } = await dualRun(tc.source, tc.builder, tc.fn);
      // Both outcomes must be `ok` and produce the same value.
      expect(legacy.kind).toBe("ok");
      expect(ir.kind).toBe("ok");
      if (legacy.kind === "ok" && ir.kind === "ok") {
        expect(ir.value).toBe(legacy.value);
      }
    });
  }
});

describe("#1181 — selector claims for-of-shaped functions", () => {
  for (const tc of CASES) {
    it(`selector claims ${tc.fn} from "${tc.name}"`, () => {
      const sf = ts.createSourceFile("test.ts", tc.source, ts.ScriptTarget.ES2022, true);
      const sel = planIrCompilation(sf, { experimentalIR: true });
      // Every expected name must be in the claim set. Other functions
      // (the legacy builder) are intentionally NOT claimed.
      for (const name of tc.expectedClaimed) {
        expect([...sel.funcs]).toContain(name);
      }
    });
  }
});

describe("#1181 — IR compile produces no IR-fallback errors for for-of cases", () => {
  for (const tc of CASES) {
    it(`compiles "${tc.name}" cleanly under experimentalIR`, () => {
      const r = compile(tc.source, { experimentalIR: true });
      expect(r.success).toBe(true);
      // Errors prefixed with "IR path failed" / "ir/from-ast" / "ir/lower"
      // mean the selector claimed the function but the lowerer threw.
      // The function would still fall back to legacy, so compile would
      // succeed — but the noisy error indicates a slice-6-bridge bug.
      const irErrors = r.errors.filter(
        (e) =>
          e.message.startsWith("IR path failed") ||
          e.message.startsWith("ir/from-ast") ||
          e.message.startsWith("ir/lower"),
      );
      expect(irErrors).toEqual([]);
    });
  }
});

describe("#1181 — nested for-of produces stable, non-overlapping slot indices", () => {
  it("nested for-of: outer + inner each get their own slots", async () => {
    const source = `
      export function builder(): number[] { return [1, 2, 3]; }
      export function fn(arr: number[]): number {
        let total = 0;
        for (const x of arr) {
          for (const y of arr) {
            total = total + x * y;
          }
        }
        return total;
      }
    `;
    const { legacy, ir } = await dualRun(source, "builder", "fn");
    expect(legacy.kind).toBe("ok");
    expect(ir.kind).toBe("ok");
    if (legacy.kind === "ok" && ir.kind === "ok") {
      expect(ir.value).toBe(legacy.value);
      // Manual sanity: (1+2+3) * (1+2+3) = 36
      expect(ir.value).toBe(36);
    }
  });
});
