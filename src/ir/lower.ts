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
  type IrClassShape,
  type IrClosureSignature,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrObjectShape,
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

/**
 * Information about a registered WasmGC struct that backs an
 * `IrType.object` shape. The resolver memoizes one of these per shape.
 *
 * `fieldIdx(name)` returns the WasmGC struct's field index for the given
 * shape field name (in the shape's canonical order). It throws when the
 * name is not a member of the shape — the lowerer catches via the
 * surrounding try/catch and emits a clean fall-back error.
 */
export interface IrObjectStructLowering {
  /** WasmGC type index of the registered struct. */
  readonly typeIdx: number;
  /** Field index for each field name in the shape's canonical order. */
  fieldIdx(name: string): number;
}

/**
 * Slice 3 (#1169c): WasmGC type info for a closure value. Two structs
 * are involved per closure construction site:
 *   - The SUPERTYPE struct (`structTypeIdx`): contains only the funcref
 *     field. Carried by the IrType.closure ValType so all closures
 *     sharing a signature have the same Wasm-level type.
 *   - The SUBTYPE struct (resolved via `resolveClosureSubtype`): adds
 *     the capture fields. Constructed at the closure's creation site
 *     (`struct.new <subtype>`) and `ref.cast`-ed inside the lifted
 *     body to read captures.
 *
 * `funcTypeIdx` is the lifted function's Wasm func type
 * `(ref $base, ...sig.params) -> sig.returnType` — used by `call_ref`
 * at the call site.
 */
export interface IrClosureLowering {
  readonly structTypeIdx: number;
  readonly funcFieldIdx: number;
  /** Field index for capture position `i` (0-based). Valid only for subtype lowerings. */
  capFieldIdx(index: number): number;
  readonly funcTypeIdx: number;
}

/**
 * Slice 3 (#1169c): WasmGC type info for a ref cell over a primitive
 * value type. Single-field struct `(struct (field $value (mut T)))`.
 */
export interface IrRefCellLowering {
  readonly typeIdx: number;
  readonly fieldIdx: number;
}

/**
 * Slice 6 (#1169e): WasmGC type info for a vec struct (the runtime layout
 * for `Array<T>` / tuple types). The struct is `{ length: i32, data: (ref
 * $arr) }` where `$arr` is the element array type. This interface is the
 * lowerer's contract for emitting `vec.len` and `vec.get` against a known
 * vec value's IrType.
 *
 *   - `vecStructTypeIdx`   Wasm struct type index of the vec.
 *   - `lengthFieldIdx`     field index of the i32 length (typically 0).
 *   - `dataFieldIdx`       field index of the data array ref (typically 1).
 *   - `arrayTypeIdx`       Wasm array type index of the data array.
 *   - `elementValType`     element ValType — used by `vec.get` to lower
 *                           the result and (recursively, via the resolver)
 *                           to widen the element to the loop variable's
 *                           declared type when needed.
 */
export interface IrVecLowering {
  readonly vecStructTypeIdx: number;
  readonly lengthFieldIdx: number;
  readonly dataFieldIdx: number;
  readonly arrayTypeIdx: number;
  readonly elementValType: ValType;
}

/**
 * Slice 4 (#1169d): WasmGC type info for a class declared in the
 * compilation unit. The class's struct + constructor + method funcs
 * are all registered by the legacy `collectClassDeclaration` pass before
 * the IR runs; this interface just exposes them by name.
 *
 *   - `structTypeIdx`        Wasm struct type index for the class
 *   - `fieldIdx(name)`       Wasm struct field index for a user field name
 *                             (the legacy `__tag` prefix at field 0 is
 *                             accounted for here so the IR doesn't need to
 *                             reason about it).
 *   - `constructorFuncName`  legacy-registered name of the constructor
 *                             function (`<className>_new`); the resolver's
 *                             `resolveFunc` maps it to the funcIdx.
 *   - `methodFuncName(name)` legacy-registered name of an instance method
 *                             (`<className>_<methodName>`); the resolver's
 *                             `resolveFunc` maps it to the funcIdx.
 */
