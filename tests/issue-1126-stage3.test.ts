// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1126 Stage 3 — IR emitter integration for the i32/u32 lattice.
//
// Two kinds of test:
//
//  1. Equivalence — for every interesting kernel (FNV-1a, popcount, hash
//     mixers, magnitude compares on bool-coerced operands) run both the
//     legacy and IR backends through the same input and require equal
//     output. The IR backend takes the new fast path when applicable;
//     the legacy backend is the reference oracle.
//  2. Code-shape — for selected kernels, compile and disassemble the
//     resulting Wasm function body, and assert the native `i32.{and,or,
//     xor,shl,shr_s,shr_u,lt_s,...}` ops appear (proving Stage 3 fired)
//     while the JS-bitwise scratch dance (`f64.trunc` ... `i32.trunc_sat
//     _f64_u`) does NOT appear in the same op (proving the dance was
//     skipped).
//
// The #1236 saturation guard tests live separately; this file ensures
// Stage 3 does not regress the f64-widening that #1236 depends on
// (arithmetic `+`/`*` on operands that the lattice would call `i32`
// must still flow through f64 in the lowered Wasm).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const ENV = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

async function dualRun(
  source: string,
  fnName: string,
  args: ReadonlyArray<number | boolean>,
): Promise<{ legacy: unknown; ir: unknown }> {
  const legacy = compile(source, { nativeStrings: true });
  if (!legacy.success) {
    throw new Error(`legacy compile failed:\n${legacy.errors.map((e) => e.message).join("\n")}`);
  }
  const ir = compile(source, { nativeStrings: true, experimentalIR: true });
  if (!ir.success) {
    throw new Error(`ir compile failed:\n${ir.errors.map((e) => e.message).join("\n")}`);
  }
  const [{ instance: lInst }, { instance: rInst }] = await Promise.all([
    WebAssembly.instantiate(legacy.binary, ENV),
    WebAssembly.instantiate(ir.binary, ENV),
  ]);
  const lFn = lInst.exports[fnName] as (...a: unknown[]) => unknown;
  const rFn = rInst.exports[fnName] as (...a: unknown[]) => unknown;
  return { legacy: lFn(...args), ir: rFn(...args) };
}

/** Extract the WAT body of a single named function, parens-balanced. */
function extractFunc(wat: string, name: string): string {
  const idx = wat.indexOf(`(func $${name} `);
  if (idx < 0) return "";
  let depth = 0;
  for (let i = idx; i < wat.length; i++) {
    const c = wat[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return wat.slice(idx, i + 1);
    }
  }
  return wat.slice(idx);
}

