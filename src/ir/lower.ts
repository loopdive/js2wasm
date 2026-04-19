// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR → Wasm emission pass.
//
// This is where symbolic refs (IrFuncRef / IrGlobalRef / IrTypeRef) are
// resolved to concrete indices. Because lowering runs AFTER all imports are
// finalized by the caller, the legacy `shiftLateImportIndices` pass is a
// no-op for any function emitted via this path — that is the central payoff
// of the symbolic-ref design (spec #1131 §1.2).
//
// Emission strategy (Phase 1):
//   - Tree-walk from the terminator. For each SSA value referenced by the
//     terminator (and, recursively, by each defining instruction), emit the
//     Wasm sub-sequence that materializes it on the value stack.
//   - Param SSA values lower to `local.get paramIdx`.
//   - Const SSA values lower to the matching `<type>.const` op.
//   - Derived SSA values (binary / unary / call / …) recursively emit their
//     operands, then the op.
//   - Single-use invariant: Phase 1 assumes each non-param SSA value is
//     consumed exactly once. Multi-use support (with `local.set` + `local.get`)
//     is a Phase 2 concern.
//
// Phase 1 also only handles a single-block function with a `return`
// terminator. Branches, loops, and try/catch come in Phase 2.

import type { IrFuncRef, IrFunction, IrGlobalRef, IrInstr, IrTypeRef, IrValueId } from "./nodes.js";
import type { FuncTypeDef, Instr, LocalDef, ValType, WasmFunction } from "./types.js";

export interface IrLowerResolver {
  resolveFunc(ref: IrFuncRef): number;
  resolveGlobal(ref: IrGlobalRef): number;
  resolveType(ref: IrTypeRef): number;
  internFuncType(type: FuncTypeDef): number;
}

export interface IrLowerResult {
  readonly func: WasmFunction;
}

export function lowerIrFunctionToWasm(func: IrFunction, resolver: IrLowerResolver): IrLowerResult {
  if (func.blocks.length !== 1) {
    throw new Error(
      `ir/lower: Phase 1 supports only single-block functions (got ${func.blocks.length} in ${func.name})`,
    );
  }
  const block = func.blocks[0];
  if (block.terminator.kind !== "return") {
    throw new Error(
      `ir/lower: Phase 1 supports only 'return'-terminated blocks (got ${block.terminator.kind} in ${func.name})`,
    );
  }
  if (block.blockArgs.length !== 0) {
    throw new Error(`ir/lower: Phase 1 entry block must not declare block args (${func.name})`);
  }

  // Map each SSA value to its source: param index or defining instruction.
  const paramIdx = new Map<IrValueId, number>();
  func.params.forEach((p, idx) => paramIdx.set(p.value, idx));
  const defBy = new Map<IrValueId, IrInstr>();
  for (const instr of block.instrs) {
    if (instr.result !== null) {
      if (defBy.has(instr.result)) {
        throw new Error(`ir/lower: duplicate SSA def for ${instr.result} in ${func.name}`);
      }
      defBy.set(instr.result, instr);
    }
  }

  const body: Instr[] = [];

  const emitValue = (v: IrValueId): void => {
    const pi = paramIdx.get(v);
    if (pi !== undefined) {
      body.push({ op: "local.get", index: pi });
      return;
    }
    const d = defBy.get(v);
    if (!d) throw new Error(`ir/lower: undefined SSA value ${v} in ${func.name}`);
    emitInstr(d);
  };

  const emitInstr = (instr: IrInstr): void => {
    switch (instr.kind) {
      case "const":
        emitConst(instr, body, func.name);
        return;
      case "call": {
        for (const a of instr.args) emitValue(a);
        body.push({ op: "call", funcIdx: resolver.resolveFunc(instr.target) });
        return;
      }
      case "global.get":
        body.push({ op: "global.get", index: resolver.resolveGlobal(instr.target) });
        return;
      case "global.set":
        emitValue(instr.value);
        body.push({ op: "global.set", index: resolver.resolveGlobal(instr.target) });
        return;
      case "binary":
        emitValue(instr.lhs);
        emitValue(instr.rhs);
        body.push({ op: instr.op } as unknown as Instr);
        return;
      case "unary":
        emitValue(instr.rand);
        body.push({ op: instr.op } as unknown as Instr);
        return;
      case "raw.wasm":
        for (const op of instr.ops) body.push(op);
        return;
    }
  };

  // Lower the return terminator: emit each returned value in order, then `return`.
  if (block.terminator.kind === "return") {
    for (const v of block.terminator.values) emitValue(v);
  }
  body.push({ op: "return" });

  // Synthesize the Wasm function signature + type.
  const paramTypes: ValType[] = func.params.map((p) => p.type);
  const resultTypes: ValType[] = func.resultTypes.map((t) => t);
  const typeIdx = resolver.internFuncType({ kind: "func", params: paramTypes, results: resultTypes });

  const locals: LocalDef[] = [];

  return {
    func: {
      name: func.name,
      typeIdx,
      locals,
      body,
      exported: func.exported,
    },
  };
}

function emitConst(instr: Extract<IrInstr, { kind: "const" }>, out: Instr[], funcName: string): void {
  const v = instr.value;
  switch (v.kind) {
    case "i32":
      out.push({ op: "i32.const", value: v.value });
      return;
    case "i64":
      out.push({ op: "i64.const", value: v.value });
      return;
    case "f32":
      out.push({ op: "f32.const", value: v.value });
      return;
    case "f64":
      out.push({ op: "f64.const", value: v.value });
      return;
    case "bool":
      out.push({ op: "i32.const", value: v.value ? 1 : 0 });
      return;
    case "null":
      if (instr.resultType && instr.resultType.kind === "ref_null") {
        out.push({ op: "ref.null", typeIdx: instr.resultType.typeIdx } as unknown as Instr);
        return;
      }
      throw new Error(`ir/lower: const null must have ref_null resultType (${funcName})`);
    case "undefined":
      throw new Error(`ir/lower: Phase 1 does not materialize 'undefined' constants (${funcName})`);
  }
}
