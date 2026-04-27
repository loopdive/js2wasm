// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1183 — IR Phase 4 Slice 6 part 4: string fast path through IR.
//
// Activates the third arm of `lowerForOfStatement`: `for (const c of
// <string>)`. In native-strings mode the loop lowers through the new
// `forof.string` declarative IR instr (counter loop with
// `__str_charAt`); in host-strings mode it falls through to the
// iter-host arm (#1182).
//
// Each test compiles the same source twice — once with the legacy
// path (`experimentalIR: false`) and once through the IR
// (`experimentalIR: true`) — and asserts the exported function returns
// the same value through both paths.
//
// Note: in nativeStrings mode the user function CANNOT take a `string`
// param directly from JS (the JS string isn't auto-coerced to a
// `(ref $AnyString)`). Tests for native-strings mode use a wrapper
// function that materialises the string literal inline. Host-strings
// mode tests can take the string as a param since the param IR type
// lowers to externref.

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

async function runOnce(
  source: string,
  fnName: string,
  experimentalIR: boolean,
  nativeStrings: boolean,
): Promise<Outcome> {
  const r = compile(source, { experimentalIR, nativeStrings });
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
    const fn = instance.exports[fnName] as () => unknown;
    return { kind: "ok", value: fn() };
  } catch (e: unknown) {
    return { kind: "invoke_fail", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function dualRun(
  source: string,
  fnName: string,
  nativeStrings: boolean,
): Promise<{ legacy: Outcome; ir: Outcome }> {
  const [legacy, ir] = await Promise.all([
    runOnce(source, fnName, false, nativeStrings),
    runOnce(source, fnName, true, nativeStrings),
  ]);
  return { legacy, ir };
}

interface Case {
  name: string;
  source: string;
  fn: string;
  /** Names of IR-claimable functions in the source. */
  expectedClaimed: string[];
  nativeStrings: boolean;
  /**
   * For native-strings cases, the legacy path has a pre-existing bug
   * that produces invalid Wasm for `for (const c of s)` (the captured
   * `__str_charAt` funcIdx becomes stale after late-import shifts —
   * tracked separately, out of scope for #1183). Assert against an
   * expected JS-computed value instead of dual-running. The IR path
   * fixes the bug for itself by re-resolving by name in
   * `resolver.resolveFunc` (see `src/ir/integration.ts`).
   */
  expectedValue: number;
}

// Native-strings cases — string is a literal inside the function body
// so we don't need to pass a string from JS.
const NATIVE_CASES: Case[] = [
  // ---- 1. count chars in a 5-char string --------------------------------
  {
    name: "native: count chars in 'hello' (5 chars)",
    source: `
      export function fn(): number {
        const s = "hello";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedClaimed: ["fn"],
    nativeStrings: true,
    expectedValue: 5,
  },

  // ---- 2. empty string ---------------------------------------------------
  {
    name: "native: empty string returns 0",
    source: `
      export function fn(): number {
        const s = "";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedClaimed: ["fn"],
    nativeStrings: true,
    expectedValue: 0,
  },

  // ---- 3. single-char string ---------------------------------------------
  {
    name: "native: single-char string",
    source: `
      export function fn(): number {
        const s = "z";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedClaimed: ["fn"],
    nativeStrings: true,
    expectedValue: 1,
  },

  // ---- 4. compound assignment in body ------------------------------------
  {
    name: "native: count chars via compound assignment",
    source: `
      export function fn(): number {
        const s = "abcdef";
        let count = 0;
        for (const c of s) {
          count += 2;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedClaimed: ["fn"],
    nativeStrings: true,
    expectedValue: 12,
  },

  // ---- 5. BMP unicode (counts code units) --------------------------------
  {
    name: "native: count code units in 'café' (4 BMP units)",
    source: `
      export function fn(): number {
        const s = "café";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedClaimed: ["fn"],
    nativeStrings: true,
    expectedValue: 4,
  },
];

// Host-strings case: falls through to iter-host. The legacy path also
// works here, so we keep dual-run (legacy↔IR equivalence).
const HOST_CASES: Case[] = [
  {
    name: "host: count chars (falls through to iter-host)",
    source: `
      export function fn(): number {
        const s = "hello";
        let count = 0;
        for (const c of s) {
          count = count + 1;
        }
        return count;
      }
    `,
    fn: "fn",
    expectedClaimed: ["fn"],
    nativeStrings: false,
    expectedValue: 5,
  },
];

describe("#1183 — string for-of through IR (slice 6 part 4) — native mode", () => {
  // Legacy path has a pre-existing bug in nativeStrings mode for string
  // for-of (stale `__str_charAt` funcIdx after late-import shifts). The
  // IR path resolves funcref names by walking `ctx.mod.functions`, which
  // is post-shift safe. So we only assert IR output against a known
  // expected value here, not dual-run.
  for (const tc of NATIVE_CASES) {
    it(tc.name, async () => {
      const ir = await runOnce(tc.source, tc.fn, true, tc.nativeStrings);
      if (ir.kind !== "ok") {
        throw new Error(`ir run failed: ${JSON.stringify(ir)}`);
      }
      expect(ir.value).toBe(tc.expectedValue);
    });
  }
});

describe("#1183 — string for-of through IR (slice 6 part 4) — host-strings fall-through", () => {
  for (const tc of HOST_CASES) {
    it(tc.name, async () => {
      const { legacy, ir } = await dualRun(tc.source, tc.fn, tc.nativeStrings);
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

describe("#1183 — selector claims string-for-of-shaped functions", () => {
  for (const tc of [...NATIVE_CASES, ...HOST_CASES]) {
    it(`selector claims ${tc.fn} from "${tc.name}"`, () => {
      const sf = ts.createSourceFile("test.ts", tc.source, ts.ScriptTarget.ES2022, true);
      const sel = planIrCompilation(sf, { experimentalIR: true });
      for (const name of tc.expectedClaimed) {
        expect([...sel.funcs]).toContain(name);
      }
    });
  }
});

describe("#1183 — IR compile produces no IR-fallback errors", () => {
  for (const tc of [...NATIVE_CASES, ...HOST_CASES]) {
    it(`compiles "${tc.name}" cleanly under experimentalIR`, () => {
      const r = compile(tc.source, { experimentalIR: true, nativeStrings: tc.nativeStrings });
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

describe("#1183 — vec / iter-host arms still work alongside string arm", () => {
  it("array iteration still routes through forof.vec", async () => {
    const source = `
      export function builder(): number[] { return [1, 2, 3, 4, 5]; }
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
    const arr = (instance.exports.builder as () => unknown)();
    const result = (instance.exports.fn as (a: unknown) => unknown)(arr);
    expect(result).toBe(15);
  });

  it("Set iteration still routes through forof.iter (host iterator protocol)", async () => {
    const source = `
      export function fn(s: Set<number>): number {
        let count = 0;
        for (const x of s) {
          count = count + 1;
        }
        return count;
      }
    `;
    const r = compile(source, { experimentalIR: true });
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, {
      env: built.env,
      string_constants: built.string_constants,
    });
    const result = (instance.exports.fn as (a: unknown) => unknown)(new Set([1, 2, 3]));
    expect(result).toBe(3);
  });
});
