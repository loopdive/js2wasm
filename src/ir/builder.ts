// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IrFunctionBuilder — imperative builder for constructing IrFunction values.
//
// Phase 1 keeps the API narrow: allocate params, open a block, emit instrs,
// terminate the block. No control-flow primitives yet (if/loop sugar) — those
// come in Phase 2 together with AST→IR lowering for real control-flow.

import {
  asBlockId,
  asValueId,
  IrBinop,
  IrBlock,
  IrBlockId,
  IrClassShape,
  IrClosureSignature,
  IrConst,
  IrFuncRef,
  IrFunction,
  IrGlobalRef,
  IrInstr,
  IrObjectShape,
  IrParam,
  IrTerminator,
  IrType,
  IrUnop,
  IrValueId,
  IrValueIdAllocator,
} from "./nodes.js";
import type { Instr, ValType } from "./types.js";

interface OpenBlock {
  readonly id: IrBlockId;
  readonly blockArgs: IrValueId[];
  readonly blockArgTypes: IrType[];
  readonly instrs: IrInstr[];
}

export class IrFunctionBuilder {
  private readonly allocator = new IrValueIdAllocator();
  private readonly params: IrParam[] = [];
  private readonly finished: IrBlock[] = [];
  private readonly valueTypes = new Map<IrValueId, IrType>();
  private current: OpenBlock | null = null;
  // Block IDs are assigned from a monotonic counter rather than from
  // `finished.length`, so forward references (br_if with a not-yet-opened
  // target) can reserve an ID before its defining block exists.
  private nextBlockId = 0;
  private readonly reserved = new Set<IrBlockId>();

  constructor(
    private readonly name: string,
    private readonly resultTypes: readonly IrType[],
    private readonly exported = false,
  ) {}

  // --- params -------------------------------------------------------------

