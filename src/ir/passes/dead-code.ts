// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Dead-code elimination for the middle-end IR — part of Phase 3a (#1167a).
//
// Two kinds of "dead":
//
//   1. Unreachable blocks — blocks never entered from the entry block via
//      the terminator graph. Constant-folded branches (CF rewriting
//      `br_if(const true, A, B)` → `br(A)`) leave B with no predecessors.
//      We drop every such block and renumber the remaining blocks so
//      `blocks[i].id === i` (verify.ts:41-45 invariant).
//   2. Dead values — SSA results produced by pure instructions that are
//      never referenced by any reachable instruction, terminator, or
//      side-effecting op. The spec lists `const`, `prim`, `unary`, `binary`
//      as removable; we extend to every provably-pure instruction kind
//      (`select`, `box`, `unbox`, `tag.test`, `global.get`).
//
// Side-effecting instructions (`raw.wasm`, `call`, `global.set`) are
// ALWAYS live, regardless of result use count, because their execution
// may mutate observable state. The issue spec is explicit: `raw.wasm`
// must be treated as always-live.
//
// Distinct from the backend `dead-elimination.ts` in `src/codegen/` which
// operates on Wasm imports / type definitions, not IR values.

import {
  asBlockId,
  type IrBlock,
  type IrBranch,
  type IrFunction,
  type IrInstr,
  type IrTerminator,
  type IrValueId,
} from "../nodes.js";

/**
 * Run dead-code elimination on an IR function. Returns the same reference
 * when no changes are made (so integration.ts can detect fixpoint via
 * reference equality).
 */
export function deadCode(fn: IrFunction): IrFunction {
  // --- Phase 1: compute reachable blocks (BFS from entry). ---------------
  const reachable = computeReachable(fn);

  // --- Phase 2: compute live values within reachable blocks. -------------
  const live = computeLiveValues(fn, reachable);

  // --- Phase 3: detect whether we actually changed anything. -------------
  const willRemoveBlocks = reachable.size !== fn.blocks.length;
  let willRemoveInstrs = false;
  for (const id of reachable) {
    const block = fn.blocks[id]!;
    for (const instr of block.instrs) {
      if (!shouldKeep(instr, live)) {
        willRemoveInstrs = true;
        break;
      }
    }
    if (willRemoveInstrs) break;
  }
  if (!willRemoveBlocks && !willRemoveInstrs) return fn;

  // --- Phase 4: rebuild blocks. ------------------------------------------
  // Sort reachable block IDs ascending, then remap old → new index.
  const sortedReachable = [...reachable].sort((a, b) => a - b);
  const oldToNew = new Map<number, number>();
  sortedReachable.forEach((old, idx) => oldToNew.set(old, idx));

  const newBlocks: IrBlock[] = sortedReachable.map((oldId) => {
    const block = fn.blocks[oldId]!;
    const newInstrs = block.instrs.filter((i) => shouldKeep(i, live));
    return {
      id: asBlockId(oldToNew.get(oldId)!),
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: newInstrs,
      terminator: rewriteTerminatorTargets(block.terminator, oldToNew, fn.name),
    };
  });

  return {
    ...fn,
    blocks: newBlocks,
  };
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

function computeReachable(fn: IrFunction): Set<number> {
  const reachable = new Set<number>();
  const queue: number[] = [0];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    if (id < 0 || id >= fn.blocks.length) continue;
    reachable.add(id);
    const block = fn.blocks[id]!;
    for (const succ of successors(block.terminator)) queue.push(succ);
  }
  return reachable;
}

function successors(t: IrTerminator): readonly number[] {
  switch (t.kind) {
    case "br":
      return [t.branch.target as number];
    case "br_if":
      return [t.ifTrue.target as number, t.ifFalse.target as number];
    case "return":
    case "unreachable":
      return [];
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

function computeLiveValues(fn: IrFunction, reachable: ReadonlySet<number>): Set<IrValueId> {
  const live = new Set<IrValueId>();

  // Seed: terminator uses + operands of side-effecting instructions.
  for (const id of reachable) {
    const block = fn.blocks[id]!;
    for (const v of collectTerminatorUses(block.terminator)) live.add(v);
    for (const instr of block.instrs) {
      if (isSideEffecting(instr)) {
        for (const u of collectInstrUses(instr)) live.add(u);
      }
    }
  }

  // Propagate: if a live value is produced by an instr, its operands are
  // also live. Iterate to fixpoint over the reachable blocks.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      const block = fn.blocks[id]!;
      for (const instr of block.instrs) {
        if (instr.result !== null && live.has(instr.result)) {
          for (const u of collectInstrUses(instr)) {
            if (!live.has(u)) {
              live.add(u);
              changed = true;
            }
          }
        }
      }
    }
  }

  return live;
}

/**
 * Side-effecting instructions are always kept regardless of use count.
 *
 * - `raw.wasm` — opaque Wasm ops with unknown effects (spec #1167a mandates
 *    this stays live).
 * - `call` — conservatively treated as having side effects. Purity analysis
 *    is a later pass.
 * - `global.set` — writes observable state.
 */
