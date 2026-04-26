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

import {
  asVal,
  type IrBlock,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrType,
  type IrTypeRef,
  type IrValueId,
} from "./nodes.js";
import type { BlockType, FuncTypeDef, Instr, LocalDef, ValType, WasmFunction } from "./types.js";

/**
 * Information about a tagged-union struct type emitted into the WasmGC module.
 * See `passes/tagged-union-types.ts` for the registry that produces these.
 */
export interface IrUnionLowering {
  /** WasmGC type index of the `$union_<members>` struct. */
  readonly typeIdx: number;
  /** Field index of the `$tag` i32 discriminator. */
  readonly tagFieldIdx: number;
  /** Field index of the `$val` field carrying the member scalar. */
  readonly valFieldIdx: number;
  /** Canonical tag value (i32 constant) for each ValType kind. */
  tagFor(member: ValType): number;
}

/**
 * Information about a heap-allocated scalar box — see
 * `IrType { kind: "boxed", inner }`. Resolved lazily by the lowering pass.
 */
export interface IrBoxedLowering {
  /** WasmGC type index of the `$box_<inner>` struct. */
  readonly typeIdx: number;
  /** Field index of the inner `$val`. */
  readonly valFieldIdx: number;
}

export interface IrLowerResolver {
  resolveFunc(ref: IrFuncRef): number;
  resolveGlobal(ref: IrGlobalRef): number;
  resolveType(ref: IrTypeRef): number;
  internFuncType(type: FuncTypeDef): number;
  /**
   * Resolve (and memoise) the WasmGC struct type for a `union` IrType. V1
   * scope: homogeneous-width unions only — see
   * `passes/tagged-union-types.ts`. Returns `null` when the union is not
   * representable (heterogeneous, or contains reference members); callers
   * must treat that as `dynamic` upstream.
   *
   * Optional so Phase-1 resolvers without tagged-union support can omit it;
   * a Phase-3 function that actually emits `box`/`unbox`/`tag.test` will
   * fail at lowering time when it's missing, which is the correct behavior
   * (caller should have rejected the IR earlier).
   */
  resolveUnion?(members: readonly ValType[]): IrUnionLowering | null;
  /**
   * Resolve (and memoise) the WasmGC struct type for a `boxed` IrType.
   * Optional for the same reason as `resolveUnion`.
   */
  resolveBoxed?(inner: ValType): IrBoxedLowering | null;
  /**
   * Resolve the Wasm value type used for `IrType.string` in the active
   * backend.
   *   - `wasm:js-string` mode → `{ kind: "externref" }`.
   *   - `nativeStrings` mode  → `{ kind: "ref", typeIdx: ctx.anyStrTypeIdx }`.
   * Optional so Phase-1 resolvers without string support can omit it; a
   * function that actually emits a `string.*` instr will fail at lowering
   * time when it's missing.
   */
  resolveString?(): ValType;
  /**
   * Emit the Wasm op sequence that materializes a string literal.
   *   - host strings → register a `string_constants.<value>` global import
   *                    and emit `[global.get]`.
   *   - native       → inline `i32.const len`, `i32.const 0`, code-unit
   *                    `i32.const`s, `array.new_fixed`, `struct.new`.
   */
  emitStringConst?(value: string): readonly Instr[];
  /** `[call concat]` (host) or `[call __str_concat]` (native). */
  emitStringConcat?(): readonly Instr[];
  /** `[call equals]` (host) or `[call __str_equals]` (native). */
  emitStringEquals?(): readonly Instr[];
  /**
   * `[call length]` (host) or `[struct.get $AnyString $len]` (native).
   * Result is i32 — the `string.len` IR instr appends an
   * `f64.convert_i32_s` after this.
   */
  emitStringLen?(): readonly Instr[];
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
  const paramTypeOf = new Map<IrValueId, IrType>();
  for (const p of func.params) paramTypeOf.set(p.value, p.type);
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