  addParam(name: string, type: IrType): IrValueId {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: params must be declared before the first block (func ${this.name})`);
    }
    const value = this.allocator.fresh();
    this.valueTypes.set(value, type);
    this.params.push({ name, type, value });
    return value;
  }

  // --- blocks -------------------------------------------------------------

  openBlock(blockArgTypes: readonly IrType[] = []): IrBlockId {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: previous block not terminated (func ${this.name})`);
    }
    const id = asBlockId(this.nextBlockId++);
    this.current = this.makeOpen(id, blockArgTypes);
    return id;
  }

  /**
   * Allocate a block ID without opening it — for forward references in a
   * terminator that must branch to a block we haven't emitted yet. The caller
   * MUST later activate it with `openReservedBlock(id)` before `finish()`.
   */
  reserveBlockId(): IrBlockId {
    const id = asBlockId(this.nextBlockId++);
    this.reserved.add(id);
    return id;
  }

  /**
   * Activate a previously reserved block ID as the current open block.
   */
  openReservedBlock(id: IrBlockId, blockArgTypes: readonly IrType[] = []): void {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: previous block not terminated (func ${this.name})`);
    }
    if (!this.reserved.has(id)) {
      throw new Error(`IrFunctionBuilder: block ${id as number} was not reserved (func ${this.name})`);
    }
    this.reserved.delete(id);
    this.current = this.makeOpen(id, blockArgTypes);
  }

  private makeOpen(id: IrBlockId, blockArgTypes: readonly IrType[]): OpenBlock {
    const blockArgs: IrValueId[] = [];
    for (const ty of blockArgTypes) {
      const v = this.allocator.fresh();
      this.valueTypes.set(v, ty);
      blockArgs.push(v);
    }
    return { id, blockArgs, blockArgTypes: [...blockArgTypes], instrs: [] };
  }

  blockArg(slot: number): IrValueId {
    const cur = this.requireBlock();
    if (slot < 0 || slot >= cur.blockArgs.length) {
      throw new Error(`IrFunctionBuilder: block arg slot ${slot} out of range`);
    }
    return cur.blockArgs[slot];
  }

  terminate(terminator: IrTerminator): void {
    const cur = this.requireBlock();
    this.finished.push({
      id: cur.id,
      blockArgs: cur.blockArgs,
      blockArgTypes: cur.blockArgTypes,
      instrs: cur.instrs,
      terminator,
    });
    this.current = null;
  }

  // --- instructions -------------------------------------------------------

  emitConst(value: IrConst, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "const", value, result, resultType });
    return result;
  }

  emitCall(target: IrFuncRef, args: readonly IrValueId[], resultType: IrType | null): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    this.requireBlock().instrs.push({ kind: "call", target, args: [...args], result, resultType });
    return result;
  }

  emitGlobalGet(target: IrGlobalRef, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "global.get", target, result, resultType });
    return result;
  }

  emitGlobalSet(target: IrGlobalRef, value: IrValueId): void {
    this.requireBlock().instrs.push({ kind: "global.set", target, value, result: null, resultType: null });
  }

  emitBinary(op: IrBinop, lhs: IrValueId, rhs: IrValueId, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "binary", op, lhs, rhs, result, resultType });
    return result;
  }

  emitUnary(op: IrUnop, rand: IrValueId, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "unary", op, rand, result, resultType });
    return result;
  }

  emitSelect(condition: IrValueId, whenTrue: IrValueId, whenFalse: IrValueId, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "select", condition, whenTrue, whenFalse, result, resultType });
    return result;
  }

  // --- string ops (#1169a) ------------------------------------------------

  emitStringConst(value: string): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "string" };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "string.const", value, result, resultType });
    return result;
  }

  emitStringConcat(lhs: IrValueId, rhs: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "string" };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "string.concat", lhs, rhs, result, resultType });
    return result;
  }

  emitStringEq(lhs: IrValueId, rhs: IrValueId, negate: boolean): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: { kind: "i32" } };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "string.eq", lhs, rhs, negate, result, resultType });
    return result;
  }

  emitStringLen(value: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: { kind: "f64" } };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({ kind: "string.len", value, result, resultType });
    return result;
  }

  // --- object ops (#1169b) ------------------------------------------------

  /**
   * Emit `object.new` to materialize an object literal. The caller is
   * responsible for canonicalizing `shape.fields` (sorted ascending by
   * name) and for ensuring `values[i]` matches `shape.fields[i].type`.
   * The arity check is enforced here so a stray slice-2 selector miss
   * surfaces immediately instead of as a malformed Wasm struct.new.
   */
  emitObjectNew(shape: IrObjectShape, values: readonly IrValueId[]): IrValueId {
    if (values.length !== shape.fields.length) {
      throw new Error(
        `IrFunctionBuilder: object.new value count ${values.length} != shape field count ${shape.fields.length} (func ${this.name})`,
      );
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "object", shape };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "object.new",
      shape,
      values: [...values],
      result,
      resultType,
    });
    return result;
  }

  /**
   * Emit `object.get` to read a named field. Caller passes the field's
   * declared IrType so the SSA def's static type matches the shape's
   * field type without a second lookup at lowering time.
   */
  emitObjectGet(value: IrValueId, name: string, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "object.get",
      value,
      name,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Emit `object.set` to write a named field. Void result.
   */
  emitObjectSet(value: IrValueId, name: string, newValue: IrValueId): void {
    this.requireBlock().instrs.push({
      kind: "object.set",
      value,
      name,
      newValue,
      result: null,
      resultType: null,
    });
  }

  // --- closure / ref-cell ops (#1169c) -----------------------------------

  /**
   * Materialize a closure value. Caller is responsible for ensuring
   * `captureFieldTypes[i]` matches the IR type of the SSA value at
   * `captures[i]`. The arity check below catches mistakes early.
   */
  emitClosureNew(
    liftedFunc: IrFuncRef,
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    captures: readonly IrValueId[],
  ): IrValueId {
    if (captureFieldTypes.length !== captures.length) {
      throw new Error(
        `IrFunctionBuilder: closure.new captureFieldTypes count ${captureFieldTypes.length} != captures count ${captures.length} (func ${this.name})`,
      );
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "closure", signature };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "closure.new",
      liftedFunc,
      signature,
      captureFieldTypes: [...captureFieldTypes],
      captures: [...captures],
      result,
      resultType,
    });
    return result;
  }

  /**
   * Read a capture field from the implicit `__self` closure struct.
   * Caller passes the field's IrType so the SSA def's static type is
   * stable without a second resolver lookup at lowering time.
   */
  emitClosureCap(self: IrValueId, index: number, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "closure.cap",
      self,
      index,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Invoke a closure value. Caller passes `resultType` (= signature.returnType)
   * for the SSA def.
   */
  emitClosureCall(callee: IrValueId, args: readonly IrValueId[], resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "closure.call",
      callee,
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  /**
   * Wrap a primitive value in a fresh ref cell. The SSA def's type is
   * `{ kind: "boxed", inner }`.
   */
  emitRefCellNew(value: IrValueId, inner: ValType): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "boxed", inner };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "refcell.new",
      value,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Read the inner value out of a ref cell. The SSA def's type is
   * `irVal(inner)` — caller passes the same `inner` they used for
   * `emitRefCellNew`.
   */
  emitRefCellGet(cell: IrValueId, inner: ValType): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: inner };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "refcell.get",
      cell,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Write a new value through the ref cell. Void result.
   */
  emitRefCellSet(cell: IrValueId, value: IrValueId): void {
    this.requireBlock().instrs.push({
      kind: "refcell.set",
      cell,
      value,
      result: null,
      resultType: null,
    });
  }

  /**
   * Phase 1 escape hatch — emit raw backend ops with a stated stack delta.
   * Verifier requires stackDelta to match the effective push count.
   */
  emitRawWasm(ops: readonly Instr[], stackDelta: number): void {
    this.requireBlock().instrs.push({ kind: "raw.wasm", ops: [...ops], stackDelta, result: null, resultType: null });
  }

  // --- class ops (#1169d) -------------------------------------------------

  /**
   * Emit `class.new` to construct a class instance via the legacy-registered
   * `<className>_new` constructor. Caller is responsible for ensuring
   * `args[i]` matches `shape.constructorParams[i]`. The arity check below
   * catches mistakes early.
   */
  emitClassNew(shape: IrClassShape, args: readonly IrValueId[]): IrValueId {
    if (args.length !== shape.constructorParams.length) {
      throw new Error(
        `IrFunctionBuilder: class.new arg count ${args.length} != constructor arity ${shape.constructorParams.length} (func ${this.name}, class ${shape.className})`,
      );
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "class", shape };
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "class.new",
      shape,
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  /**
   * Emit `class.get` to read a named field on a class instance. Caller
   * passes the field's IrType (looked up against the receiver's shape) so
   * the SSA def's static type matches without a second resolver lookup.
   */
  emitClassGet(value: IrValueId, fieldName: string, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.requireBlock().instrs.push({
      kind: "class.get",
      value,
      fieldName,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Emit `class.set` to write a named field on a class instance. Void
   * result. The receiver's shape must contain `fieldName`; arity / type
   * checks happen at the AST→IR layer.
   */
  emitClassSet(value: IrValueId, fieldName: string, newValue: IrValueId): void {
    this.requireBlock().instrs.push({
      kind: "class.set",
      value,
      fieldName,
      newValue,
      result: null,
      resultType: null,
    });
  }

  /**
   * Emit `class.call` to invoke an instance method. `resultType` is the
   * method descriptor's `returnType` (or `null` for void). Returns `null`
   * for void methods — callers using the result in expression position
   * must reject `null` themselves.
   */
  emitClassCall(
    receiver: IrValueId,
    methodName: string,
    args: readonly IrValueId[],
    resultType: IrType | null,
  ): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    this.requireBlock().instrs.push({
      kind: "class.call",
      receiver,
      methodName,
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  // --- finalize -----------------------------------------------------------

  typeOf(value: IrValueId): IrType {
    const t = this.valueTypes.get(value);
    if (t === undefined) {
      throw new Error(`IrFunctionBuilder: unknown value ${value} in func ${this.name}`);
    }
    return t;
  }

  finish(closureSubtype?: {
    readonly signature: IrClosureSignature;
    readonly captureFieldTypes: readonly IrType[];
  }): IrFunction {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: finish() while block ${this.current.id} still open (func ${this.name})`);
    }
    if (this.reserved.size > 0) {
      const ids = [...this.reserved].map((b) => b as number).join(",");
      throw new Error(`IrFunctionBuilder: reserved block(s) [${ids}] never opened (func ${this.name})`);
    }
    if (this.finished.length === 0) {
      throw new Error(`IrFunctionBuilder: function ${this.name} has no blocks`);
    }
    // Blocks may have been pushed out-of-order (a forward-referenced block is
    // opened after blocks allocated during its predecessor's lowering). The
    // verifier and the lowerer both expect `blocks[i].id === i`.
    const sorted = [...this.finished].sort((a, b) => (a.id as number) - (b.id as number));
    return {
      name: this.name,
      params: this.params,
      resultTypes: [...this.resultTypes],
      blocks: sorted,
      exported: this.exported,
      valueCount: this.allocator.count,
      ...(closureSubtype ? { closureSubtype } : {}),
    };
  }

  private requireBlock(): OpenBlock {
    if (this.current === null) {
      throw new Error(`IrFunctionBuilder: no open block (func ${this.name})`);
    }
    return this.current;
  }
}

// Convenience: value-id brand with no underlying type map — useful for tests
// that want to pass raw integers around.
export function v(n: number): IrValueId {
  return asValueId(n);
}
