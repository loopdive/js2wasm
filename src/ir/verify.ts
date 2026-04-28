// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR invariant verifier — validates an IrFunction against the invariants in
// spec #1131 §1.3. Phase 1 enforces the subset that the Phase 1 builder can
// actually produce:
//
//   1. Single static assignment: every IrValueId defined exactly once.
//   2. Use-before-def: every IrValueId referenced is either a param, a block
//      arg of the containing block, or defined earlier in the same block.
//      (Cross-block use checks are Phase 2 once we can express branches with
//       SSA values reaching successor blocks.)
//   3. Block termination: every block has exactly one terminator.
//   4. Branch arg arity: each `br`/`br_if` passes exactly as many args as the
//      target block declares.
//   5. Symbolic refs: the only references to functions/globals/types in
//      instructions are IrFuncRef/IrGlobalRef/IrTypeRef (no raw indices).
//
// On failure, returns a list of `IrVerifyError`s rather than throwing, so
// callers can decide whether to bail or fall back to the legacy path.

import type { IrBlock, IrFunction, IrValueId } from "./nodes.js";
import type { ValType } from "./types.js";

export interface IrVerifyError {
  readonly message: string;
  readonly func: string;
  readonly block?: number;
}

export function verifyIrFunction(func: IrFunction): IrVerifyError[] {
  const errors: IrVerifyError[] = [];
  const defs = new Set<IrValueId>();

  for (const p of func.params) {
    if (defs.has(p.value)) {
      errors.push({ message: `duplicate SSA def for param ${p.name}`, func: func.name });
    }
    defs.add(p.value);
  }

  // Validate block IDs form a contiguous range starting at 0.
  for (let i = 0; i < func.blocks.length; i++) {
    if ((func.blocks[i].id as number) !== i) {
      errors.push({ message: `block ${i} has id ${func.blocks[i].id}, expected ${i}`, func: func.name, block: i });
    }
  }

  for (const block of func.blocks) {
    verifyBlock(func, block, defs, errors);
  }

  // Check branch-arg arity against target block signatures.
  for (const block of func.blocks) {
    const t = block.terminator;
    if (t.kind === "br") {
      checkBranchArity(func, block, t.branch.target as number, t.branch.args.length, errors);
    } else if (t.kind === "br_if") {
      checkBranchArity(func, block, t.ifTrue.target as number, t.ifTrue.args.length, errors);
      checkBranchArity(func, block, t.ifFalse.target as number, t.ifFalse.args.length, errors);
    }
  }

  return errors;
}

function verifyBlock(func: IrFunction, block: IrBlock, defs: Set<IrValueId>, errors: IrVerifyError[]): void {
  for (const arg of block.blockArgs) {
    if (defs.has(arg)) {
      errors.push({
        message: `duplicate SSA def for block arg ${arg}`,
        func: func.name,
        block: block.id as number,
      });
    }
    defs.add(arg);
  }

  const localDefs = new Set<IrValueId>();
  for (const instr of block.instrs) {
    // Use-before-def check within block (params + block args always count).
    const uses = collectUses(instr);
    for (const u of uses) {
      const isParam = func.params.some((p) => p.value === u);
      const isBlockArg = block.blockArgs.includes(u);
      const isEarlier = localDefs.has(u);
      if (!isParam && !isBlockArg && !isEarlier) {
        errors.push({
          message: `use of SSA value ${u} before def in block ${block.id as number}`,
          func: func.name,
          block: block.id as number,
        });
      }
    }

    // Structural checks for the newly-added tagged-union instructions.
    // These are type-system-level, not SSA-scope — misuse should surface
    // here rather than silently lowering to a trap.
    if (instr.kind === "box") {
      if (instr.toType.kind !== "union") {
        errors.push({
          message: `box target must be a union IrType, got ${instr.toType.kind}`,
          func: func.name,
          block: block.id as number,
        });
      } else {
        // box requires the operand's ValType to be a member of the union.
        const operandT = operandValType(func, block, instr.value, localDefs);
        if (operandT && !unionContains(instr.toType.members, operandT)) {
          errors.push({
            message: `box operand type ${operandT.kind} is not a member of union<${instr.toType.members.map((m) => m.kind).join(",")}>`,
            func: func.name,
            block: block.id as number,
          });
        }
      }
    }
    if (instr.kind === "unbox" || instr.kind === "tag.test") {
      // value's defining IrType must be a union whose members contain `tag`.
      const operandIr = operandIrType(func, block, instr.value, localDefs);
      if (operandIr && operandIr.kind !== "union") {
        errors.push({
          message: `${instr.kind} operand must be a union IrType, got ${operandIr.kind}`,
          func: func.name,
          block: block.id as number,
        });
      } else if (operandIr && !unionContains(operandIr.members, instr.tag)) {
        errors.push({
          message: `${instr.kind} tag ${instr.tag.kind} is not a member of union<${operandIr.members.map((m) => m.kind).join(",")}>`,
          func: func.name,
          block: block.id as number,
        });
      }
    }

    if (instr.result !== null) {
      if (defs.has(instr.result)) {
        errors.push({
          message: `duplicate SSA def for value ${instr.result}`,
          func: func.name,
          block: block.id as number,
        });
      }
      defs.add(instr.result);
      localDefs.add(instr.result);
    }
  }

  // Terminator uses must resolve to params/blockargs/local defs.
  const termUses = collectTerminatorUses(block);
  for (const u of termUses) {
    const isParam = func.params.some((p) => p.value === u);
    const isBlockArg = block.blockArgs.includes(u);
    const isLocal = localDefs.has(u);
    if (!isParam && !isBlockArg && !isLocal) {
      errors.push({
        message: `terminator uses undefined SSA value ${u} in block ${block.id as number}`,
        func: func.name,
        block: block.id as number,
      });
    }
  }
}

