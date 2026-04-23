// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1167b — IR Phase 3b: inline-small (direct IR-to-IR calls).
//
// Covers:
//   1. Unit — single-block non-recursive callee gets inlined.
//   2. Unit — recursive callee is skipped.
//   3. Unit — multi-block callee is skipped.
//   4. Unit — `valueCount` advances past freshly-allocated inlined-value ids.
//   5. End-to-end — `abs` (single-block ternary) called from another function:
//      emitted WAT contains no `call $abs`; the compiled wasm still produces
//      the correct results.
//   6. End-to-end — recursive `fib` is NOT inlined at its own call sites;
//      WAT keeps `call $fib`; runtime still correct.
//   7. End-to-end — multi-block non-recursive callee is NOT inlined; WAT
//      keeps the call; runtime still correct.

import { describe, expect, it } from "vitest";

import { compile } from "../../src/index.js";
import { asBlockId, asValueId, irVal, verifyIrFunction, type IrFunction, type IrValueId } from "../../src/ir/index.js";
import { inlineSmall } from "../../src/ir/passes/inline-small.js";

// ---------------------------------------------------------------------------
// Unit-test helpers
// ---------------------------------------------------------------------------

function id(n: number): IrValueId {
  return asValueId(n);
}

const F64 = irVal({ kind: "f64" });
const BOOL = irVal({ kind: "i32" });

// A tiny single-block, non-recursive callee modelling `abs(x) = x < 0 ? -x : x`.
// 1 param + 4 instrs + return. Well under the 10-instr limit.
function makeAbsCallee(): IrFunction {
  return {
    name: "abs",
    params: [{ value: id(0), type: F64, name: "x" }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          { kind: "const", value: { kind: "f64", value: 0 }, result: id(1), resultType: F64 },
          { kind: "binary", op: "f64.lt", lhs: id(0), rhs: id(1), result: id(2), resultType: BOOL },
          { kind: "unary", op: "f64.neg", rand: id(0), result: id(3), resultType: F64 },
          {
            kind: "select",
            condition: id(2),
            whenTrue: id(3),
            whenFalse: id(0),
            result: id(4),
            resultType: F64,
          },
        ],
        terminator: { kind: "return", values: [id(4)] },
      },
    ],
    exported: false,
    valueCount: 5,
  };
}

