// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1392 — IR null-safe access primitives.
//
// Verifies the three new primitives:
//   1. `ref.is_null` IrUnop — emits the Wasm ref.is_null op via the
//      unary-dispatch arm. Result is i32 (1 if null, 0 otherwise).
//   2. `IrInstrIf` value-producing if/else — emits a Wasm
//      `if (result T) ... else ... end` block. Short-circuit semantics:
//      only one arm's instructions execute at runtime.
//   3. `IrLowerResolver.nullCheck` — formal entry point for the null-
//      check Wasm op sequence. Default returns `[ref.is_null]`.

import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  irVal,
  IrFunctionBuilder,
  lowerIrFunctionToWasm,
  verifyIrFunction,
  type IrFunction,
  type IrLowerResolver,
  type IrValueId,
} from "../../src/ir/index.js";
import { constantFold } from "../../src/ir/passes/constant-fold.js";

const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });
const EXTERNREF = irVal({ kind: "externref" });

function id(n: number): IrValueId {
  return asValueId(n);
}

// Minimal resolver — only the methods our test cases hit.
function minimalResolver(): IrLowerResolver {
  let nextTypeIdx = 0;
  return {
    resolveFunc: () => {
      throw new Error("resolveFunc not used in this test");
    },
    resolveGlobal: () => {
      throw new Error("resolveGlobal not used in this test");
    },
    resolveType: () => {
      throw new Error("resolveType not used in this test");
    },
    internFuncType: () => nextTypeIdx++,
    nullCheck: () => [{ op: "ref.is_null" }],
  };
}