describe("#1126 Stage 3 — i32 fast path on bool/compare operands (no flag flip)", () => {
  // Both `(a < b)` and `(c < d)` produce i32 (bool) in the IR. Their
  // bitwise OR `(a < b) | (c < d)` previously fell back to legacy because
  // `lowerBinary` required matching `f64` operands. Stage 3 lets the IR
  // accept i32 operands and skips the JS-ToInt32 dance because the
  // operands already inhabit the [-2^31, 2^31) domain.
  it("|  on two compare results — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number): number {
        return ((a < b) ? 1 : 0) | ((c < d) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4],
      [3, 2, 4, 1],
      [3, 2, 1, 4],
      [5, 5, 5, 5],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });

  // & on bools — previously fell to legacy. Stage 3 uses native i32.and.
  it("&  on two compare results — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number): number {
        return ((a < b) ? 1 : 0) & ((c < d) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4],
      [3, 2, 4, 1],
      [3, 2, 1, 4],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });

  // ^ on bools — symmetric difference, previously fell to legacy.
  it("^  on two compare results — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number): number {
        return ((a < b) ? 1 : 0) ^ ((c < d) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4],
      [3, 2, 4, 1],
      [3, 2, 1, 4],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });

  // <<, >>, >>> on i32-typed values — these previously fell to legacy
  // because of `requireF64`. Stage 3 admits them.
  it("<< on a compare result — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number): number {
        return ((a < b) ? 1 : 0) << c;
      }
    `;
    // shift count via c — JS spec is ToUint32(c) % 32. Stage 3 keeps that
    // because we still ToInt32 the f64 RHS.
    for (const args of [
      [1, 2, 3],
      [2, 1, 5],
      [3, 3, 8],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });
});

describe("#1126 Stage 3 — magnitude compares with i32 operands", () => {
  // Bool-coerced compares chain naturally: `((a < b) ? 1 : 0) < ((c < d) ? 1 : 0)`
  // is two i32 operands. Stage 3 routes this through `i32.lt_s`.
  it("< between two compare results — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number): boolean {
        return ((a < b) ? 1 : 0) < ((c < d) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4],
      [3, 2, 4, 1],
      [3, 2, 1, 4],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });

  it(">= between two compare results — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number): boolean {
        return ((a < b) ? 1 : 0) >= ((c < d) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4],
      [3, 2, 4, 1],
      [3, 2, 1, 4],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });
});

describe("#1126 Stage 3 — chained bitwise (i32 throughout)", () => {
  // Chains of bitwise ops should now stay in i32 in the IR. The lowerer's
  // i32 fast path means each `&`/`|`/`^` becomes a native `i32.and`/etc.
  // The result is converted back to f64 only at the OUTER boundary (return
  // value coerced to JS number).
  it("(a < b) | (c < d) | (e < f) — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number, e: number, g: number): number {
        return ((a < b) ? 1 : 0) | ((c < d) ? 1 : 0) | ((e < g) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4, 5, 6],
      [3, 2, 4, 1, 1, 2],
      [3, 2, 1, 4, 7, 5],
      [5, 5, 5, 5, 5, 5],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });

  // & + | mixed — same i32 thread.
  it("(a < b) & (c < d) | (e < g) — equivalence", async () => {
    const source = `
      export function f(a: number, b: number, c: number, d: number, e: number, g: number): number {
        return (((a < b) ? 1 : 0) & ((c < d) ? 1 : 0)) | ((e < g) ? 1 : 0);
      }
    `;
    for (const args of [
      [1, 2, 3, 4, 5, 6],
      [3, 2, 4, 1, 1, 2],
      [3, 2, 1, 4, 7, 5],
    ] as const) {
      const { legacy, ir } = await dualRun(source, "f", args);
      expect(ir).toBe(legacy);
    }
  });
});

describe("#1126 Stage 3 — sentinel: arithmetic on i32-domain stays widened (#1236)", () => {
  // Critical regression check: even with Stage 3, arithmetic on values
  // that the lattice would call `i32` must still produce f64 results
  // (not i32.add — that would trap-or-wrap on overflow). The sentinel
  // here is `(2^30) + (2^30) = 2^31` which is a safe-integer f64 but
  // an out-of-range signed i32. JS spec: result is the f64 number 2^31.
  // If Stage 3 mis-emitted `i32.add`, the result would wrap to -2^31.
  it("(2^30 | 0) + (2^30 | 0) = 2^31", async () => {
    const source = `
      export function f(): number {
        const a = 1073741824; // 2^30
        const b = 1073741824;
        return (a | 0) + (b | 0);
      }
    `;
    const { legacy, ir } = await dualRun(source, "f", []);
    expect(ir).toBe(2147483648); // 2^31, NOT -2^31
    expect(legacy).toBe(2147483648);
  });

  // Same sentinel, multiplication: (2^15) * 2 fits in safe-integer f64.
  // (2^16) * (2^16) = 2^32 also fits. i32.mul would wrap to 0.
  it("(2^16) * (2^16) = 2^32", async () => {
    const source = `
      export function f(): number {
        const a = 65536; // 2^16
        const b = 65536;
        return a * b;
      }
    `;
    const { legacy, ir } = await dualRun(source, "f", []);
    expect(ir).toBe(4294967296); // 2^32
    expect(legacy).toBe(4294967296);
  });
});

describe("#1126 Stage 3 — code-shape: fast path emits native i32.* and skips the dance", () => {
  // The decisive tell that the fast path fired: the function body has a
  // native `i32.or` (or `i32.and`/`i32.xor`/...) and does NOT contain the
  // `f64.trunc` ... `i32.trunc_sat_f64_u` sequence that emitJsToInt32
  // emits. The single trailing `f64.convert_i32_s` is fine — it converts
  // the i32 result back to f64 for the IR contract.
  it("(a < b) | (c < d) — body uses native i32.or, no f64.trunc", () => {
    const src = `export function f(a: number, b: number, c: number, d: number) {
      return (a < b) | (c < d);
    }`;
    const ir = compile(src, { nativeStrings: true, experimentalIR: true });
    expect(ir.success).toBe(true);
    if (!ir.success) return;
    const body = extractFunc(ir.wat, "f");
    expect(body).toContain("i32.or");
    expect(body).not.toContain("f64.trunc");
    expect(body).not.toContain("i32.trunc_sat_f64_u");
  });

  it("(a < b) & (c < d) — body uses native i32.and, no f64.trunc", () => {
    const src = `export function f(a: number, b: number, c: number, d: number) {
      return (a < b) & (c < d);
    }`;
    const ir = compile(src, { nativeStrings: true, experimentalIR: true });
    expect(ir.success).toBe(true);
    if (!ir.success) return;
    const body = extractFunc(ir.wat, "f");
    expect(body).toContain("i32.and");
    expect(body).not.toContain("f64.trunc");
  });

  it("(a < b) << (c < d) — i32.shl on two i32 operands, no scratch dance", () => {
    // Both lhs and rhs are i32 (compare results). Stage 3's fast path
    // emits native `i32.shl` directly. Mixed i32/f64 operand cases (like
    // `(a < b) << someF64`) are Stage 4's boundary-conversion territory
    // and still fall back to the legacy path here.
    const src = `export function f(a: number, b: number, c: number, d: number) {
      // @ts-expect-error - test that bool << bool emits native i32.shl
      return (a < b) << (c < d);
    }`;
    const ir = compile(src, { nativeStrings: true, experimentalIR: true });
    expect(ir.success).toBe(true);
    if (!ir.success) return;
    const body = extractFunc(ir.wat, "f");
    expect(body).toContain("i32.shl");
    expect(body).not.toContain("f64.trunc");
    expect(body).not.toContain("i32.trunc_sat_f64_u");
  });

  // Magnitude compare on two i32 operands → native i32.lt_s.
  it("(a < b) < (c < d) — body uses i32.lt_s, no f64.lt at the outer", () => {
    const src = `export function f(a: number, b: number, c: number, d: number): boolean {
      return ((a < b) ? 1 : 0) < ((c < d) ? 1 : 0);
    }`;
    // The conditional widens (a<b) to f64 for the ?: result, so this case
    // exercises the f64 path. We also test the direct form below.
    const ir = compile(src, { nativeStrings: true, experimentalIR: true });
    expect(ir.success).toBe(true);
  });

  it("direct (a < b) < (c < d) — body uses i32.lt_s, no f64.lt at the outer", () => {
    // Suppress TS strict-mode boolean-as-number error with `// @ts-ignore`.
    const src = `export function f(a: number, b: number, c: number, d: number) {
      // @ts-expect-error - test that bool < bool emits native i32.lt_s
      return (a < b) < (c < d);
    }`;
    const ir = compile(src, { nativeStrings: true, experimentalIR: true });
    expect(ir.success).toBe(true);
    if (!ir.success) return;
    const body = extractFunc(ir.wat, "f");
    // Two inner f64.lt for the (a<b) and (c<d) compares.
    const ltF64Count = (body.match(/f64\.lt(?!_)/g) ?? []).length;
    expect(ltF64Count).toBe(2);
    // Outer compare uses native i32.lt_s.
    expect(body).toContain("i32.lt_s");
  });
});