  /**
   * IrType of an SSA value — looks up params first, then the defining instr's
   * resultType. Used by `box` / `unbox` / `tag.test` lowering to find the
   * union / boxed struct type for the operand.
   */
  const typeOf = (v: IrValueId): IrType => {
    const paramT = paramTypeOf.get(v);
    if (paramT) return paramT;
    const d = defBy.get(v);
    if (!d || !d.resultType) {
      throw new Error(`ir/lower: value ${v} has no known IrType in ${func.name}`);
    }
    return d.resultType;
  };

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
  // Wasm local slot, placed after the function's parameter slots. The slot's
  // Wasm type is the lowered ValType of the IR resultType (wrap unions /
  // boxed types as refs to the corresponding WasmGC struct).
  const locals: LocalDef[] = [];
  const localIdx = new Map<IrValueId, number>();
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      if (instr.result !== null && needsLocal.has(instr.result)) {
        if (!instr.resultType) {
          throw new Error(`ir/lower: local-bound SSA value ${instr.result} has no resultType in ${func.name}`);
        }
        const idx = func.params.length + locals.length;
        locals.push({ name: `$ir${instr.result}`, type: lowerIrTypeToValType(instr.resultType, resolver, func.name) });
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
      case "box": {
        // `toType` must be a union (V1 only boxes into tagged unions). The
        // tag + value are pushed onto the stack in declaration order, then
        // struct.new builds the union instance.
        if (instr.toType.kind !== "union") {
          throw new Error(`ir/lower: box target must be a union IrType, got ${instr.toType.kind} (${func.name})`);
        }
        const valueType = asVal(typeOf(instr.value));
        if (!valueType) {
          throw new Error(`ir/lower: box value must be a val-kind IrType (${func.name})`);
        }
        const union = resolver.resolveUnion?.(instr.toType.members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${instr.toType.members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        const tag = union.tagFor(valueType);
        // Struct field order: fields at indices tagFieldIdx / valFieldIdx.
        // For V1 registry, tag=0, val=1, so push tag first, then value.
        const pushes: Array<() => void> = [];
        pushes[union.tagFieldIdx] = () => out.push({ op: "i32.const", value: tag });
        pushes[union.valFieldIdx] = () => emitValue(instr.value, out);
        for (const push of pushes) push();
        out.push({ op: "struct.new", typeIdx: union.typeIdx });
        return;
      }
      case "unbox": {
        // Caller must have proved the tag already; lowering is a plain
        // `struct.get $val`. A future debug mode may prepend a tag check.
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "union") {
          throw new Error(`ir/lower: unbox value must be a union IrType, got ${valueIrType.kind} (${func.name})`);
        }
        const union = resolver.resolveUnion?.(valueIrType.members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${valueIrType.members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        emitValue(instr.value, out);
        out.push({ op: "struct.get", typeIdx: union.typeIdx, fieldIdx: union.valFieldIdx });
        return;
      }
      case "tag.test": {
        // Emit struct.get $tag; i32.const <tagFor(tag)>; i32.eq.
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "union") {
          throw new Error(`ir/lower: tag.test value must be a union IrType, got ${valueIrType.kind} (${func.name})`);
        }
        const union = resolver.resolveUnion?.(valueIrType.members);
        if (!union) {
          throw new Error(
            `ir/lower: resolver cannot lower union<${valueIrType.members.map((m) => m.kind).join(",")}> (${func.name})`,
          );
        }
        const tag = union.tagFor(instr.tag);
        emitValue(instr.value, out);
        out.push({ op: "struct.get", typeIdx: union.typeIdx, fieldIdx: union.tagFieldIdx });
        out.push({ op: "i32.const", value: tag });
        out.push({ op: "i32.eq" });
        return;
      }
      case "string.const": {
        const ops = resolver.emitStringConst?.(instr.value);
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.const (${func.name})`);
        for (const o of ops) out.push(o);
        return;
      }
      case "string.concat": {
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        const ops = resolver.emitStringConcat?.();
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.concat (${func.name})`);
        for (const o of ops) out.push(o);
        return;
      }
      case "string.eq": {
        emitValue(instr.lhs, out);
        emitValue(instr.rhs, out);
        const ops = resolver.emitStringEquals?.();
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.eq (${func.name})`);
        for (const o of ops) out.push(o);
        if (instr.negate) out.push({ op: "i32.eqz" });
        return;
      }
      case "string.len": {
        emitValue(instr.value, out);
        const ops = resolver.emitStringLen?.();
        if (!ops) throw new Error(`ir/lower: resolver cannot emit string.len (${func.name})`);
        for (const o of ops) out.push(o);
        // IR-level result is f64 — promote the i32 length.
        out.push({ op: "f64.convert_i32_s" });
        return;
      }
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
      case "br": {
        // Unconditional branch — inline the successor block body. Same
        // pattern as the br_if arms above: emit the target block's instrs
        // + terminator directly, no structured `if` wrapper needed since
        // the branch is unconditional. This was added in #1167a so CF can
        // rewrite `br_if(const true, A, B)` to `br(A)` without crashing the
        // lowerer.
        if (t.branch.args.length !== 0) {
          throw new Error(`ir/lower: Phase 1-3 br does not support branch args (${func.name})`);
        }
        const target = func.blocks[t.branch.target as number];
        if (!target) {
          throw new Error(`ir/lower: br target missing in ${func.name}`);
        }
        emitBlockBody(target, out);
        return;
      }
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

  const paramTypes: ValType[] = func.params.map((p) => lowerIrTypeToValType(p.type, resolver, func.name));
  const resultTypes: ValType[] = func.resultTypes.map((t) => lowerIrTypeToValType(t, resolver, func.name));
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
    case "box":
    case "unbox":
    case "tag.test":
      return [instr.value];
    case "string.const":
      return [];
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.len":
      return [instr.value];
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

/**
 * Lower an IrType to the Wasm ValType carried in function signatures / locals.
 *
 * For `val` IrTypes this is identity. For `union` / `boxed` IrTypes we ask
 * the resolver for the corresponding WasmGC struct type and wrap as a `ref`
 * to that struct. Throws if the resolver cannot lower the type — callers must
 * reject such IR before reaching this function.
 */
function lowerIrTypeToValType(t: IrType, resolver: IrLowerResolver, funcName: string): ValType {
  if (t.kind === "val") return t.val;
  if (t.kind === "string") {
    const sty = resolver.resolveString?.();
    if (!sty) {
      throw new Error(`ir/lower: resolver cannot lower string IrType (${funcName})`);
    }
    return sty;
  }
  if (t.kind === "union") {
    const union = resolver.resolveUnion?.(t.members);
    if (!union) {
      throw new Error(`ir/lower: resolver cannot lower union<${t.members.map((m) => m.kind).join(",")}> (${funcName})`);
    }
    return { kind: "ref", typeIdx: union.typeIdx };
  }
  // boxed
  const box = resolver.resolveBoxed?.(t.inner);
  if (!box) {
    throw new Error(`ir/lower: resolver cannot lower boxed<${t.inner.kind}> (${funcName})`);
  }
  return { kind: "ref", typeIdx: box.typeIdx };
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
    case "null": {
      const valTy = instr.resultType ? asVal(instr.resultType) : null;
      if (valTy && valTy.kind === "ref_null") {
        out.push({ op: "ref.null", typeIdx: (valTy as { typeIdx: number }).typeIdx } as unknown as Instr);
        return;
      }
      throw new Error(`ir/lower: const null must have ref_null resultType (${funcName})`);
    }
    case "undefined":
      throw new Error(`ir/lower: Phase 1 does not materialize 'undefined' constants (${funcName})`);
  }
}
