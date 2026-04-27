// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169f slice 7a — IR Phase 4 generator-function support (numeric yield).
//
// Activates the generator-IR scaffolding shipped earlier in the slice
// (gen.push / gen.epilogue IR nodes, IrFunctionBuilder generator
// helpers, addGeneratorImports extraction in PR #65). Each test:
//
//   1. compiles the same source under `experimentalIR: false` (legacy)
//      and `experimentalIR: true` (IR claims the `function*`);
//   2. asserts the IR selector claims the generator(s) we expect;
//   3. instantiates both modules and drives the exported generator
//      with `gen.next()` until exhaustion, asserting the same
//      sequence of values comes out of both.
//
// Slice 7a scope (mirror of `plan/issues/sprints/45/1169f.md`):
//   - `function* g() { yield 1; yield 2; ...; return <num>; }` —
//     sequential numeric yields followed by an explicit numeric tail
//     return. The selector requires a tail return because Phase 1's
//     statement-list shape mandates it; legacy semantics (matched by
//     slice 7a) push the return value onto the eager buffer as a
//     final `done:false` value, so the test sequences include the
//     return literal as the last yielded number.
//   - `function* g(arr: number[]) { for (const x of arr) yield <expr>;
//     return 0; }` — yield inside a slice-6 vec for-of body. The
//     for-of body's `lowerStmt` dispatcher accepts a yield-statement
//     just like the top-level statement list.
//
// Out of scope (defers to 7b/7c):
//   - bare `yield;` (no value), `yield* <iterable>`,
//   - non-numeric yields (string, bool, ref),
//   - generators with no explicit `return` tail.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface InstantiateResult {
  instance: WebAssembly.Instance;
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string, experimentalIR: boolean): Promise<InstantiateResult> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return { instance, exports: instance.exports as Record<string, unknown> };
}

/**
 * Drive a JS-iterator-shaped object through `.next()` until done; collect
 * the yielded values. The returned generator object from a wasm export
 * uses the runtime's `__create_generator` shape (next / return / throw /
 * Symbol.iterator) — `for...of` works directly, but explicit `.next()`
 * gives finer error reporting when a test fails.
 */
function drain(it: { next: () => { value: unknown; done: boolean } }): unknown[] {
  const out: unknown[] = [];
  for (let step = 0; step < 1024; step++) {
    const r = it.next();
    if (r.done) return out;
    out.push(r.value);
  }
  throw new Error("drain: generator exceeded 1024 yields (likely infinite loop)");
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

interface Case {
  name: string;
  source: string;
  /** Names the IR selector should claim under `experimentalIR: true`. */
  expectedClaimed: string[];
  /** Name of the exported generator entry point. */
  fn: string;
  /**
   * Optional builder export name + an array argument generator. When
   * present, the test calls `builder()` to get the input array and
   * passes it as the only arg to `fn`. Used for the for-of variants.
   */
  builder?: { name: string; expect: number[] };
  /** Expected yielded values, in order. */
  expectedYields: number[];
}

const CASES: Case[] = [
  // ---- 1. simple sequential yields ---------------------------------------
  {
    name: "simple yield sequence (3 numeric yields + return)",
    source: `
      export function* gen(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
        return 0;
      }
    `,
    expectedClaimed: ["gen"],
    fn: "gen",
    // Legacy generators push the return value onto the eager buffer
    // as a final yielded value (control-flow.ts:89-123). Slice 7a
    // mirrors this so consumers see identical sequences.
    expectedYields: [1, 2, 3, 0],
  },

  // ---- 2. arithmetic in the yield expression -----------------------------
  {
    name: "yield with arithmetic operands",
    source: `
      export function* compute(): Generator<number> {
        yield 2 + 3;
        yield 4 * 5;
        yield 10 - 7;
        return 99;
      }
    `,
    expectedClaimed: ["compute"],
    fn: "compute",
    expectedYields: [5, 20, 3, 99],
  },

  // ---- 3. for-of over a vec, yielding doubled values --------------------
  {
    name: "yield inside for-of body (doubled values)",
    source: `
      export function builder(): number[] { return [10, 20, 30]; }
      export function* doubled(arr: number[]): Generator<number> {
        for (const x of arr) yield x * 2;
        return -1;
      }
    `,
    expectedClaimed: ["doubled"],
    fn: "doubled",
    builder: { name: "builder", expect: [10, 20, 30] },
    expectedYields: [20, 40, 60, -1],
  },
];

describe("#1169f slice 7a — generator IR (numeric yield)", () => {
  describe("selector claims function* declarations", () => {
    for (const tc of CASES) {
      it(`claims [${tc.expectedClaimed.join(", ")}] in: ${tc.name}`, () => {
        const claimed = selectionFor(tc.source);
        for (const name of tc.expectedClaimed) {
          expect(claimed.has(name), `selector should claim ${name}; claimed = ${[...claimed].join(",")}`).toBe(true);
        }
      });
    }
  });

  describe("legacy and IR paths produce the same yield sequence", () => {
    for (const tc of CASES) {
      it(tc.name, async () => {
        const [legacy, ir] = await Promise.all([
          compileAndInstantiate(tc.source, false),
          compileAndInstantiate(tc.source, true),
        ]);

        const drive = (mod: InstantiateResult): unknown[] => {
          let arg: unknown = undefined;
          if (tc.builder) {
            const builder = mod.exports[tc.builder.name] as () => unknown;
            arg = builder();
          }
          const fn = mod.exports[tc.fn] as ((arg?: unknown) => unknown) | (() => unknown);
          const it = (tc.builder ? (fn as (a: unknown) => unknown)(arg) : (fn as () => unknown)()) as {
            next: () => { value: unknown; done: boolean };
          };
          return drain(it);
        };

        const legacyValues = drive(legacy);
        const irValues = drive(ir);
        expect(legacyValues).toEqual(tc.expectedYields);
        expect(irValues).toEqual(tc.expectedYields);
        expect(irValues).toEqual(legacyValues);
      });
    }
  });
});
