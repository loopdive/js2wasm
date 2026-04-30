// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Equivalence test for #1169l (IR Phase 4 Slice 10 step D — Error
// classes through IR).
//
// Coverage:
//   - `new Error("msg")` construction.
//   - `new TypeError("msg")` and other Error subclasses.
//   - `e.message` property read.
//   - Composition with slice 9 (`throw new Error(...)` round-trip).
//
// All Error subclasses (TypeError, RangeError, SyntaxError,
// ReferenceError, URIError, EvalError) are in `KNOWN_EXTERN_CLASSES`
// from #1169i.

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

describe("IR slice 10 — Error classes through IR (#1169l, step D)", () => {
  it("(a) new Error('msg').message returns the message string", async () => {
    const source = `
      export function run(): string {
        const e = new Error("oops");
        return e.message;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe("oops");
    expect(legacyResult).toBe("oops");
  });

  it("(b) new TypeError('msg').message returns the message string", async () => {
    const source = `
      export function run(): string {
        const e = new TypeError("bad type");
        return e.message;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe("bad type");
    expect(legacyResult).toBe("bad type");
  });

  it("(c) new RangeError('msg').message returns the message string", async () => {
    const source = `
      export function run(): string {
        const e = new RangeError("out of range");
        return e.message;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe("out of range");
    expect(legacyResult).toBe("out of range");
  });

  it("(d) new Error() with no arg returns empty message", async () => {
    const source = `
      export function run(): string {
        const e = new Error();
        return e.message;
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe("");
    expect(legacyResult).toBe("");
  });

  it("(e) try { throw new Error('m') } catch (e) { return e.message } — composition with slice 9", async () => {
    const source = `
      export function run(): string {
        try {
          throw new Error("caught");
        } catch (e: any) {
          return e.message;
        }
      }
    `;
    const irResult = await compileAndRun(source, "run", [], true);
    const legacyResult = await compileAndRun(source, "run", [], false);
    expect(irResult).toBe("caught");
    expect(legacyResult).toBe("caught");
  });
});