describe("#1392 — IR null-safe access primitives", () => {
  describe("ref.is_null IrUnop", () => {
    it("verifies a function that emits unary('ref.is_null', externrefParam)", () => {
      // function f(x: externref): i32 { return ref.is_null(x); }
      const fn: IrFunction = {
        name: "f",
        params: [{ value: id(0), type: EXTERNREF, name: "x" }],
        resultTypes: [I32],
        blocks: [
          {
            id: asBlockId(0),
            blockArgs: [],
            blockArgTypes: [],
            instrs: [{ kind: "unary", op: "ref.is_null", rand: id(0), result: id(1), resultType: I32 }],
            terminator: { kind: "return", values: [id(1)] },
          },
        ],
        exported: false,
        valueCount: 2,
      };
      // The verifier accepts the new IrUnop tag without error.
      expect(() => verifyIrFunction(fn)).not.toThrow();
    });

    it("lowers to a Wasm ref.is_null op", () => {
      const fn: IrFunction = {
        name: "f",
        params: [{ value: id(0), type: EXTERNREF, name: "x" }],
        resultTypes: [I32],
        blocks: [
          {
            id: asBlockId(0),
            blockArgs: [],
            blockArgTypes: [],
            instrs: [{ kind: "unary", op: "ref.is_null", rand: id(0), result: id(1), resultType: I32 }],
            terminator: { kind: "return", values: [id(1)] },
          },
        ],
        exported: false,
        valueCount: 2,
      };
      const result = lowerIrFunctionToWasm(fn, minimalResolver());
      // Body should contain `local.get 0; ref.is_null; return`. The result-
      // bearing unary may also be local.set'd / local.get'd before the
      // return depending on the materialisation rules — what matters is
      // that the instr list contains a `ref.is_null` op.
      const ops = JSON.stringify(result.func.body);
      expect(ops).toContain('"ref.is_null"');
    });

    it("constant-fold leaves ref.is_null untouched (non-foldable)", () => {
      // We don't track ref-typed constants, so the fold must be a no-op.
      const fn: IrFunction = {
        name: "f",
        params: [{ value: id(0), type: EXTERNREF, name: "x" }],
        resultTypes: [I32],
        blocks: [
          {
            id: asBlockId(0),
            blockArgs: [],
            blockArgTypes: [],
            instrs: [{ kind: "unary", op: "ref.is_null", rand: id(0), result: id(1), resultType: I32 }],
            terminator: { kind: "return", values: [id(1)] },
          },
        ],
        exported: false,
        valueCount: 2,
      };
      const folded = constantFold(fn);
      // Same reference — no rewrite happened.
      expect(folded).toBe(fn);
    });
  });

  describe("IrInstrIf value-producing if/else", () => {
    it("builds and verifies a simple if(cond) { 1 } else { 0 } via the builder", () => {
      const builder = new IrFunctionBuilder("f", [F64]);
      const cond = builder.addParam("cond", I32);
      builder.openBlock();

      // then arm: emit `f64.const 1` into the arm buffer.
      let thenValue!: IrValueId;
      const thenInstrs = builder.collectBodyInstrs(() => {
        thenValue = builder.emitConst({ kind: "f64", value: 1 }, F64);
      });

      // else arm: emit `f64.const 0`.
      let elseValue!: IrValueId;
      const elseInstrs = builder.collectBodyInstrs(() => {
        elseValue = builder.emitConst({ kind: "f64", value: 0 }, F64);
      });

      const result = builder.emitIf({
        cond,
        then: thenInstrs,
        thenValue,
        else: elseInstrs,
        elseValue,
        resultType: F64,
      });
      builder.terminate({ kind: "return", values: [result] });
      const fn = builder.finish();
      expect(() => verifyIrFunction(fn)).not.toThrow();
    });

    it("lowers to a Wasm if/else block with the right result type", () => {
      const builder = new IrFunctionBuilder("f", [F64]);
      const cond = builder.addParam("cond", I32);
      builder.openBlock();

      let thenValue!: IrValueId;
      const thenInstrs = builder.collectBodyInstrs(() => {
        thenValue = builder.emitConst({ kind: "f64", value: 42 }, F64);
      });

      let elseValue!: IrValueId;
      const elseInstrs = builder.collectBodyInstrs(() => {
        elseValue = builder.emitConst({ kind: "f64", value: 7 }, F64);
      });

      const result = builder.emitIf({
        cond,
        then: thenInstrs,
        thenValue,
        else: elseInstrs,
        elseValue,
        resultType: F64,
      });
      builder.terminate({ kind: "return", values: [result] });
      const fn = builder.finish();

      const lowered = lowerIrFunctionToWasm(fn, minimalResolver());
      const opsStr = JSON.stringify(lowered.func.body);
      // The Wasm `if` op is in the body, and its blockType references f64.
      expect(opsStr).toContain('"if"');
      expect(opsStr).toContain('"f64"');
      // No `select` op should be emitted — the IR's `if` is short-circuit,
      // not eager `select`.
      expect(opsStr).not.toContain('"select"');
    });

    it("supports nested collectBodyInstrs (required for chained ?.b?.c)", () => {
      // Nested arms: outer if -> inner if -> const. Verifies that the
      // builder's bodyBuffer save/restore allows nested arm collection.
      const builder = new IrFunctionBuilder("f", [F64]);
      const cond = builder.addParam("cond", I32);
      builder.openBlock();

      let outerThenValue!: IrValueId;
      const outerThenInstrs = builder.collectBodyInstrs(() => {
        // INSIDE the outer arm's collection scope, collect a NESTED arm.
        let innerThenValue!: IrValueId;
        const innerThenInstrs = builder.collectBodyInstrs(() => {
          innerThenValue = builder.emitConst({ kind: "f64", value: 1 }, F64);
        });
        let innerElseValue!: IrValueId;
        const innerElseInstrs = builder.collectBodyInstrs(() => {
          innerElseValue = builder.emitConst({ kind: "f64", value: 2 }, F64);
        });
        // Use cond again for the inner if's condition (any i32 SSA value
        // works for the test — we just need the topology).
        outerThenValue = builder.emitIf({
          cond,
          then: innerThenInstrs,
          thenValue: innerThenValue,
          else: innerElseInstrs,
          elseValue: innerElseValue,
          resultType: F64,
        });
      });

      let outerElseValue!: IrValueId;
      const outerElseInstrs = builder.collectBodyInstrs(() => {
        outerElseValue = builder.emitConst({ kind: "f64", value: 3 }, F64);
      });

      const result = builder.emitIf({
        cond,
        then: outerThenInstrs,
        thenValue: outerThenValue,
        else: outerElseInstrs,
        elseValue: outerElseValue,
        resultType: F64,
      });
      builder.terminate({ kind: "return", values: [result] });
      const fn = builder.finish();
      expect(() => verifyIrFunction(fn)).not.toThrow();

      const lowered = lowerIrFunctionToWasm(fn, minimalResolver());
      // Two nested `if` ops should appear in the lowered body.
      const opsStr = JSON.stringify(lowered.func.body);
      const ifMatches = opsStr.match(/"if"/g) ?? [];
      expect(ifMatches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("nullCheck builder method", () => {
    it("emits unary('ref.is_null', val) returning an i32 IrValueId", () => {
      const builder = new IrFunctionBuilder("f", [I32]);
      const x = builder.addParam("x", EXTERNREF);
      builder.openBlock();
      const isNull = builder.nullCheck(x);
      builder.terminate({ kind: "return", values: [isNull] });
      const fn = builder.finish();
      expect(() => verifyIrFunction(fn)).not.toThrow();
      // The single instr is a `unary` with op `ref.is_null` over the param.
      const block0 = fn.blocks[0]!;
      expect(block0.instrs).toHaveLength(1);
      const instr = block0.instrs[0]!;
      expect(instr.kind).toBe("unary");
      if (instr.kind === "unary") {
        expect(instr.op).toBe("ref.is_null");
        expect(instr.rand).toBe(x);
        expect(instr.resultType).toEqual(I32);
      }
    });
  });
});
