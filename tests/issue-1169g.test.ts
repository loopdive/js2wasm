// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169g — IR Phase 4 Slice 8a: destructuring + spread (compile-time
// rewrite subset).
//
// Slice 8a covers the cases that decompose to existing IR primitives at
// compile time WITHOUT new runtime helpers:
//
//   - `const { a, b } = obj` / `const { a: x } = obj` — object pattern,
//     identifier-leaf only, no rest, no defaults, no nesting. Lowers
//     to one `object.get` per leaf.
//   - `const [x, y] = arr`                              — array pattern,
//     identifier-leaf only, no rest, no defaults, no nesting. Source
//     must be a vec ref (`Array<number>` etc.). Lowers to one `vec.get`
//     per leaf.
//   - `f(...[1, 2, 3])`                                  — call args spread
//     where the spread source is an ArrayLiteralExpression with no
//     nested spread. Lowers to one direct argument per literal element.
//
// Wider shapes (rest collection, object spread, defaults, nested
// patterns, dynamic-length spread) are deferred to slice 8b/8.5+ — the
// selector rejects them and the function falls back to legacy.
//
// The dual-run harness compiles every source twice (legacy + IR) and
// asserts identical results so any miscompile inside slice-8a lowering
// surfaces as a failed parity check rather than corrupting test262.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "compile_fail"; firstMessage: string }
  | { kind: "instantiate_fail" }
  | { kind: "invoke_fail" };

