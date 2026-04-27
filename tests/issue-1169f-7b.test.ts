// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169f slice 7b — IR Phase 4 generator widening.
//
// Builds on slice 7a (PR #70) which wired `function*` + numeric `yield`
// through the IR. Slice 7b extends the surface to:
//
//   1. **Non-numeric yield values** — strings, booleans, refs. The IR
//      `gen.push` lowerer dispatches on the operand's IrType:
//        - f64                → __gen_push_f64
//        - i32                → __gen_push_i32 (booleans)
//        - everything else    → coerce.to_externref → __gen_push_ref
//   2. **Bare `yield;`** — emits a null-externref const + gen.push,
//      matching legacy "yield with no value" semantics.
//   3. **`yield* <iterable>`** — coerces the iterable to externref and
//      emits the new `gen.yieldStar` IR instr (lowered to
//      `__gen_yield_star(buffer, iterable)`). The host helper drains
//      the inner iterable into the outer buffer via Symbol.iterator
//      (see `runtime.ts:2999`).
//
// Each test compiles the same source under `experimentalIR: false`
// (legacy) and `experimentalIR: true` (IR claims the `function*`)
// then drains the exported generator with `iter.next()` and asserts
// identical sequences. A separate "selector" suite verifies the IR
// actually CLAIMS the test function so a future regression that
// silently routes back to legacy would be caught.

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
 * Symbol.iterator), so explicit `.next()` works directly.
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
  /** Name of the exported generator entry point (zero-arg if no builder). */
  fn: string;
  /** Optional builder export for tests that need an array param. */
  builder?: { name: string };
  /** Expected yielded values, in order. */
  expectedYields: unknown[];
}

const CASES: Case[] = [
  // ---- 1. boolean (i32) yields ------------------------------------------
  //
  // Legacy emits __gen_push_i32(buf, 1|0); the host pushes the integer
  // value as-is into the buffer. Consumers see numeric 1/0, NOT JS
  // booleans (this is a known eager-buffer-model quirk — booleans
  // round-trip through Wasm as integers). Slice 7b mirrors legacy.
  {
    name: "boolean yields dispatch through __gen_push_i32",
    source: `
      export function* gen(): Generator<boolean> {
        yield true;
        yield false;
        yield true;
        return false;
      }
    `,
    expectedClaimed: ["gen"],
    fn: "gen",
    expectedYields: [1, 0, 1, 0],
  },

  // ---- 2. string (ref) yields ------------------------------------------
  //
  // Strings dispatch through __gen_push_ref. In host-strings mode the
  // value is already externref so the from-ast lowerer skips the
  // `extern.convert_any` coerce; in native-strings mode the AnyString
  // struct ref is converted via the slice-6-part-3 helper.
  {
    name: "string yields dispatch through __gen_push_ref",
    source: `
      export function* gen(): Generator<string> {
        yield "alpha";
        yield "beta";
        yield "gamma";
        return "end";
      }
    `,
    expectedClaimed: ["gen"],
    fn: "gen",
    expectedYields: ["alpha", "beta", "gamma", "end"],
  },

  // ---- 3. bare yield (no value) ----------------------------------------
  //
  // `yield;` lowers as gen.push of `ref.null.extern`. The host receives
  // a JS `null` from the wasm engine's externref-null marshalling (NOT
  // `undefined` — `ref.null.extern` round-trips through wasm-js-strings
  // engine plumbing as `null` per the WebAssembly spec). Legacy and IR
  // both produce this shape. Bare `return;` is allowed in generator
  // tail position (slice 7b widens the selector) and pushes no final
  // value — the buffer just terminates after the explicit yields.
  {
    name: "bare yield emits null externref",
    source: `
      export function* gen(): Generator<undefined> {
        yield;
        yield;
        return;
      }
    `,
    expectedClaimed: ["gen"],
    fn: "gen",
    expectedYields: [null, null],
  },

  // ---- 4. yield* delegation over another generator's output ------------
  //
  // The inner iterable must be a JS-iterable on the host side
  // (it's consumed by `__gen_yield_star`'s `for (const v of iterable)`
  // loop). Wasm vec values don't carry `[Symbol.iterator]` directly,
  // so we use a generator's externref Generator object — the runtime's
  // `__create_generator` shape includes Symbol.iterator. Both inner
  // and outer get IR-claimed (call-graph closure: outer calls inner;
  // inner has no callers; both are generator functions and thus
  // individually claimable).
  {
    name: "yield* delegation drains an inner iterable into the outer buffer",
    source: `
      export function* inner(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
        return 0;
      }
      export function* outer(): Generator<number> {
        yield 0;
        yield* inner();
        yield 99;
        return -1;
      }
    `,
    expectedClaimed: ["inner", "outer"],
    fn: "outer",
    // 0, then drained inner [1, 2, 3, 0 (inner's return)], then 99,
    // then -1 (outer's return). Legacy pushes inner's return value
    // because legacy's `return <expr>` semantics push to buffer; the
    // host's `__gen_yield_star` then drains all of those onto outer.
    expectedYields: [0, 1, 2, 3, 0, 99, -1],
  },

  // ---- 5. mixed (numeric + bool) yields in the same generator ----------
  {
    name: "mixed numeric and boolean yields — dispatch picks the right import per-yield",
    source: `
      export function* gen(): Generator<number | boolean> {
        yield 42;
        yield true;
        yield 7;
        yield false;
        return 0;
      }
    `,
    expectedClaimed: ["gen"],
    fn: "gen",
    expectedYields: [42, 1, 7, 0, 0],
  },
];

describe("#1169f slice 7b — generator IR widening (non-numeric + bare + yield*)", () => {
  describe("selector claims function* with extended yield shapes", () => {
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
