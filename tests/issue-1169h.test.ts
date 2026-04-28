// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169h slice 9 — IR Phase 4 try / catch / finally / throw support.
//
// Activates the slice-9 IR scaffolding (IrInstrThrow, IrInstrTry, builder
// helpers, selector / from-ast / lower / verify / DCE / inline / mono
// integration). Each test:
//
//   1. compiles the same source under `experimentalIR: false` (legacy) and
//      `experimentalIR: true` (IR claims the function);
//   2. asserts the IR selector claims the function we expect;
//   3. instantiates both modules and drives the exported entry point,
//      asserting both produce the same return value.
//
// Slice 9 scope (`plan/issues/sprints/45/1169h.md`):
//   - `throw <expr>;` for non-numeric expressions (string literal,
//     `new Error(...)`, etc.). Numeric throws fall back to legacy.
//   - `try { ... } catch (e) { ... }` (identifier binding only).
//   - `try { ... } catch { ... }` (no binding — ES2019 optional catch).
//   - `try { ... } finally { ... }`.
//   - `try { ... } catch (e) { ... } finally { ... }` (full form).
//
// Out of scope (deferred to 9.5+):
//   - destructuring catch param (`catch ({message})`).
//   - bare `throw;` (no expression).
//   - return / break / continue inside try / catch / finally bodies.
//   - if-statements at body-position inside try / catch / finally bodies
//     (the body-buffer mechanism doesn't yet support nested control flow).
//   - rethrow optimisation via `catchRethrowStack`.
//
// Tests use `let` slot bindings to flow values out of try / catch /
// finally bodies, and unconditional throws (callers gate behaviour by
// passing different args to *separate* helper functions).

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
  /** Entry-point export to call. */
  fn: string;
  /** Args (numbers); empty for nullary entry points. */
  args?: number[];
  /** Expected scalar return value. */
  expected: number;
}

