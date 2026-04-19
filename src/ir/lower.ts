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
// Emission strategy
// =================
//
// The emitter reconstructs structured Wasm control flow from the IR's basic
// blocks. Phase 1's control-flow shape is narrow: the entry block either
// ends in `return` (straight-line function) or in `br_if` to two
// tail-shaped arms that each terminate with `return` (or, recursively, with
// another nested if/else). No joins, no back-edges, no fall-through from
// structured blocks. This maps 1:1 onto Wasm's structured `if/else/end`
// without building a dominator tree.
//
// Per-block emission strategy:
//   - Walk `block.instrs` in order. For each instruction whose result is
//     used in a *different* block, emit the defining subtree followed by
//     `local.set` — this materializes the value so successor blocks can
//     read it via `local.get`. (Params are already in locals, so they
//     never need this.)
//   - Skip emission for intra-block single-use and multi-use values — those
//     are handled at the use site: single-use via inline tree emission,
//     multi-use via `tree + local.tee` on first use and `local.get` after.
//   - Lower the terminator:
//       * `return` → emit each value, then a Wasm `return` op.
//       * `br_if`  → emit the condition, then a Wasm structured `if/else`
//                    containing the recursively-emitted then/else blocks.
//
// After the entry block emission, we append a `return` op (for a
// return-terminated function) or `unreachable` (for a br_if-terminated
// function). The latter satisfies Wasm's stack-type validator at function
// end — both arms of the structured if always `return`, so fallthrough is
// unreachable at runtime, but structurally we still need an op whose type
// is polymorphic.