export interface IrClassLowering {
  readonly structTypeIdx: number;
  fieldIdx(name: string): number;
  readonly constructorFuncName: string;
  methodFuncName(name: string): string;
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
   * Resolve (and memoise) the WasmGC struct type for an `IrType.object`
   * shape. Returns `null` if the shape contains a field type the backend
   * can't lower (e.g. a nested boxed-IrType the V1 boxed registry doesn't
   * support).
   *
   * The slice-2 implementation in `integration.ts` delegates to a shared
   * `ObjectStructRegistry` that hashes shapes against
   * `ctx.anonStructHash`, so legacy `ensureStructForType` and the IR path
   * converge on a single WasmGC struct for any given shape.
   */
  resolveObject?(shape: IrObjectShape): IrObjectStructLowering | null;
  /**
   * Slice 3 (#1169c): resolve the SUPERTYPE WasmGC struct for a closure
   * signature. Carried by the IrType.closure ValType so all
   * same-signature closures share one Wasm type. Returns `null` if the
   * signature contains an IrType the backend can't lower (e.g. a
   * nested object shape the slice-2 resolver hasn't pre-walked).
   */
  resolveClosure?(signature: IrClosureSignature): IrClosureLowering | null;
  /**
   * Slice 3 (#1169c): resolve the SUBTYPE WasmGC struct for a specific
   * closure-construction site. Different `(signature, captureFieldTypes)`
   * pairs produce different subtypes of the supertype struct, so the
   * lifted body's `ref.cast` recovers capture-field positions.
   */
  resolveClosureSubtype?(signature: IrClosureSignature, captureFieldTypes: readonly IrType[]): IrClosureLowering | null;
  /**
   * Slice 3 (#1169c): resolve the WasmGC struct type for a ref cell
   * over a primitive ValType. Delegates to the legacy
   * `getOrRegisterRefCellType` so legacy and IR ref cells share one
   * type per inner ValType.
   */
  resolveRefCell?(inner: ValType): IrRefCellLowering | null;
  /**
   * Slice 4 (#1169d): resolve the WasmGC struct + constructor + method
   * funcs for a class declared in the compilation unit. Returns `null`
   * if `shape.className` was not registered by the legacy class
   * collection pass — that's a selector bug.
   */
  resolveClass?(shape: IrClassShape): IrClassLowering | null;
  /**
   * Slice 6 (#1169e): resolve a vec struct given its top-level Wasm
   * ValType. The IR carries the vec's value as a `ref`/`ref_null` to a
   * registered vec struct; the resolver inspects the struct's fields to
   * verify the layout is `{ length: i32, data: (ref $arr) }` and returns
   * the typeIdx + field indices + element ValType. Returns `null` when
   * the type isn't a recognisable vec — caller treats that as a bug
   * (selector should have rejected the for-of).
   */
  resolveVec?(valType: ValType): IrVecLowering | null;
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
  // Slice 6 (#1169e): also walk inside `forof.vec` body buffers so SSA
  // definitions made in a loop body register in the def maps. The body
  // is treated as a continuation of its containing block for SSA-scope
  // purposes (a value defined inside the body is reachable only from
  // there, but multi-use of an OUTER value across the boundary is what
  // we care about for cross-block local materialisation).
  const registerInstrDefs = (instr: IrInstr, blockId: number): void => {
    if (instr.result !== null) {
      if (defBy.has(instr.result)) {
        throw new Error(`ir/lower: duplicate SSA def for ${instr.result} in ${func.name}`);
      }
      defBy.set(instr.result, instr);
      defBlockOf.set(instr.result, blockId);
    }
    if (instr.kind === "forof.vec" || instr.kind === "forof.iter") {
      for (const sub of instr.body) registerInstrDefs(sub, blockId);
    }
  };
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      registerInstrDefs(instr, block.id as number);
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
      // Slice 6 (#1169e): record uses inside `forof.vec` body buffers as
      // belonging to the SAME block as the for-of itself. A use inside
      // the body is "in" the surrounding block from the perspective of
      // structured Wasm emission — except that the loop's repeated
      // execution makes ANY outer-defined value's use a candidate for
      // cross-block materialisation. Mark uses with a synthetic block
      // ID (-1 for "inside-body") so the cross-block test always fires.
      if (instr.kind === "forof.vec" || instr.kind === "forof.iter") {
        for (const u of collectForOfBodyUses(instr.body)) recordUse(u, -1);
      }
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
  // Slice 6 (#1169e): walk into `forof.vec` body buffers so SSA values
  // defined inside a body get Wasm locals allocated alongside the
  // outer-block SSA values. The body's def order is preserved (locals
  // appear in the order their defining instr is encountered).
  const allocLocalForInstr = (instr: IrInstr): void => {
    if (instr.result !== null && needsLocal.has(instr.result)) {
      if (!instr.resultType) {
        throw new Error(`ir/lower: local-bound SSA value ${instr.result} has no resultType in ${func.name}`);
      }
      const idx = func.params.length + locals.length;
      locals.push({ name: `$ir${instr.result}`, type: lowerIrTypeToValType(instr.resultType, resolver, func.name) });
      localIdx.set(instr.result, idx);
    }
    if (instr.kind === "forof.vec" || instr.kind === "forof.iter") {
      for (const sub of instr.body) allocLocalForInstr(sub);
    }
  };
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      allocLocalForInstr(instr);
    }
  }

  // Slice 6 (#1169e): append slot locals AFTER all SSA-driven locals.
  // `slotWasmIdx(slotIndex)` returns the absolute Wasm local index for
  // a given slot.
  const slotBase = func.params.length + locals.length;
  const slotDefs = func.slots ?? [];
  for (const slot of slotDefs) {
    locals.push({ name: `$slot_${slot.name}`, type: slot.type });
  }
  const slotWasmIdx = (slotIndex: number): number => slotBase + slotIndex;

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
      case "object.new": {
        const obj = resolver.resolveObject?.(instr.shape);
        if (!obj) {
          throw new Error(`ir/lower: resolver cannot lower object<${describeShape(instr.shape)}> (${func.name})`);
        }
        // Push values in canonical (sorted) field order — same order as
        // shape.fields, which is also the WasmGC struct's declared field
        // order. The builder enforces value-count parity with shape arity,
        // so this loop always produces the right stack shape.
        for (const v of instr.values) emitValue(v, out);
        out.push({ op: "struct.new", typeIdx: obj.typeIdx });
        return;
      }
      case "object.get": {
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "object") {
          throw new Error(
            `ir/lower: object.get value must be an object IrType, got ${valueIrType.kind} (${func.name})`,
          );
        }
        const obj = resolver.resolveObject?.(valueIrType.shape);
        if (!obj) {
          throw new Error(`ir/lower: resolver cannot lower object<${describeShape(valueIrType.shape)}> (${func.name})`);
        }
        emitValue(instr.value, out);
        out.push({ op: "struct.get", typeIdx: obj.typeIdx, fieldIdx: obj.fieldIdx(instr.name) });
        return;
      }
      case "object.set": {
        const valueIrType = typeOf(instr.value);
        if (valueIrType.kind !== "object") {
          throw new Error(
            `ir/lower: object.set value must be an object IrType, got ${valueIrType.kind} (${func.name})`,
          );
        }
        const obj = resolver.resolveObject?.(valueIrType.shape);
        if (!obj) {
          throw new Error(`ir/lower: resolver cannot lower object<${describeShape(valueIrType.shape)}> (${func.name})`);
        }
        emitValue(instr.value, out);
        emitValue(instr.newValue, out);
        out.push({ op: "struct.set", typeIdx: obj.typeIdx, fieldIdx: obj.fieldIdx(instr.name) });
        return;
      }
      // Slice 3 (#1169c): closure / ref-cell ops.
      case "closure.new": {
        const sub = resolver.resolveClosureSubtype?.(instr.signature, instr.captureFieldTypes);
        if (!sub) {
          throw new Error(`ir/lower: resolver cannot lower closure subtype (${func.name})`);
        }
        const liftedIdx = resolver.resolveFunc(instr.liftedFunc);
        // ref.func $lifted, push captures, struct.new <subtype>.
        out.push({ op: "ref.func", funcIdx: liftedIdx } as unknown as Instr);
        for (const cap of instr.captures) emitValue(cap, out);
        out.push({ op: "struct.new", typeIdx: sub.structTypeIdx });
        return;
      }
      case "closure.cap": {
        // The lifted body knows its own subtype via the IrFunction's
        // closureSubtype metadata (set at lift time). Read that to find
        // the cast target and field index.
        const subMeta = func.closureSubtype;
        if (!subMeta) {
          throw new Error(`ir/lower: closure.cap requires func.closureSubtype metadata (${func.name})`);
        }
        const sub = resolver.resolveClosureSubtype?.(subMeta.signature, subMeta.captureFieldTypes);
        if (!sub) {
          throw new Error(`ir/lower: resolver cannot resolve closure subtype for ${func.name}`);
        }
        emitValue(instr.self, out);
        out.push({ op: "ref.cast", typeIdx: sub.structTypeIdx } as unknown as Instr);
        out.push({ op: "struct.get", typeIdx: sub.structTypeIdx, fieldIdx: sub.capFieldIdx(instr.index) });
        return;
      }
      case "closure.call": {
        const calleeT = typeOf(instr.callee);
        if (calleeT.kind !== "closure") {
          throw new Error(`ir/lower: closure.call callee must be closure IrType, got ${calleeT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClosure?.(calleeT.signature);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower closure for call (${func.name})`);
        }
        // Push __self (closure value), then user args, then the closure
        // value AGAIN to extract the funcref. The double-emit is the
        // reason `collectIrUses` returns `callee` twice — that forces
        // the closure SSA value into a Wasm local so the second emit
        // is just `local.get`, not a re-emission of the producing tree.
        emitValue(instr.callee, out);
        for (const a of instr.args) emitValue(a, out);
        emitValue(instr.callee, out);
        out.push({ op: "struct.get", typeIdx: cl.structTypeIdx, fieldIdx: cl.funcFieldIdx });
        // The struct's `func` field is typed as the abstract `funcref`
        // (matches the legacy `getOrCreateFuncRefWrapperTypes` pattern,
        // which avoids a circular type reference between the struct and
        // its lifted func type). `call_ref` requires a typed funcref, so
        // we emit `ref.cast` to convert.
        out.push({ op: "ref.cast", typeIdx: cl.funcTypeIdx } as unknown as Instr);
        out.push({ op: "call_ref", typeIdx: cl.funcTypeIdx } as unknown as Instr);
        return;
      }
      case "refcell.new": {
        const valueIrType = typeOf(instr.value);
        const inner = asVal(valueIrType);
        if (!inner) {
          throw new Error(`ir/lower: refcell.new value must be a val-kind IrType (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(inner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${inner.kind}> (${func.name})`);
        }
        emitValue(instr.value, out);
        out.push({ op: "struct.new", typeIdx: cell.typeIdx });
        return;
      }
      case "refcell.get": {
        const cellT = typeOf(instr.cell);
        if (cellT.kind !== "boxed") {
          throw new Error(`ir/lower: refcell.get cell must be boxed, got ${cellT.kind} (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(cellT.inner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${cellT.inner.kind}> (${func.name})`);
        }
        emitValue(instr.cell, out);
        out.push({ op: "struct.get", typeIdx: cell.typeIdx, fieldIdx: cell.fieldIdx });
        return;
      }
      case "refcell.set": {
        const cellT = typeOf(instr.cell);
        if (cellT.kind !== "boxed") {
          throw new Error(`ir/lower: refcell.set cell must be boxed, got ${cellT.kind} (${func.name})`);
        }
        const cell = resolver.resolveRefCell?.(cellT.inner);
        if (!cell) {
          throw new Error(`ir/lower: resolver cannot lower refcell<${cellT.inner.kind}> (${func.name})`);
        }
        emitValue(instr.cell, out);
        emitValue(instr.value, out);
        out.push({ op: "struct.set", typeIdx: cell.typeIdx, fieldIdx: cell.fieldIdx });
        return;
      }
      // Slice 4 (#1169d): class ops.
      case "class.new": {
        const cl = resolver.resolveClass?.(instr.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${instr.shape.className} (${func.name})`);
        }
        for (const a of instr.args) emitValue(a, out);
        out.push({
          op: "call",
          funcIdx: resolver.resolveFunc({ kind: "func", name: cl.constructorFuncName }),
        });
        return;
      }
      case "class.get": {
        const recvT = typeOf(instr.value);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.get receiver must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClass?.(recvT.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        emitValue(instr.value, out);
        out.push({ op: "struct.get", typeIdx: cl.structTypeIdx, fieldIdx: cl.fieldIdx(instr.fieldName) });
        return;
      }
      case "class.set": {
        const recvT = typeOf(instr.value);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.set receiver must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClass?.(recvT.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        emitValue(instr.value, out);
        emitValue(instr.newValue, out);
        out.push({ op: "struct.set", typeIdx: cl.structTypeIdx, fieldIdx: cl.fieldIdx(instr.fieldName) });
        return;
      }
      case "class.call": {
        const recvT = typeOf(instr.receiver);
        if (recvT.kind !== "class") {
          throw new Error(`ir/lower: class.call receiver must be class IrType, got ${recvT.kind} (${func.name})`);
        }
        const cl = resolver.resolveClass?.(recvT.shape);
        if (!cl) {
          throw new Error(`ir/lower: resolver cannot lower class ${recvT.shape.className} (${func.name})`);
        }
        // `this` first, then user args, then call $<className>_<methodName>.
        emitValue(instr.receiver, out);
        for (const a of instr.args) emitValue(a, out);
        out.push({
          op: "call",
          funcIdx: resolver.resolveFunc({ kind: "func", name: cl.methodFuncName(instr.methodName) }),
        });
        return;
      }
      // Slice 6 (#1169e): slot / vec / for-of ops.
      case "slot.read": {
        out.push({ op: "local.get", index: slotWasmIdx(instr.slotIndex) });
        return;
      }
      case "slot.write": {
        emitValue(instr.value, out);
        out.push({ op: "local.set", index: slotWasmIdx(instr.slotIndex) });
        return;
      }
      case "vec.len": {
        const vecT = asVal(typeOf(instr.vec));
        if (!vecT) throw new Error(`ir/lower: vec.len vec must be a val IrType (${func.name})`);
        const vec = resolver.resolveVec?.(vecT);
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.len (${func.name})`);
        emitValue(instr.vec, out);
        out.push({ op: "struct.get", typeIdx: vec.vecStructTypeIdx, fieldIdx: vec.lengthFieldIdx });
        // IR-level result is f64 (matches JS Number semantics) — promote.
        out.push({ op: "f64.convert_i32_s" });
        return;
      }
      case "vec.get": {
        const vecT = asVal(typeOf(instr.vec));
        if (!vecT) throw new Error(`ir/lower: vec.get vec must be a val IrType (${func.name})`);
        const vec = resolver.resolveVec?.(vecT);
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for vec.get (${func.name})`);
        // Stack: dataArray, index → element
        emitValue(instr.vec, out);
        out.push({ op: "struct.get", typeIdx: vec.vecStructTypeIdx, fieldIdx: vec.dataFieldIdx });
        emitValue(instr.index, out);
        out.push({ op: "array.get", typeIdx: vec.arrayTypeIdx } as unknown as Instr);
        return;
      }
      // Slice 7a (#1169f): generator ops.
      case "gen.push": {
        // Dispatch on the value's IrType to pick the typed
        // `__gen_push_*` host import. Slice 7a only emits f64 (the
        // selector restricts yield operands to numeric expressions);
        // i32 / externref / string variants land in 7b.
        const valueT = asVal(typeOf(instr.value));
        if (!valueT || valueT.kind !== "f64") {
          throw new Error(
            `ir/lower: gen.push value must be f64 in slice 7a (got ${valueT?.kind ?? "non-val"}) (${func.name})`,
          );
        }
        if (func.generatorBufferSlot === undefined) {
          throw new Error(`ir/lower: gen.push requires func.generatorBufferSlot (${func.name})`);
        }
        const importName = "__gen_push_f64";
        const fnIdx = resolver.resolveFunc({ kind: "func", name: importName });
        // Stack: buffer, value → (void); call __gen_push_f64.
        out.push({ op: "local.get", index: slotWasmIdx(func.generatorBufferSlot) });
        emitValue(instr.value, out);
        out.push({ op: "call", funcIdx: fnIdx });
        return;
      }
      case "gen.epilogue": {
        // Emit `__create_generator(buffer, ref.null.extern)`. The
        // pendingThrow argument is always `ref.null.extern` in slice 7a
        // (we don't yet wrap the body in a try/catch — see the doc on
        // IrInstrGenEpilogue for the deferred-throw caveat).
        if (func.generatorBufferSlot === undefined) {
          throw new Error(`ir/lower: gen.epilogue requires func.generatorBufferSlot (${func.name})`);
        }
        const fnIdx = resolver.resolveFunc({ kind: "func", name: "__create_generator" });
        out.push({ op: "local.get", index: slotWasmIdx(func.generatorBufferSlot) });
        out.push({ op: "ref.null.extern" } as unknown as Instr);
        out.push({ op: "call", funcIdx: fnIdx });
        return;
      }
      case "forof.vec": {
        // The forof.vec instr is statement-level (result: null) but we
        // implement it inside emitInstrTree for code-organization parity
        // with the other instrs. The lowerer in `emitBlockBody` calls
        // `emitInstrTree` for void-producing instrs as a unit.
        const vecT = asVal(typeOf(instr.vec));
        if (!vecT) throw new Error(`ir/lower: forof.vec vec must be a val IrType (${func.name})`);
        const vec = resolver.resolveVec?.(vecT);
        if (!vec) throw new Error(`ir/lower: resolver cannot lower vec for forof.vec (${func.name})`);

        // Push the vec ref.
        emitValue(instr.vec, out);
        // Save to vec slot.
        out.push({ op: "local.set", index: slotWasmIdx(instr.vecSlot) });

        // length = vec.length
        out.push({ op: "local.get", index: slotWasmIdx(instr.vecSlot) });
        out.push({ op: "struct.get", typeIdx: vec.vecStructTypeIdx, fieldIdx: vec.lengthFieldIdx });
        out.push({ op: "local.set", index: slotWasmIdx(instr.lengthSlot) });

        // data = vec.data
        out.push({ op: "local.get", index: slotWasmIdx(instr.vecSlot) });
        out.push({ op: "struct.get", typeIdx: vec.vecStructTypeIdx, fieldIdx: vec.dataFieldIdx });
        out.push({ op: "local.set", index: slotWasmIdx(instr.dataSlot) });

        // counter = 0
        out.push({ op: "i32.const", value: 0 });
        out.push({ op: "local.set", index: slotWasmIdx(instr.counterSlot) });

        // Build loop body Wasm ops by recursively emitting body instrs.
        const loopBody: Instr[] = [];
        // if (counter >= length) br 1 (exit)
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.counterSlot) });
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.lengthSlot) });
        loopBody.push({ op: "i32.ge_s" });
        loopBody.push({ op: "br_if", depth: 1 });

        // element = data[counter]
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.dataSlot) });
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.counterSlot) });
        loopBody.push({ op: "array.get", typeIdx: vec.arrayTypeIdx } as unknown as Instr);
        loopBody.push({ op: "local.set", index: slotWasmIdx(instr.elementSlot) });

        // Body instrs
        for (const bodyInstr of instr.body) {
          if (bodyInstr.result === null) {
            emitInstrTree(bodyInstr, loopBody);
          } else if (crossBlock.has(bodyInstr.result)) {
            emitInstrTree(bodyInstr, loopBody);
            loopBody.push({ op: "local.set", index: localIdx.get(bodyInstr.result)! });
            materialized.add(bodyInstr.result);
          }
          // Intra-block multi-use: handled at use site via tee pattern.
        }

        // counter = counter + 1
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.counterSlot) });
        loopBody.push({ op: "i32.const", value: 1 });
        loopBody.push({ op: "i32.add" });
        loopBody.push({ op: "local.set", index: slotWasmIdx(instr.counterSlot) });

        // br 0 (continue)
        loopBody.push({ op: "br", depth: 0 });

        // Wrap in block { loop { ... } }
        out.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: loopBody,
            },
          ],
        });
        return;
      }
      // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
      case "coerce.to_externref": {
        // Push the value, then convert any (ref) → externref. If the
        // input is already externref, the convert is a wasm validation
        // no-op (it's permitted on already-externref values). For all
        // ref-typed inputs the wasm engine simply re-tags the reference
        // so it can flow into externref-typed positions.
        emitValue(instr.value, out);
        out.push({ op: "extern.convert_any" } as unknown as Instr);
        return;
      }
      case "iter.new": {
        const fnName = instr.async ? "__async_iterator" : "__iterator";
        const funcIdx = resolver.resolveFunc({ kind: "func", name: fnName });
        emitValue(instr.iterable, out);
        out.push({ op: "call", funcIdx });
        return;
      }
      case "iter.next": {
        const funcIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_next" });
        emitValue(instr.iter, out);
        out.push({ op: "call", funcIdx });
        return;
      }
      case "iter.done": {
        const funcIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_done" });
        emitValue(instr.resultObj, out);
        out.push({ op: "call", funcIdx });
        return;
      }
      case "iter.value": {
        const funcIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_value" });
        emitValue(instr.resultObj, out);
        out.push({ op: "call", funcIdx });
        return;
      }
      case "iter.return": {
        const funcIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_return" });
        emitValue(instr.iter, out);
        out.push({ op: "call", funcIdx });
        return;
      }
      case "forof.iter": {
        // Mirror of forof.vec but using the iterator protocol. The lowerer
        // emits the `block { loop { ... } }` Wasm pattern documented on
        // `IrInstrForOfIter` in `nodes.ts`.
        const iteratorIdx = resolver.resolveFunc({ kind: "func", name: "__iterator" });
        const iteratorNextIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_next" });
        const iteratorDoneIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_done" });
        const iteratorValueIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_value" });
        const iteratorReturnIdx = resolver.resolveFunc({ kind: "func", name: "__iterator_return" });

        // iter = __iterator(iterable)
        emitValue(instr.iterable, out);
        out.push({ op: "call", funcIdx: iteratorIdx });
        out.push({ op: "local.set", index: slotWasmIdx(instr.iterSlot) });

        // Build loop body Wasm ops.
        const loopBody: Instr[] = [];
        // result = iter.next(iter)
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.iterSlot) });
        loopBody.push({ op: "call", funcIdx: iteratorNextIdx });
        loopBody.push({ op: "local.tee", index: slotWasmIdx(instr.resultSlot) });
        // if (iter.done(result)) br 1 (exit)
        loopBody.push({ op: "call", funcIdx: iteratorDoneIdx });
        loopBody.push({ op: "br_if", depth: 1 });
        // element = iter.value(result)
        loopBody.push({ op: "local.get", index: slotWasmIdx(instr.resultSlot) });
        loopBody.push({ op: "call", funcIdx: iteratorValueIdx });
        loopBody.push({ op: "local.set", index: slotWasmIdx(instr.elementSlot) });

        // Body instrs (same materialisation pattern as forof.vec).
        for (const bodyInstr of instr.body) {
          if (bodyInstr.result === null) {
            emitInstrTree(bodyInstr, loopBody);
          } else if (crossBlock.has(bodyInstr.result)) {
            emitInstrTree(bodyInstr, loopBody);
            loopBody.push({ op: "local.set", index: localIdx.get(bodyInstr.result)! });
            materialized.add(bodyInstr.result);
          }
        }

        // br 0 (continue)
        loopBody.push({ op: "br", depth: 0 });

        // block { loop { ... } }
        out.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: loopBody,
            },
          ],
        });

        // Normal-exit close: iter.return(iter). Note this runs only on
        // normal loop exit (done=true). Abrupt exits (break/return)
        // would need a try/finally — slice 6 step E (#1169h dependency).
        out.push({ op: "local.get", index: slotWasmIdx(instr.iterSlot) });
        out.push({ op: "call", funcIdx: iteratorReturnIdx });
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
    case "object.new":
      return instr.values;
    case "object.get":
      return [instr.value];
    case "object.set":
      return [instr.value, instr.newValue];
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new":
      return instr.captures;
    case "closure.cap":
      return [instr.self];
    case "closure.call":
      // INTENTIONAL DOUBLE COUNT for `callee`: the Wasm emission pattern
      // pushes the closure value twice (once as the implicit __self
      // argument, once as the source of the funcref struct.get). The
      // use-counter must see TWO uses so the closure value gets a Wasm
      // local — otherwise we'd re-emit the (potentially side-effecting)
      // closure subtree. The verifier's collectUses counts it ONCE
      // because that's a pure SSA def→use relationship.
      return [instr.callee, ...instr.args, instr.callee];
    case "refcell.new":
      return [instr.value];
    case "refcell.get":
      return [instr.cell];
    case "refcell.set":
      return [instr.cell, instr.value];
    // Slice 4 (#1169d): class ops.
    case "class.new":
      return instr.args;
    case "class.get":
      return [instr.value];
    case "class.set":
      return [instr.value, instr.newValue];
    case "class.call":
      return [instr.receiver, ...instr.args];
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return [];
    case "slot.write":
      return [instr.value];
    case "vec.len":
      return [instr.vec];
    case "vec.get":
      return [instr.vec, instr.index];
    case "forof.vec":
      // Body uses are collected separately and merged in by
      // `lowerIrFunctionToWasm`.
      return [instr.vec];
    // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
    case "coerce.to_externref":
      return [instr.value];
    case "iter.new":
      return [instr.iterable];
    case "iter.next":
      return [instr.iter];
    case "iter.done":
      return [instr.resultObj];
    case "iter.value":
      return [instr.resultObj];
    case "iter.return":
      return [instr.iter];
    case "forof.iter":
      // Same rationale as forof.vec — body uses surfaced separately.
      return [instr.iterable];
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      // No SSA operand uses — buffer + pendingThrow are read from Wasm
      // locals (slot indices stored on the IrFunction).
      return [];
  }
}

/**
 * Slice 6 (#1169e): walk a `forof.vec` body recursively and collect every
 * SSA value referenced. Used by the cross-block use counter to ensure
 * outer-scope values used inside the loop body are materialised in Wasm
 * locals before the loop starts.
 */
export function collectForOfBodyUses(body: readonly IrInstr[]): IrValueId[] {
  const uses: IrValueId[] = [];
  for (const instr of body) {
    for (const u of collectIrUses(instr)) uses.push(u);
    if (instr.kind === "forof.vec" || instr.kind === "forof.iter") {
      for (const u of collectForOfBodyUses(instr.body)) uses.push(u);
    }
  }
  return uses;
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
export function lowerIrTypeToValType(t: IrType, resolver: IrLowerResolver, funcName: string): ValType {
  if (t.kind === "val") return t.val;
  if (t.kind === "string") {
    const sty = resolver.resolveString?.();
    if (!sty) {
      throw new Error(`ir/lower: resolver cannot lower string IrType (${funcName})`);
    }
    return sty;
  }
  if (t.kind === "object") {
    // Object IrTypes always lower to a (ref $struct) — mutability of the
    // backing reference is decided by the caller (locals/params get a
    // non-null ref since `object.new` produces a definite struct; field
    // slots get a ref_null in the struct definition itself, see
    // `ObjectStructRegistry.resolve`).
    const obj = resolver.resolveObject?.(t.shape);
    if (!obj) {
      throw new Error(`ir/lower: resolver cannot lower object<${describeShape(t.shape)}> (${funcName})`);
    }
    return { kind: "ref", typeIdx: obj.typeIdx };
  }
  if (t.kind === "closure") {
    // Slice 3 (#1169c): a closure value lowers to a (ref $base_struct)
    // — the supertype struct shared by all closures with this signature.
    // `call_ref` against the base func type accepts any subtype value,
    // so the same Wasm-level type works for both construction (subtype)
    // and call (supertype). The resolver registers the supertype lazily
    // on first use.
    const cl = resolver.resolveClosure?.(t.signature);
    if (!cl) {
      throw new Error(`ir/lower: resolver cannot lower closure (${funcName})`);
    }
    return { kind: "ref", typeIdx: cl.structTypeIdx };
  }
  if (t.kind === "class") {
    // Slice 4 (#1169d): class instances lower to a non-null `(ref
    // $ClassStruct)`. The struct is registered by the legacy
    // `collectClassDeclaration` pass — the resolver looks it up by
    // `shape.className`.
    const cl = resolver.resolveClass?.(t.shape);
    if (!cl) {
      throw new Error(`ir/lower: resolver cannot lower class ${t.shape.className} (${funcName})`);
    }
    return { kind: "ref", typeIdx: cl.structTypeIdx };
  }
  if (t.kind === "union") {
    const union = resolver.resolveUnion?.(t.members);
    if (!union) {
      throw new Error(`ir/lower: resolver cannot lower union<${t.members.map((m) => m.kind).join(",")}> (${funcName})`);
    }
    return { kind: "ref", typeIdx: union.typeIdx };
  }
  // boxed (refcell)
  // Slice 3 (#1169c): the resolver delegates to the legacy ref-cell
  // registry so legacy and IR ref cells share one WasmGC struct.
  if (resolver.resolveRefCell) {
    const cell = resolver.resolveRefCell(t.inner);
    if (cell) {
      return { kind: "ref", typeIdx: cell.typeIdx };
    }
  }
  const box = resolver.resolveBoxed?.(t.inner);
  if (!box) {
    throw new Error(`ir/lower: resolver cannot lower boxed<${t.inner.kind}> (${funcName})`);
  }
  return { kind: "ref", typeIdx: box.typeIdx };
}

/**
 * Compact debug string for an object shape — used in error messages so a
 * mismatched shape surfaces with its field list rather than just an opaque
 * "object" tag. Field types are rendered shallowly (kind only) to keep
 * messages readable; nested objects show as `object{...}` recursively.
 */
function describeShape(shape: IrObjectShape): string {
  return shape.fields.map((f) => `${f.name}:${describeIrTypeShallow(f.type)}`).join(",");
}

function describeIrTypeShallow(t: IrType): string {
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "object") return `object{${describeShape(t.shape)}}`;
  if (t.kind === "closure") {
    const ps = t.signature.params.map(describeIrTypeShallow).join(",");
    return `closure(${ps})->${describeIrTypeShallow(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "union") return `union<${t.members.map((m) => m.kind).join(",")}>`;
  return `boxed<${t.inner.kind}>`;
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