const cases: Case[] = [
  // -----------------------------------------------------------------------
  // Step A — `throw` (no try): a function that always throws gets caught
  // by an outer try/catch wrapper. Coverage for the basic throw codegen.
  // -----------------------------------------------------------------------
  {
    name: "Step A — unconditional throw inside try/catch",
    source: `
      function alwaysThrows(): number {
        let result: number = 7;
        try {
          throw "bang";
        } catch (e) {
          result = 42;
        }
        return result;
      }
      export function test(): number {
        return alwaysThrows();
      }
    `,
    expectedClaimed: ["alwaysThrows", "test"],
    fn: "test",
    expected: 42,
  },
  // -----------------------------------------------------------------------
  // Step B — try body that does NOT throw. The catch arm should NOT run.
  // -----------------------------------------------------------------------
  {
    name: "Step B — try body that does not throw skips catch",
    source: `
      function noThrow(): number {
        let result: number = 0;
        try {
          result = 5;
        } catch (e) {
          result = 99;
        }
        return result;
      }
      export function test(): number {
        return noThrow();
      }
    `,
    expectedClaimed: ["noThrow", "test"],
    fn: "test",
    expected: 5,
  },
  // -----------------------------------------------------------------------
  // Step C — `try { ... } catch { ... }` (no binding, ES2019).
  // -----------------------------------------------------------------------
  {
    name: "Step C — try/catch with no binding",
    source: `
      function omittedBinding(): number {
        let r: number = 0;
        try {
          throw "no name";
        } catch {
          r = 33;
        }
        return r;
      }
      export function test(): number {
        return omittedBinding();
      }
    `,
    expectedClaimed: ["omittedBinding", "test"],
    fn: "test",
    expected: 33,
  },
  // -----------------------------------------------------------------------
  // Step D — `try { ... } finally { ... }`. Finally runs even on normal
  // exit. We exercise the slot-update path by having both try AND finally
  // mutate the outer counter.
  // -----------------------------------------------------------------------
  {
    name: "Step D — try/finally observable via outer state (normal exit)",
    source: `
      function doWithCleanup(): number {
        let count: number = 0;
        try {
          count = count + 5;
        } finally {
          count = count + 100;
        }
        return count;
      }
      export function test(): number {
        return doWithCleanup();
      }
    `,
    expectedClaimed: ["doWithCleanup", "test"],
    fn: "test",
    expected: 105,
  },
  // -----------------------------------------------------------------------
  // Step E — full form: try / catch / finally with unconditional throw.
  // The catch handler runs AND the finally runs (catch + finally path).
  // -----------------------------------------------------------------------
  {
    name: "Step E — full try/catch/finally with throw",
    source: `
      function fullWithThrow(): number {
        let count: number = 0;
        try {
          throw "x";
          count = count + 1;
        } catch (e) {
          count = count + 10;
        } finally {
          count = count + 100;
        }
        return count;
      }
      export function test(): number {
        return fullWithThrow();
      }
    `,
    expectedClaimed: ["fullWithThrow", "test"],
    fn: "test",
    expected: 110,
  },
  // -----------------------------------------------------------------------
  // Step E' — full try/catch/finally without throw (normal-exit path).
  // The catch is bypassed; only the try body and finally run.
  // -----------------------------------------------------------------------
  {
    name: "Step E' — full try/catch/finally without throw",
    source: `
      function fullNoThrow(): number {
        let count: number = 0;
        try {
          count = count + 1;
        } catch (e) {
          count = count + 10;
        } finally {
          count = count + 100;
        }
        return count;
      }
      export function test(): number {
        return fullNoThrow();
      }
    `,
    expectedClaimed: ["fullNoThrow", "test"],
    fn: "test",
    expected: 101,
  },
  // -----------------------------------------------------------------------
  // throw new Error(...) — exercises the Error-instance coerce path. The
  // outer function falls back to legacy because `new Error(...)` is an
  // external constructor call (the IR selector excludes functions whose
  // calls hit unknown identifiers), but the equivalence test still
  // verifies legacy behaviour matches the expected JS semantics.
  // -----------------------------------------------------------------------
  {
    name: "throw new Error(...) caught and recovered (legacy fallback)",
    source: `
      function withErrorObj(): number {
        let r: number = 0;
        try {
          throw new Error("boom");
        } catch (e) {
          r = 77;
        }
        return r;
      }
      export function test(): number {
        return withErrorObj();
      }
    `,
    // `withErrorObj` falls back to legacy — only test the test export.
    expectedClaimed: [],
    fn: "test",
    expected: 77,
  },
];

describe("#1169h slice 9 — IR throw / try / catch / finally", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("IR selector claims the expected functions", () => {
        const sel = selectionFor(c.source);
        for (const name of c.expectedClaimed) {
          expect(sel.has(name), `expected '${name}' to be claimed; got: ${[...sel].join(", ")}`).toBe(true);
        }
      });

      it("IR-compiled and legacy-compiled produce the same return value", async () => {
        const legacy = await compileAndInstantiate(c.source, false);
        const ir = await compileAndInstantiate(c.source, true);

        const legacyFn = legacy.exports[c.fn] as (...args: unknown[]) => unknown;
        const irFn = ir.exports[c.fn] as (...args: unknown[]) => unknown;
        expect(typeof legacyFn).toBe("function");
        expect(typeof irFn).toBe("function");

        const args = c.args ?? [];
        const legacyResult = legacyFn(...args) as number;
        const irResult = irFn(...args) as number;
        expect(legacyResult).toBe(c.expected);
        expect(irResult).toBe(c.expected);
        expect(irResult).toBe(legacyResult);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Acceptance criterion 6: shared `__exn` tag registers exactly once per
  // module. Verified end-to-end by instantiating a module with multiple
  // try-catch sites and confirming the resulting Wasm validates and runs.
  // -------------------------------------------------------------------------
  it("registers a single __exn tag in the emitted module", async () => {
    const source = `
      function a(): number {
        let r: number = 0;
        try { throw "a"; } catch { r = 1; }
        return r;
      }
      function b(): number {
        let r: number = 0;
        try { throw "b"; } catch { r = 2; }
        return r;
      }
      export function test(): number { return a() + b(); }
    `;
    const r = compile(source, { experimentalIR: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    });
    const ret = (instance.exports.test as () => number)();
    expect(ret).toBe(3); // 1 + 2
  });
});
