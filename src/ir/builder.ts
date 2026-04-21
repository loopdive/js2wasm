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
  IrConst,
  IrFuncRef,
  IrFunction,
  IrGlobalRef,
  IrInstr,
  IrParam,
  IrTerminator,
  IrType,
  IrUnop,
  IrValueId,
  IrValueIdAllocator,
} from "./nodes.js";
import type { Instr } from "./types.js";

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

  /**
   * Phase 1 escape hatch — emit raw backend ops with a stated stack delta.
   * Verifier requires stackDelta to match the effective push count.
   */
  emitRawWasm(ops: readonly Instr[], stackDelta: number): void {
    this.requireBlock().instrs.push({ kind: "raw.wasm", ops: [...ops], stackDelta, result: null, resultType: null });
  }

  // --- finalize -----------------------------------------------------------

  typeOf(value: IrValueId): IrType {
    const t = this.valueTypes.get(value);
    if (t === undefined) {
      throw new Error(`IrFunctionBuilder: unknown value ${value} in func ${this.name}`);
    }
    return t;
  }

  finish(): IrFunction {
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
