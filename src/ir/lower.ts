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
//   - Multi-use SSA values: a pre-pass counts how many times each value is
//     referenced (transitively from the terminator). Values used more than
//     once get a Wasm local; the first emission is `<tree> local.tee $i`
//     (leaves the value on the stack AND stores it), subsequent emissions
//     are `local.get $i`. This preserves byte-identity with legacy for the
//     single-use case and handles `let x = …; return x + x;` correctly.
//
// Phase 1 also only handles a single-block function with a `return`
// terminator. Branches, loops, and try/catch come in Phase 2.

import type { IrFuncRef, IrFunction, IrGlobalRef, IrInstr, IrType, IrTypeRef, IrValueId } from "./nodes.js";
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

  // Use-count pre-pass: count how many times each SSA value is referenced,
  // transitively from the terminator. Values with count > 1 are materialized
  // to a Wasm local on first use and `local.get`'d on subsequent uses.
  const useCount = new Map<IrValueId, number>();
  const walkCount = (v: IrValueId): void => {
    const prev = useCount.get(v) ?? 0;
    useCount.set(v, prev + 1);
    if (prev > 0) return; // already expanded — do not double-count subtree uses
    if (paramIdx.has(v)) return;
    const d = defBy.get(v);
    if (!d) return; // will surface as an error during emission
    for (const u of collectIrUses(d)) walkCount(u);
  };
  if (block.terminator.kind === "return") {
    for (const v of block.terminator.values) walkCount(v);
  }

  const body: Instr[] = [];
  const locals: LocalDef[] = [];
  const localIdx = new Map<IrValueId, number>();
  const materialized = new Set<IrValueId>();

  const allocLocal = (v: IrValueId, type: IrType): number => {
    const existing = localIdx.get(v);
    if (existing !== undefined) return existing;
    const idx = func.params.length + locals.length;
    locals.push({ name: `$ir${v}`, type });
    localIdx.set(v, idx);
    return idx;
  };

  const emitValue = (v: IrValueId): void => {
    const pi = paramIdx.get(v);
    if (pi !== undefined) {
      body.push({ op: "local.get", index: pi });
      return;
    }
    const d = defBy.get(v);
    if (!d) throw new Error(`ir/lower: undefined SSA value ${v} in ${func.name}`);
    const count = useCount.get(v) ?? 1;
    if (count > 1) {
      if (materialized.has(v)) {
        body.push({ op: "local.get", index: localIdx.get(v)! });
        return;
      }
      if (!d.resultType) {
        throw new Error(`ir/lower: multi-use SSA value ${v} has no resultType in ${func.name}`);
      }
      const idx = allocLocal(v, d.resultType);
      emitInstr(d);
      body.push({ op: "local.tee", index: idx });
      materialized.add(v);
      return;
    }
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

function collectIrUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
      return [];
    case "call":
      return instr.args;
    case "global.get":
      return [];
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "raw.wasm":
      return [];
  }
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