import type { IrBlock, IrFuncRef, IrFunction, IrGlobalRef, IrInstr, IrType, IrTypeRef, IrValueId } from "./nodes.js";
import type { BlockType, FuncTypeDef, Instr, LocalDef, ValType, WasmFunction } from "./types.js";

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
  if (func.blocks.length === 0) {
    throw new Error(`ir/lower: function ${func.name} has no blocks`);
  }
  if (func.blocks[0].blockArgs.length !== 0) {
    throw new Error(`ir/lower: Phase 1 entry block must not declare block args (${func.name})`);
  }

  // --- index maps ---------------------------------------------------------

  const paramIdx = new Map<IrValueId, number>();
  func.params.forEach((p, idx) => paramIdx.set(p.value, idx));

  const defBy = new Map<IrValueId, IrInstr>();
  const defBlockOf = new Map<IrValueId, number>();
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      if (instr.result !== null) {
        if (defBy.has(instr.result)) {
          throw new Error(`ir/lower: duplicate SSA def for ${instr.result} in ${func.name}`);
        }
        defBy.set(instr.result, instr);
        defBlockOf.set(instr.result, block.id as number);
      }
    }
  }

  // --- use counting -------------------------------------------------------
  //
  // For each SSA value, count how many times it is referenced from each
  // block (instructions + terminator). A value is:
  //   - "cross-block" if any block other than its def block references it.
  //   - "multi-use"   if its total reference count exceeds 1.
  // Both classes need a dedicated Wasm local. Cross-block values are
  // materialized eagerly at def time (local.set); intra-block-only
  // multi-use values are materialized lazily at first use (local.tee).

  const usesPerBlock = new Map<IrValueId, Map<number, number>>();
  const totalUses = new Map<IrValueId, number>();
  const recordUse = (v: IrValueId, blockId: number): void => {
    totalUses.set(v, (totalUses.get(v) ?? 0) + 1);
    let m = usesPerBlock.get(v);
    if (!m) {
      m = new Map();
      usesPerBlock.set(v, m);
    }
    m.set(blockId, (m.get(blockId) ?? 0) + 1);
  };
  for (const block of func.blocks) {
    const blockId = block.id as number;
    for (const instr of block.instrs) {
      for (const u of collectIrUses(instr)) recordUse(u, blockId);
    }
    for (const u of collectTerminatorUses(block)) recordUse(u, blockId);
  }

  const crossBlock = new Set<IrValueId>();
  const needsLocal = new Set<IrValueId>();
  for (const [v, m] of usesPerBlock) {
    if (paramIdx.has(v)) continue;
    const total = totalUses.get(v) ?? 0;
    if (total > 1) needsLocal.add(v);
    const defBlk = defBlockOf.get(v);
    if (defBlk === undefined) continue; // should not happen after duplicate-def check
    for (const b of m.keys()) {
      if (b !== defBlk) {
        crossBlock.add(v);
        needsLocal.add(v);
        break;
      }
    }
  }

  // --- local allocation ---------------------------------------------------
  // Stable order: scan blocks then instrs. Every `needsLocal` value gets one
  // Wasm local slot, placed after the function's parameter slots.
  const locals: LocalDef[] = [];
  const localIdx = new Map<IrValueId, number>();
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      if (instr.result !== null && needsLocal.has(instr.result)) {
        if (!instr.resultType) {
          throw new Error(`ir/lower: local-bound SSA value ${instr.result} has no resultType in ${func.name}`);
        }
        const idx = func.params.length + locals.length;
        locals.push({ name: `$ir${instr.result}`, type: instr.resultType });
        localIdx.set(instr.result, idx);
      }
    }
  }

  // --- emission -----------------------------------------------------------

  const materialized = new Set<IrValueId>();

  const emitValue = (v: IrValueId, out: Instr[]): void => {
    const pi = paramIdx.get(v);
    if (pi !== undefined) {
      out.push({ op: "local.get", index: pi });
      return;
    }
    if (materialized.has(v)) {
      out.push({ op: "local.get", index: localIdx.get(v)! });
      return;
    }
    const d = defBy.get(v);
    if (!d) throw new Error(`ir/lower: undefined SSA value ${v} in ${func.name}`);
    if (needsLocal.has(v)) {
      // Intra-block multi-use only reaches here (cross-block values are
      // pre-materialized by `emitBlockBody` before the terminator). Use the
      // tee pattern: first use emits the tree and leaves the value on the
      // stack while also storing it; later uses become `local.get`.
      emitInstrTree(d, out);
      out.push({ op: "local.tee", index: localIdx.get(v)! });
      materialized.add(v);
      return;
    }
    emitInstrTree(d, out);
  };

  const emitInstrTree = (instr: IrInstr, out: Instr[]): void => {
    switch (instr.kind) {
      case "const":
        emitConst(instr, out, func.name);
        return;
      case "call": {
        for (const a of instr.args) emitValue(a, out);
        out.push({ op: "call", funcIdx: resolver.resolveFunc(instr.target) });
        return;
      }
      case "global.get":
        out.push({ op: "global.get", index: resolver.resolveGlobal(instr.target) });
        return;
      case "global.set":
        emitValue(instr.value, out);
        out.push({ op: "global.set", index: resolver.resolveGlobal(instr.target) });
        return;
      case "binary":
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        out.push({ op: instr.op } as unknown as Instr);
        return;
      case "unary":
        emitValue(instr.rand, out);
        out.push({ op: instr.op } as unknown as Instr);
        return;
      case "select":
        // Wasm `select` pops [val1, val2, cond] and pushes val1 if cond != 0
        // else val2 — so `cond ? whenTrue : whenFalse` pushes whenTrue,
        // whenFalse, cond, then `select`.
        emitValue(instr.whenTrue, out);
        emitValue(instr.whenFalse, out);
        emitValue(instr.condition, out);
        out.push({ op: "select" });
        return;
      case "raw.wasm":
        for (const op of instr.ops) out.push(op);
        return;
    }
  };

  const emitBlockBody = (block: IrBlock, out: Instr[]): void => {
    for (const instr of block.instrs) {
      if (instr.result === null) {
        // Void-producing instrs (global.set, raw.wasm with no result).
        emitInstrTree(instr, out);
        continue;
      }
      if (crossBlock.has(instr.result)) {
        // Pre-materialize for successor blocks.
        emitInstrTree(instr, out);
        out.push({ op: "local.set", index: localIdx.get(instr.result)! });
        materialized.add(instr.result);
      }
      // Intra-block-only: single-use inlines at use site, multi-use uses
      // the lazy-tee pattern at first reference. Skip emission here.
    }

    const t = block.terminator;
    switch (t.kind) {
      case "return":
        for (const v of t.values) emitValue(v, out);
        out.push({ op: "return" });
        return;
      case "br_if": {
        if (t.ifTrue.args.length !== 0 || t.ifFalse.args.length !== 0) {
          throw new Error(`ir/lower: Phase 1 br_if does not support branch args (${func.name})`);
        }
        const thenBlock = func.blocks[t.ifTrue.target as number];
        const elseBlock = func.blocks[t.ifFalse.target as number];
        if (!thenBlock || !elseBlock) {
          throw new Error(`ir/lower: br_if target missing in ${func.name}`);
        }
        emitValue(t.condition, out);
        const thenOps: Instr[] = [];
        const elseOps: Instr[] = [];
        emitBlockBody(thenBlock, thenOps);
        emitBlockBody(elseBlock, elseOps);
        const blockType: BlockType = { kind: "empty" };
        out.push({ op: "if", blockType, then: thenOps, else: elseOps });
        return;
      }
      case "br":
        throw new Error(`ir/lower: Phase 1 does not support 'br' terminators (${func.name})`);
      case "unreachable":
        out.push({ op: "unreachable" });
        return;
    }
  };

  const body: Instr[] = [];
  emitBlockBody(func.blocks[0], body);
  // A br_if-terminated entry leaves fallthrough after the structured `if`.
  // Wasm's validator requires the function body to end with an op that
  // produces the return-type-shape on stack — `unreachable` is polymorphic
  // and satisfies that contract without emitting a real value.
  const last = body[body.length - 1];
  if (!last || last.op !== "return") {
    body.push({ op: "unreachable" });
  }

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
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
    case "raw.wasm":
      return [];
  }
}

function collectTerminatorUses(block: IrBlock): readonly IrValueId[] {
  const t = block.terminator;
  switch (t.kind) {
    case "return":
      return t.values;
    case "br":
      return t.branch.args;
    case "br_if":
      return [t.condition, ...t.ifTrue.args, ...t.ifFalse.args];
    case "unreachable":
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