function isSideEffecting(i: IrInstr): boolean {
  return (
    i.kind === "raw.wasm" ||
    i.kind === "call" ||
    i.kind === "global.set" ||
    // Slice 3 (#1169c): closure.call may invoke a body with arbitrary
    // effects (mutates ref cells, sets globals, calls other functions).
    // Conservatively keep it live regardless of result use count.
    i.kind === "closure.call" ||
    // refcell.set writes observable state through the cell ref.
    // refcell.new is pure (allocates a fresh struct), so leave it
    // out — DCE may strip it when its result is dead.
    i.kind === "refcell.set" ||
    // object.set mutates the struct (slice 2 didn't add this, but is
    // currently void-result so the existing `result === null → keep`
    // catches it; explicit listing is a no-op for now).
    i.kind === "object.set" ||
    // Slice 4 (#1169d): class.call invokes a method body with potentially
    // arbitrary effects. class.set mutates the instance. class.new calls
    // a constructor (which may run side-effecting user code, e.g.
    // `this.x = computeAndLogX()`). Conservatively keep all three live.
    i.kind === "class.call" ||
    i.kind === "class.set" ||
    i.kind === "class.new" ||
    // Slice 6 (#1169e): slot.write and forof.vec are statement-level
    // side effects — the loop's body executes for every element.
    // slot.read is pure (load a Wasm local) but always-keep to avoid
    // breaking the for-of body's load/use pattern.
    i.kind === "slot.write" ||
    i.kind === "forof.vec" ||
    // Slice 6 part 3 (#1182): host-iterator protocol ops mutate iterator
    // state (advance pointer, dispose). DCE must not eliminate them
    // even when their results are unused — a `iter.next` whose value is
    // dropped still has the side effect of advancing the iterator.
    // forof.iter is statement-level (result: null) and is kept by the
    // generic null-result rule, but the explicit listing makes the
    // intent obvious.
    i.kind === "iter.new" ||
    i.kind === "iter.next" ||
    i.kind === "iter.return" ||
    i.kind === "forof.iter" ||
    // Slice 7a (#1169f): gen.push pushes a value onto the eager
    // generator buffer (observable through __gen_next). gen.epilogue
    // calls __create_generator with the buffer and is materially
    // referenced as the function's return value — but DCE's
    // propagation only flows through `result`-bearing instrs, so
    // explicitly pinning here is the simplest correctness rule.
    // Without this, DCE would consider gen.push's `value` operand
    // dead and strip the const that produces it, leaving a stale
    // SSA reference that the verifier rejects.
    i.kind === "gen.push" ||
    i.kind === "gen.epilogue" ||
    // Slice 7b (#1169f): gen.yieldStar drains every value from the
    // inner iterable onto the buffer — observable through __gen_next
    // downstream. Pin for the same reason as gen.push: the operand
    // (`inner`) must stay live, but DCE's propagation only flows
    // through `result`-bearing instrs.
    i.kind === "gen.yieldStar" ||
    // Slice 6 part 4 (#1183): forof.string is statement-level (result:
    // null) so the generic null-result rule already keeps it; explicit
    // listing for clarity.
    i.kind === "forof.string"
  );
}

function shouldKeep(i: IrInstr, live: ReadonlySet<IrValueId>): boolean {
  if (isSideEffecting(i)) return true;
  if (i.result === null) return true; // void-producing but not side-effecting — keep to be safe
  return live.has(i.result);
}

// ---------------------------------------------------------------------------
// Use collection (local copies — see lower.ts for the canonical pattern)
// ---------------------------------------------------------------------------

function collectInstrUses(instr: IrInstr): readonly IrValueId[] {
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
    case "forof.vec": {
      // Body uses count too — DCE must keep outer values referenced
      // inside a for-of body. Walk recursively.
      const result: IrValueId[] = [instr.vec];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectInstrUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
        }
      };
      walk(instr.body);
      return result;
    }
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
    case "forof.iter": {
      const result: IrValueId[] = [instr.iterable];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectInstrUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
        }
      };
      walk(instr.body);
      return result;
    }
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string": {
      const result: IrValueId[] = [instr.str];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectInstrUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
        }
      };
      walk(instr.body);
      return result;
    }
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      return [];
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar":
      return [instr.inner];
  }
}

function collectTerminatorUses(t: IrTerminator): readonly IrValueId[] {
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

// ---------------------------------------------------------------------------
// Terminator rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite branch targets through the `oldToNew` map produced by block
 * renumbering. Throws if a terminator references a block that wasn't
 * reachable (which means CF+DCE dropped a successor that still has a live
 * branch pointing to it — a bug upstream).
 */
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
  const newTarget = oldToNew.get(br.target as number);
  if (newTarget === undefined) {
    throw new Error(`ir/passes/dead-code: branch to unreachable block ${br.target as number} in ${funcName}`);
  }
  return { target: asBlockId(newTarget), args: br.args };
}