async function runOnce(
  source: string,
  fnName: string,
  args: ReadonlyArray<number | boolean | string>,
  experimentalIR: boolean,
): Promise<Outcome> {
  const r = compile(source, { experimentalIR });
  if (!r.success) {
    return { kind: "compile_fail", firstMessage: r.errors[0]?.message ?? "" };
  }
  let instance: WebAssembly.Instance;
  try {
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    // Use the production instantiator so wasm:js-string builtins resolve
    // — bare `WebAssembly.instantiate` doesn't supply the polyfill and
    // any test that returns a string-typed value (or destructures one)
    // would otherwise spuriously fail with an Import error.
    ({ instance } = await instantiateWasm(r.binary, built.env, built.string_constants));
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
  args: ReadonlyArray<number | boolean | string>,
): Promise<{ legacy: Outcome; ir: Outcome }> {
  const [legacy, ir] = await Promise.all([runOnce(source, fnName, args, false), runOnce(source, fnName, args, true)]);
  return { legacy, ir };
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

interface Case {
  name: string;
  source: string;
  fn: string;
  args: ReadonlyArray<number | boolean | string>;
  /** Names the IR selector should claim under `experimentalIR: true`. */
  expectedClaimed?: string[];
  /**
   * Expected return value for the IR path. Slice 8a's spread-call lowering
   * actually correctly handles cases where the existing legacy spread path
   * has a longstanding instantiation bug (`f(...[1,2,3])` validates as
   * "not enough arguments on the stack"). For those cases we don't assert
   * legacy parity — instead we assert the IR produces the correct value.
   */
  expectedValue: number;
  /**
   * If set to false, skip the legacy parity check. Used for spread-call
   * cases where the legacy path has a pre-existing instantiate bug that
   * slice 8a's IR widening sidesteps. The IR's correctness is still
   * verified via the absolute `expectedValue` check above.
   */
  parity?: boolean;
}

const CASES: Case[] = [
  // -------------------------------------------------------------------------
  // Step A: object destructuring — shorthand, renamed, multi-field
  // -------------------------------------------------------------------------
  {
    name: "object destructuring — shorthand single field",
    source: `
      export function f(): number {
        const o = { x: 42 };
        const { x } = o;
        return x;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 42,
  },
  {
    name: "object destructuring — two fields summed",
    source: `
      export function f(): number {
        const o = { a: 5, b: 7 };
        const { a, b } = o;
        return a + b;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 12,
  },
  {
    name: "object destructuring — renamed property",
    source: `
      export function f(): number {
        const o = { a: 99, b: 1 };
        const { a: x } = o;
        return x;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 99,
  },
  {
    name: "object destructuring — mixed shorthand and renamed",
    source: `
      export function f(): number {
        const o = { foo: 10, bar: 20 };
        const { foo, bar: y } = o;
        return foo + y;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 30,
  },
  {
    name: "object destructuring — composes with slice-1 string ops",
    source: `
      export function f(): number {
        const o = { greeting: "hello" };
        const { greeting } = o;
        return greeting.length;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 5,
  },

  // -------------------------------------------------------------------------
  // Step B: array destructuring from vec
  // -------------------------------------------------------------------------
  {
    name: "array destructuring — first two elements",
    source: `
      export function f(arr: Array<number>): number {
        const [x, y] = arr;
        return x + y;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 30,
  },
  {
    name: "array destructuring — three elements",
    source: `
      export function f(arr: Array<number>): number {
        const [a, b, c] = arr;
        return a + b + c;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 6,
  },
  {
    name: "array destructuring — sparse (omitted slot)",
    source: `
      export function f(arr: Array<number>): number {
        const [a, , c] = arr;
        return a + c;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 150,
  },
  {
    name: "array destructuring — single binding",
    source: `
      export function f(arr: Array<number>): number {
        const [head] = arr;
        return head;
      }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f"],
    expectedValue: 42,
  },

  // -------------------------------------------------------------------------
  // Step C: spread in call args (static array literal)
  // -------------------------------------------------------------------------
  {
    name: "spread call args — single spread of literal",
    source: `
      function add3(a: number, b: number, c: number): number { return a + b + c; }
      export function f(): number { return add3(...[1, 2, 3]); }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f", "add3"],
    expectedValue: 6,
    parity: false, // legacy has a pre-existing instantiate bug for this shape
  },
  {
    name: "spread call args — mixed leading + spread",
    source: `
      function sum4(a: number, b: number, c: number, d: number): number {
        return a + b + c + d;
      }
      export function f(): number { return sum4(10, ...[1, 2, 3]); }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f", "sum4"],
    expectedValue: 16,
    parity: false,
  },
  {
    name: "spread call args — multiple spreads concatenated",
    source: `
      function add4(a: number, b: number, c: number, d: number): number {
        return a + b + c + d;
      }
      export function f(): number { return add4(...[1, 2], ...[3, 4]); }
    `,
    fn: "f",
    args: [],
    expectedClaimed: ["f", "add4"],
    expectedValue: 10,
    parity: false,
  },
];

// Cases that exercise vec destructuring need an actual array passed in.
// Drive them through a JS array (the host marshalling boundary handles
// the externref-to-vec coercion via the runtime's `__JsArray_to_vec_*`
// path on entry).
const ARRAY_INPUT_CASES = new Map<string, ReadonlyArray<number>>([
  ["array destructuring — first two elements", [10, 20]],
  ["array destructuring — three elements", [1, 2, 3]],
  ["array destructuring — sparse (omitted slot)", [100, 999, 50]],
  ["array destructuring — single binding", [42]],
]);

describe("#1169g — IR slice 8a destructuring + spread", () => {
  describe("selector claims slice-8a function shapes", () => {
    for (const tc of CASES) {
      if (!tc.expectedClaimed) continue;
      it(`claims [${tc.expectedClaimed.join(", ")}]: ${tc.name}`, () => {
        const claimed = selectionFor(tc.source);
        for (const name of tc.expectedClaimed) {
          expect(claimed.has(name), `selector should claim ${name}; claimed = ${[...claimed].join(",")}`).toBe(true);
        }
      });
    }
  });

  describe("IR path produces correct values (and matches legacy when parity expected)", () => {
    for (const tc of CASES) {
      it(tc.name, async () => {
        // Tests that take an array param need a proxy: wrap the function
        // under test in a `__driver` that constructs the array literal
        // inline. For slice 8a the array tests pass the input through a
        // builder helper because vitest can't marshal an `Array<number>`
        // param directly across the wasm boundary.
        const arrInput = ARRAY_INPUT_CASES.get(tc.name);
        let source = tc.source;
        let fnName = tc.fn;
        let callArgs: ReadonlyArray<number | boolean | string> = tc.args;
        if (arrInput) {
          const literal = `[${arrInput.join(", ")}]`;
          source = `
            ${tc.source}
            export function __driver(): number { return f(${literal}); }
          `;
          fnName = "__driver";
          callArgs = [];
        }
        const { legacy, ir } = await dualRun(source, fnName, callArgs);
        // IR must always produce the correct value.
        expect(ir).toStrictEqual({ kind: "ok", value: tc.expectedValue });
        // Legacy parity: only assert when the case opts in (most cases).
        // Spread-of-literal call args have a pre-existing legacy bug
        // ("not enough arguments on the stack" wasm validation error)
        // that slice 8a's IR widening sidesteps — the IR's correctness
        // is verified by the absolute check above.
        if (tc.parity !== false) {
          expect(ir).toStrictEqual(legacy);
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage / no-fallback assertions
//
// Every slice-8a source compiles under `experimentalIR: true` without
// emitting an "IR path failed" diagnostic — i.e. the IR didn't silently
// fall through to legacy.
// ---------------------------------------------------------------------------

describe("#1169g — slice 8a functions reach the IR path without errors", () => {
  for (const tc of CASES) {
    if (!tc.expectedClaimed) continue;
    it(`no IR-path errors: ${tc.name}`, () => {
      const r = compile(tc.source, { experimentalIR: true });
      expect(r.success).toBe(true);
      const irErrors = r.errors.filter(
        (e) => e.message.startsWith("IR path failed") || e.message.startsWith("IR path: could not resolve"),
      );
      expect(irErrors).toEqual([]);
    });
  }
});
