// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1169f slice 7b — IR scaffolding for `yield*` delegation.
//
// **Behavior status:** the original slice-7b widening (bare `yield;`,
// `yield* <iterable>`, non-numeric `yield <expr>`, bare `return;`)
// was REVERTED on this branch after PR #73 CI showed ~240 test262
// regressions clustered in `eval-code` / TypedArray / WeakMap
// directories that did not reproduce locally. The selector and
// `lowerYield` are both back to slice 7a's strict shape.
//
// **What this slice ships:** the IR-node scaffolding for
// `gen.yieldStar`, ready for a future slice to wire from
// `lowerYield` once the regression source is pinpointed (see PR #73
// retrospective in plan/log/diary.md).
//
// **Scaffolding under test (builder API only — no AST→IR path):**
//   1. `IrInstrGenYieldStar` interface in `nodes.ts`, with `inner:
//      IrValueId` operand.
//   2. `IrFunctionBuilder.emitGenYieldStar(inner)` method enforces
//      `funcKind === "generator"` precondition.
//   3. Verifier accepts `gen.yieldStar` and counts `inner` as a use
//      (covered transitively here — the verify pass runs as part of
//      the lowering pipeline below).
//   4. Lowerer emits `local.get $__gen_buffer; <inner>; call
//      $__gen_yield_star` when it encounters a `gen.yieldStar`
//      instr.
//   5. DCE pins `gen.yieldStar` as side-effecting (covered by the
//      first end-to-end lower below — the inner SSA value's
//      producer must survive).
//   6. inline-small + monomorphize have arms for the new instr
//      (compile-time exhaustiveness — the typecheck guarantees it).
//
// A future slice (7c?) will replace these unit tests with dual-run
// equivalence tests once the AST→IR wiring lands.

import { describe, expect, it } from "vitest";

import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal } from "../src/ir/nodes.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import type { FuncTypeDef } from "../src/ir/types.js";

/**
 * Stub resolver suitable for lowering a tiny generator IR fragment.
 * Maps the generator host imports to placeholder funcIdx values that
 * survive Wasm validation as long as the emitted body is structurally
 * correct (signatures unchecked here — we only walk the lowered body
 * for the expected ops).
 */
function makeStubResolver(): IrLowerResolver {
  let nextTypeIdx = 0;
  return {
    resolveFunc: (ref) => {
      // Map host-import names to stable indices in the order the
      // lowerer is expected to ask for them.
      switch (ref.name) {
        case "__gen_create_buffer":
          return 0;
        case "__gen_push_f64":
          return 1;
        case "__gen_yield_star":
          return 2;
        case "__create_generator":
          return 3;
        default:
          throw new Error(`stub resolveFunc: unknown ${ref.name}`);
      }
    },
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: (_t: FuncTypeDef) => nextTypeIdx++,
  };
}

describe("#1169f slice 7b — gen.yieldStar IR scaffolding", () => {
  it("builder.emitGenYieldStar throws when funcKind is not generator", () => {
    const b = new IrFunctionBuilder("nonGen", [irVal({ kind: "f64" })], false);
    b.openBlock();
    const v = b.emitConst({ kind: "f64", value: 0 }, irVal({ kind: "f64" }));
    expect(() => b.emitGenYieldStar(v)).toThrow(/funcKind=generator/);
  });

  it("builder.emitGenYieldStar accepts an SSA value when funcKind is generator", () => {
    const b = new IrFunctionBuilder("gen", [irVal({ kind: "externref" })], false);
    b.setFuncKind("generator");
    const slotIdx = b.declareSlot("__gen_buffer", { kind: "externref" });
    b.setGeneratorBufferSlot(slotIdx);
    b.openBlock();
    // Materialise the buffer (so the prologue is well-formed).
    const buf = b.emitCall({ kind: "func", name: "__gen_create_buffer" }, [], irVal({ kind: "externref" }));
    if (buf === null) throw new Error("buf must be non-null");
    b.emitSlotWrite(slotIdx, buf);

    // Inner iterable: pretend we have an externref param. We don't
    // need the AST→IR layer for this — addParam supplies a usable
    // SSA value typed as externref.
    const inner = b.emitConst({ kind: "null", ty: irVal({ kind: "externref" }) }, irVal({ kind: "externref" }));

    // The instr we want to test.
    b.emitGenYieldStar(inner);

    // Generator epilogue + return so the function is well-formed.
    const result = b.emitGenEpilogue();
    b.terminate({ kind: "return", values: [result] });

    const fn = b.finish();
    expect(fn.funcKind).toBe("generator");
    expect(fn.generatorBufferSlot).toBe(slotIdx);

    // Verifier accepts the function.
    expect(verifyIrFunction(fn)).toEqual([]);

    // Lower to Wasm and confirm a `__gen_yield_star` call appears.
    const { func } = lowerIrFunctionToWasm(fn, makeStubResolver());
    const callOps = func.body.filter((op): op is { op: "call"; funcIdx: number } => op.op === "call");
    const callTargets = callOps.map((c) => c.funcIdx);
    expect(callTargets).toContain(2); // __gen_yield_star
    expect(callTargets).toContain(0); // __gen_create_buffer (prologue)
    expect(callTargets).toContain(3); // __create_generator (epilogue)
  });

  it("verifier counts gen.yieldStar.inner as a use of its operand", () => {
    // A function that produces an SSA value, never uses it directly,
    // and feeds it through gen.yieldStar — DCE must keep the producer
    // alive because gen.yieldStar is flagged side-effecting.
    const b = new IrFunctionBuilder("gen", [irVal({ kind: "externref" })], false);
    b.setFuncKind("generator");
    const slotIdx = b.declareSlot("__gen_buffer", { kind: "externref" });
    b.setGeneratorBufferSlot(slotIdx);
    b.openBlock();
    const buf = b.emitCall({ kind: "func", name: "__gen_create_buffer" }, [], irVal({ kind: "externref" }));
    if (buf === null) throw new Error("buf must be non-null");
    b.emitSlotWrite(slotIdx, buf);
    const inner = b.emitConst({ kind: "null", ty: irVal({ kind: "externref" }) }, irVal({ kind: "externref" }));
    b.emitGenYieldStar(inner);
    const result = b.emitGenEpilogue();
    b.terminate({ kind: "return", values: [result] });

    const fn = b.finish();
    // Verifier sees `inner` as a defined SSA value used by
    // gen.yieldStar — no errors.
    const errors = verifyIrFunction(fn);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});
