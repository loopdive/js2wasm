// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// CFG simplification for the middle-end IR — part of Phase 3a (#1167a).
//
// After constant-fold + dead-code, a function may contain trivially-linked
// basic blocks:
//
//   - Block A ends with `br bb_B` and B has only A as predecessor →
//     merge A's instrs + B's instrs into one block, drop B, adopt B's
//     terminator as the merged block's terminator.
//
// This matters because `lower.ts:218-265` reconstructs structured Wasm
// control flow from the IR's basic blocks. Leftover empty blocks or
// single-successor chains from CF + DCE produce redundant `if/else`
// wrappers in the emitted WAT. Merging them keeps the lowerer's shape
// assumptions intact.
//
// A single pass performs one merge per block (the first eligible one it
// finds). The caller (`integration.ts`) loops CF → DCE → simplifyCFG
// until none of them make progress — so chained merges (A → B → C)
// converge in a few iterations.

import { asBlockId, type IrBlock, type IrBranch, type IrFunction, type IrTerminator } from "../nodes.js";

/**
 * Merge trivially-linked blocks. Returns the same reference when no
 * changes are made.
 *
 * Pre-conditions (enforced upstream by the CF + DCE pipeline):
 *   - `func.blocks[i].id === i` (enforced by verify.ts:41-45).
 *   - Unreachable blocks have already been removed by DCE.
 *
 * Merge rule: a block A whose terminator is `br(B)` may absorb B if:
 *   (a) B has exactly one predecessor (A itself);
 *   (b) A != B (no self-loop);
 *   (c) B is not the entry block (blocks[0] must stay at index 0);
 *   (d) B has no block args (merging would require arg substitution,
 *       which Phase 3a leaves to a future pass — from-ast.ts and CF
 *       never introduce block args, so this is a safety guard rather
 *       than a real restriction).
 */
export function simplifyCFG(fn: IrFunction): IrFunction {
  const predCount = computePredCount(fn);

  // Find the first eligible merge.
  for (let i = 0; i < fn.blocks.length; i++) {
    const block = fn.blocks[i]!;
    const t = block.terminator;
    if (t.kind !== "br") continue;
    const targetId = t.branch.target as number;
    if (targetId === i) continue; // self-loop — don't merge into self
    if (targetId === 0) continue; // entry must stay at index 0
    if ((predCount.get(targetId) ?? 0) !== 1) continue;
    const target = fn.blocks[targetId];
    if (!target) continue;
    if (target.blockArgs.length > 0) continue; // see header
    if (t.branch.args.length > 0) continue; // paired with above — defensive

    return mergeAt(fn, i, targetId);
  }

  return fn;
}

// ---------------------------------------------------------------------------
// Predecessor counting
// ---------------------------------------------------------------------------

function computePredCount(fn: IrFunction): Map<number, number> {
  const count = new Map<number, number>();
  for (let i = 0; i < fn.blocks.length; i++) count.set(i, 0);
  for (const block of fn.blocks) {
    const t = block.terminator;
    if (t.kind === "br") {
      bump(count, t.branch.target as number);
    } else if (t.kind === "br_if") {
      bump(count, t.ifTrue.target as number);
      bump(count, t.ifFalse.target as number);
    }
  }
  return count;
}

function bump(count: Map<number, number>, id: number): void {
  count.set(id, (count.get(id) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Merge execution
// ---------------------------------------------------------------------------

/**
 * Merge `blocks[targetId]` into `blocks[sourceId]`. The merged block takes
 * `sourceId`'s id, keeps `sourceId`'s instrs followed by `targetId`'s
 * instrs, and adopts `targetId`'s terminator. The resulting blocks array
 * drops `targetId` and renumbers everything after it.
 */
function mergeAt(fn: IrFunction, sourceId: number, targetId: number): IrFunction {
  const source = fn.blocks[sourceId]!;
  const target = fn.blocks[targetId]!;

  const mergedInstrs = [...source.instrs, ...target.instrs];
  const mergedSource: IrBlock = {
    id: source.id,
    blockArgs: source.blockArgs,
    blockArgTypes: source.blockArgTypes,
    instrs: mergedInstrs,
    terminator: target.terminator,
  };

  // Build old→new block-index map (skipping targetId).
  const oldToNew = new Map<number, number>();
  let newIdx = 0;
  for (let j = 0; j < fn.blocks.length; j++) {
    if (j === targetId) continue;
    oldToNew.set(j, newIdx++);
  }

  const newBlocks: IrBlock[] = [];
  for (let j = 0; j < fn.blocks.length; j++) {
    if (j === targetId) continue;
    const block = j === sourceId ? mergedSource : fn.blocks[j]!;
    const rewriteId = oldToNew.get(j)!;
    newBlocks.push({
      id: asBlockId(rewriteId),
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: block.instrs,
      terminator: rewriteTerminatorTargets(block.terminator, oldToNew, fn.name),
    });
  }

  return {
    ...fn,
    blocks: newBlocks,
  };
}

function rewriteTerminatorTargets(
  t: IrTerminator,
  oldToNew: ReadonlyMap<number, number>,
  funcName: string,
): IrTerminator {
  switch (t.kind) {
    case "return":
    case "unreachable":
      return t;
    case "br":
      return { kind: "br", branch: rewriteBranch(t.branch, oldToNew, funcName), site: t.site };
    case "br_if":
      return {
        kind: "br_if",
        condition: t.condition,
        ifTrue: rewriteBranch(t.ifTrue, oldToNew, funcName),
        ifFalse: rewriteBranch(t.ifFalse, oldToNew, funcName),
        site: t.site,
      };
  }
}

function rewriteBranch(br: IrBranch, oldToNew: ReadonlyMap<number, number>, funcName: string): IrBranch {
  const next = oldToNew.get(br.target as number);
  if (next === undefined) {
    throw new Error(`ir/passes/simplify-cfg: branch to missing block ${br.target as number} in ${funcName}`);
  }
  return { target: asBlockId(next), args: br.args };
}