function collectUses(instr: IrBlock["instrs"][number]): readonly IrValueId[] {
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
    // Slice 3 (#1169c): closure / ref-cell ops. The verifier counts
    // `callee` once for closure.call (SSA def→use accounting) — the
    // lowerer adds the second count to force a Wasm local for the
    // double-emission pattern.
    case "closure.new":
      return instr.captures;
    case "closure.cap":
      return [instr.self];
    case "closure.call":
      return [instr.callee, ...instr.args];
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
      // The body executes inside a Wasm loop and is not part of the
      // straight-line use-before-def walk. We only surface `vec` here so
      // its def→use relation is tracked by the verifier and by the
      // cross-block use counter in the lowerer.
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
      // Same rationale as forof.vec: body is loop-internal, only the
      // iterable surfaces in the straight-line walk.
      return [instr.iterable];
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      // No SSA operand uses — buffer + pendingThrow are read from Wasm
      // locals (slot indices stored on the IrFunction).
      return [];
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar":
      return [instr.inner];
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string":
      return [instr.str];
    // Slice 9 (#1169h) — exception handling. Body / catch / finally uses
    // are loop-internal (analogous to forof.vec) and are not surfaced
    // in the straight-line use-before-def walk.
    case "throw":
      return [instr.value];
    case "try":
      return [];
    // Slice 10 (#1169i) — extern class ops.
    case "extern.new":
      return instr.args;
    case "extern.call":
      return [instr.receiver, ...instr.args];
    case "extern.prop":
      return [instr.receiver];
    case "extern.propSet":
      return [instr.receiver, instr.value];
    case "extern.regex":
      return [];
  }
}

/**
 * Return the IrType of an SSA value within the given block context.
 * Scans params + earlier instructions (in any earlier block). Returns `null`
 * if the value isn't locally visible — the SSA-scope check reports that
 * separately, so we skip the type check silently.
 */
function operandIrType(
  func: IrFunction,
  block: IrBlock,
  v: IrValueId,
  _localDefs: ReadonlySet<IrValueId>,
): import("./nodes.js").IrType | null {
  for (const p of func.params) {
    if (p.value === v) return p.type;
  }
  // Scan all blocks — the SSA invariant allows earlier-defined values from
  // predecessor blocks to be used here. A full dominator check is Phase-3.
  for (const b of func.blocks) {
    for (const inst of b.instrs) {
      if (inst.result === v && inst.resultType) return inst.resultType;
    }
  }
  // Block args of the containing block carry types in `blockArgTypes`.
  for (let i = 0; i < block.blockArgs.length; i++) {
    if (block.blockArgs[i] === v) return block.blockArgTypes[i] ?? null;
  }
  return null;
}

function operandValType(
  func: IrFunction,
  block: IrBlock,
  v: IrValueId,
  localDefs: ReadonlySet<IrValueId>,
): ValType | null {
  const t = operandIrType(func, block, v, localDefs);
  if (!t) return null;
  if (t.kind === "val") return t.val;
  return null;
}

function unionContains(members: readonly ValType[], target: ValType): boolean {
  for (const m of members) {
    if (m.kind !== target.kind) continue;
    if (m.kind === "ref" || m.kind === "ref_null") {
      if ((m as { typeIdx: number }).typeIdx !== (target as { typeIdx: number }).typeIdx) continue;
    }
    return true;
  }
  return false;
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

function checkBranchArity(
  func: IrFunction,
  from: IrBlock,
  toIdx: number,
  argCount: number,
  errors: IrVerifyError[],
): void {
  const target = func.blocks[toIdx];
  if (!target) {
    errors.push({
      message: `branch from block ${from.id as number} to nonexistent block ${toIdx}`,
      func: func.name,
      block: from.id as number,
    });
    return;
  }
  if (target.blockArgs.length !== argCount) {
    errors.push({
      message: `branch arity mismatch: block ${from.id as number} passes ${argCount} args to block ${toIdx} (expects ${target.blockArgs.length})`,
      func: func.name,
      block: from.id as number,
    });
  }
}
