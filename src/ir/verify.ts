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