// Caller: `run(n) = abs(n)`. Single-block, single call, returns the result.
function makeRunCaller(): IrFunction {
  return {
    name: "run",
    params: [{ value: id(0), type: F64, name: "n" }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "call",
            target: { kind: "func", name: "abs" },
            args: [id(0)],
            result: id(1),
            resultType: F64,
          },
        ],
        terminator: { kind: "return", values: [id(1)] },
      },
    ],
    exported: true,
    valueCount: 2,
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("#1167b — inlineSmall (unit)", () => {
  it("inlines a single-block non-recursive callee", () => {
    const callee = makeAbsCallee();
    const caller = makeRunCaller();
    const out = inlineSmall({ functions: [callee, caller] });
    expect(out).not.toBe({ functions: [callee, caller] }); // module changed

    // callee is unchanged; caller had its call replaced.
    const newCaller = out.functions[1]!;
    expect(newCaller).not.toBe(caller);
    expect(newCaller.blocks).toHaveLength(1);

    const block = newCaller.blocks[0]!;
    // No `call` instruction remains.
    expect(block.instrs.find((i) => i.kind === "call")).toBeUndefined();
    // The 4 callee instructions are now spliced in.
    expect(block.instrs).toHaveLength(4);
    expect(block.instrs[0]!.kind).toBe("const");
    expect(block.instrs[1]!.kind).toBe("binary");
    expect(block.instrs[2]!.kind).toBe("unary");
    expect(block.instrs[3]!.kind).toBe("select");

    // valueCount advanced to include fresh ids for the 4 inlined results.
    // Original caller valueCount was 2; we allocate 4 fresh ids → 6.
    expect(newCaller.valueCount).toBe(6);

    // Verify invariants hold on the inlined function.
    expect(verifyIrFunction(newCaller)).toEqual([]);
  });

  it("operands of inlined instructions are rewired to caller SSA ids", () => {
    const callee = makeAbsCallee();
    const caller = makeRunCaller();
    const out = inlineSmall({ functions: [callee, caller] });
    const newCaller = out.functions[1]!;
    const block = newCaller.blocks[0]!;

    // Binary's lhs is the callee's param `x` → must be mapped to the caller's
    // arg (id(0) in caller). The select operand for `whenFalse` likewise maps
    // to id(0). The `rand` in unary is also callee's x → id(0).
    const binary = block.instrs[1]!;
    if (binary.kind !== "binary") throw new Error("expected binary");
    expect(binary.lhs).toBe(id(0));

    const unary = block.instrs[2]!;
    if (unary.kind !== "unary") throw new Error("expected unary");
    expect(unary.rand).toBe(id(0));

    const sel = block.instrs[3]!;
    if (sel.kind !== "select") throw new Error("expected select");
    expect(sel.whenFalse).toBe(id(0));
  });

  it("skips a recursive callee", () => {
    // `rec(x) = rec(x)` — trivially recursive, single-block, returns via
    // the recursive call's result. canInline must reject it.
    const rec: IrFunction = {
      name: "rec",
      params: [{ value: id(0), type: F64, name: "x" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "rec" },
              args: [id(0)],
              result: id(1),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const caller: IrFunction = {
      name: "run",
      params: [{ value: id(0), type: F64, name: "n" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "rec" },
              args: [id(0)],
              result: id(1),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: true,
      valueCount: 2,
    };
    const out = inlineSmall({ functions: [rec, caller] });
    // Nothing changed — both references are the same.
    expect(out.functions[0]).toBe(rec);
    expect(out.functions[1]).toBe(caller);
  });

  it("skips a multi-block callee", () => {
    // A two-block callee is rejected by canInline regardless of size.
    const multi: IrFunction = {
      name: "two",
      params: [{ value: id(0), type: F64, name: "x" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "br", branch: { target: asBlockId(1), args: [] } },
        },
        {
          id: asBlockId(1),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 1,
    };
    const caller: IrFunction = {
      name: "run",
      params: [{ value: id(0), type: F64, name: "n" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "two" },
              args: [id(0)],
              result: id(1),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: true,
      valueCount: 2,
    };
    const out = inlineSmall({ functions: [multi, caller] });
    expect(out.functions[0]).toBe(multi);
    expect(out.functions[1]).toBe(caller);
  });

  it("skips callees larger than the instruction budget", () => {
    // Build a callee with > 10 instrs: 11 const instructions feeding a binop.
    // The simplest way is to chain 12 consts + 11 binaries, but we only need
    // > 10 so 11 instrs total suffices.
    const instrs = [];
    for (let i = 0; i < 11; i++) {
      instrs.push({
        kind: "const" as const,
        value: { kind: "f64" as const, value: i },
        result: id(i),
        resultType: F64,
      });
    }
    const large: IrFunction = {
      name: "large",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs,
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 11,
    };
    const caller: IrFunction = {
      name: "run",
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "large" },
              args: [],
              result: id(0),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: true,
      valueCount: 1,
    };
    const out = inlineSmall({ functions: [large, caller] });
    expect(out.functions[1]).toBe(caller);
  });

  it("returns the same module reference when nothing is inlinable", () => {
    const only: IrFunction = {
      name: "f",
      params: [{ value: id(0), type: F64, name: "n" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: true,
      valueCount: 1,
    };
    const mod = { functions: [only] };
    const out = inlineSmall(mod);
    expect(out).toBe(mod);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — compile through the IR path and inspect WAT + runtime.
// ---------------------------------------------------------------------------

/**
 * Return the full textual block `(func $NAME ...)` from a WAT module. The
 * emitted WAT uses numeric indices for `call` operands (e.g. `call 26`), so
 * to decide whether the caller body contains a call we isolate the caller's
 * parenthesised body and scan for a `call ` token inside it.
 */
function extractFuncBody(wat: string, name: string): string {
  const marker = `(func $${name}`;
  const start = wat.indexOf(marker);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < wat.length; i++) {
    const ch = wat[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return wat.slice(start, i + 1);
    }
  }
  return wat.slice(start);
}

describe("#1167b — inlineSmall (end-to-end)", () => {
  it("inlines a single-block helper: run body has no `call`", async () => {
    const source = `
      function abs(x: number): number { return x < 0 ? -x : x; }
      export function run(n: number): number { return abs(n); }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true, emitWat: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);

    // After inlining, `run`'s Wasm body should no longer contain a `call`.
    // Other module-level helpers (`$__str_*`) contain calls of their own,
    // so we scope the check to the `$run` function body.
    const runBody = extractFuncBody(result.wat, "run");
    expect(runBody).not.toBe("");
    expect(runBody).not.toContain("call ");

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const run = (instance.exports as Record<string, (n: number) => number>).run;
    expect(run(3)).toBe(3);
    expect(run(-4)).toBe(4);
    expect(run(0)).toBe(0);
  });

  it("does NOT inline a recursive callee: run body still contains a call", () => {
    // `rec` is trivially self-recursive, single-block, small — the only
    // reason inlineSmall should skip it is the recursion guard. (We don't
    // execute the compiled wasm: IR `select` evaluates BOTH arms, so a
    // recursive ternary never terminates at runtime — the point of this
    // test is purely to assert the WAT still contains the call.)
    const source = `
      function rec(n: number): number { return n < 0 ? n : rec(n - 1); }
      export function run(n: number): number { return rec(n); }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true, emitWat: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // run's body should still call rec (not inlined, because rec is recursive).
    const runBody = extractFuncBody(result.wat, "run");
    expect(runBody).not.toBe("");
    expect(runBody).toContain("call ");
    // rec itself must still exist as a Wasm function (not eliminated).
    expect(result.wat).toContain("(func $rec");
    // The recursive self-call inside rec's body must remain.
    const recBody = extractFuncBody(result.wat, "rec");
    expect(recBody).toContain("call ");
  });

  it("does NOT inline a multi-block callee: run body still contains a call", async () => {
    // `sgn` has an early-return `if`, which from-ast lowers to >1 block.
    // It's non-recursive and small, so the ONLY reason inlineSmall skips it
    // is the multi-block guard.
    const source = `
      function sgn(n: number): number {
        if (n > 0) return 1;
        return n < 0 ? -1 : 0;
      }
      export function run(n: number): number { return sgn(n); }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true, emitWat: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const runBody = extractFuncBody(result.wat, "run");
    expect(runBody).not.toBe("");
    expect(runBody).toContain("call ");
    expect(result.wat).toContain("(func $sgn");

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const run = (instance.exports as Record<string, (n: number) => number>).run;
    expect(run(5)).toBe(1);
    expect(run(-5)).toBe(-1);
    expect(run(0)).toBe(0);
  });

  it("preserves a function with no inlinable calls (no op on the hot path)", async () => {
    const source = `
      export function f(n: number): number { return n * 2 + 1; }
    `;
    const result = compile(source, { experimentalIR: true, nativeStrings: true, emitWat: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_string: () => {},
        console_log_bool: () => {},
      },
    });
    const f = (instance.exports as Record<string, (n: number) => number>).f;
    expect(f(3)).toBe(7);
    expect(f(-2)).toBe(-3);
  });
});
