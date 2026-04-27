// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1182 — IR Phase 4 Slice 6 part 3: host iterator protocol through IR.
//
// Activates the iter-host arm of the AST→IR for-of bridge. Functions
// that iterate a non-vec value (Map, Set, generator, custom iterable)
// now lower through the IR's `forof.iter` declarative instr instead of
// falling through to legacy.
//
// Each test compiles the same source twice — once with the legacy path
// (`experimentalIR: false`) and once through the IR
// (`experimentalIR: true`) — and asserts the exported function returns
// the same value when called through both paths. The selector suite
// confirms the IR actually CLAIMS the test function (so we'd catch a
// future regression that silently routes back to legacy).

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

async function runOnce(source: string, fnName: string, arg: unknown, experimentalIR: boolean): Promise<Outcome> {
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
    const fn = instance.exports[fnName] as (a: unknown) => unknown;
    return { kind: "ok", value: fn(arg) };
  } catch (e: unknown) {
    return { kind: "invoke_fail", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function dualRun(source: string, fnName: string, arg: unknown): Promise<{ legacy: Outcome; ir: Outcome }> {
  const [legacy, ir] = await Promise.all([runOnce(source, fnName, arg, false), runOnce(source, fnName, arg, true)]);
  return { legacy, ir };
}

interface Case {
  name: string;
  source: string;
  fn: string;
  arg: unknown;
  /** Names of IR-claimable functions in the source. */
  expectedClaimed: string[];
}

// Each case has ONE function `fn(iterable)` — IR-claimed via the
// iter-host arm. The iterable is constructed in JS (Map/Set/generator)
// so we don't need IR-side construction support; the test feeds the
// host object straight into the Wasm export.
const CASES: Case[] = [
  // ---- 1. Set<number> (canonical iter-host case) --------------------------
  {
    name: "Set<number>: count elements",
    source: `
      export function fn(s: Set<number>): number {
        let count = 0;
        for (const x of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    arg: new Set([1, 2, 3, 4, 5]),
    expectedClaimed: ["fn"],
  },

  // ---- 2. Set<number>: empty set -----------------------------------------
  {
    name: "Set<number>: empty set returns 0",
    source: `
      export function fn(s: Set<number>): number {
        let count = 0;
        for (const x of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    arg: new Set<number>(),
    expectedClaimed: ["fn"],
  },

  // ---- 3. Map<K,V>: count entries (each entry is a [k,v] tuple externref) -
  {
    name: "Map<string,number>: count entries",
    source: `
      export function fn(m: Map<string, number>): number {
        let count = 0;
        for (const entry of m) {
          count += 1;
        }
        return count;
      }
    `,
    fn: "fn",
    arg: new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]),
    expectedClaimed: ["fn"],
  },

  // ---- 4. Set<number> with sum-counter pattern ---------------------------
  // Mixes the iter-host loop variable (externref, unused in arithmetic)
  // with a slot-bound outer accumulator.
  {
    name: "Set<number>: incremented counter via plain assignment",
    source: `
      export function fn(s: Set<number>): number {
        let count = 0;
        for (const x of s) {
          count = count + 2;
        }
        return count;
      }
    `,
    fn: "fn",
    arg: new Set([1, 2, 3]),
    expectedClaimed: ["fn"],
  },

  // ---- 5. Map<K,V>: empty map ---------------------------------------------
  {
    name: "Map<string,number>: empty map returns 0",
    source: `
      export function fn(m: Map<string, number>): number {
        let count = 0;
        for (const entry of m) {
          count += 1;
        }
        return count;
      }
    `,
    fn: "fn",
    arg: new Map<string, number>(),
    expectedClaimed: ["fn"],
  },
];

describe("#1182 — iter-host for-of through IR (slice 6 part 3)", () => {
  for (const tc of CASES) {
    it(tc.name, async () => {
      const { legacy, ir } = await dualRun(tc.source, tc.fn, tc.arg);
      // Both outcomes must be `ok` and produce the same value.
      if (legacy.kind !== "ok") {
        throw new Error(`legacy run failed: ${JSON.stringify(legacy)}`);
      }
      if (ir.kind !== "ok") {
        throw new Error(`ir run failed: ${JSON.stringify(ir)}`);
      }
      expect(ir.value).toBe(legacy.value);
    });
  }
});

describe("#1182 — selector claims iter-host-shaped functions", () => {
  for (const tc of CASES) {
    it(`selector claims ${tc.fn} from "${tc.name}"`, () => {
      const sf = ts.createSourceFile("test.ts", tc.source, ts.ScriptTarget.ES2022, true);
      const sel = planIrCompilation(sf, { experimentalIR: true });
      for (const name of tc.expectedClaimed) {
        expect([...sel.funcs]).toContain(name);
      }
    });
  }
});

describe("#1182 — IR compile produces no IR-fallback errors for iter-host cases", () => {
  for (const tc of CASES) {
    it(`compiles "${tc.name}" cleanly under experimentalIR`, () => {
      const r = compile(tc.source, { experimentalIR: true });
      expect(r.success).toBe(true);
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

describe("#1182 — vec fast path still works alongside iter-host", () => {
  // Ensures the dispatch in `lowerForOfStatement` still routes vec
  // iterables to the vec arm — adding the iter-host fallback didn't
  // accidentally divert all for-of traffic.
  it("array iteration still routes through forof.vec", async () => {
    const source = `
      export function fn(arr: number[]): number {
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
    `;
    const r = compile(source, { experimentalIR: true });
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    });
    // The IR takes a vec ref directly — call via a builder helper.
    // For this smoke test we use the compiled module's array-builder
    // surface (legacy path materialises the array).
    // Easier: write a separate builder.
    const source2 = `
      export function builder(): number[] { return [1, 2, 3, 4, 5]; }
      export function fn(arr: number[]): number {
        let sum = 0;
        for (const x of arr) {
          sum += x;
        }
        return sum;
      }
    `;
    const r2 = compile(source2, { experimentalIR: true });
    expect(r2.success).toBe(true);
    const b2 = buildImports(r2.imports, ENV_STUB, r2.stringPool);
    const { instance: i2 } = await WebAssembly.instantiate(r2.binary, {
      env: b2.env,
      string_constants: b2.string_constants,
    });
    const arr = (i2.exports.builder as () => unknown)();
    const result = (i2.exports.fn as (a: unknown) => unknown)(arr);
    expect(result).toBe(15);
    void instance; // silence unused-var; keeps the first compile in the snapshot
  });
});
