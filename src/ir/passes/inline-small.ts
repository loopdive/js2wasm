// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR-to-IR inlining of small, non-recursive, single-block callees — spec #1167b.
//
// First slice of Phase 3b. This pass runs after the Phase 3a hygiene pipeline
// (CF → DCE → simplifyCFG) and before lowering to Wasm. It expands small
// callee bodies into the caller's blocks, avoiding a `call` instruction at
// lowering time.
//
// ## Scope (v1): single-block callees only
//
// A callee is inlinable iff ALL of:
//
//   - `callee.blocks.length === 1` — multi-block inlining (multiple `return`
//     terminators requiring continuation-block splicing + CFG rewrites) is
//     deferred to a follow-up. Two-return shapes like
//       if (x < 0) return -x;
//       return x;
//     fall out of this slice.
//   - Sole block's terminator is `return <value>` (exactly one value).
//   - Callee is non-recursive (not part of any SCC, including self-loops).
//   - Callee body ≤ N instructions (N = 10 by default).
//   - Callee body contains no `raw.wasm` — its `ops` may reference
//     function-local Wasm indices (local.get, etc.) which would be invalid
//     in a different caller's local frame. Plain SSA ops (const, binary,
//     select, ...) are safe to splice.
//
// ## Algorithm
//
// For each caller function, walk block instrs. For each `call` to an
// inlinable callee:
//
//   1. Allocate a fresh IrValueId for every value the callee's block
//      defines (instruction results). Parameters map directly to the
//      caller's call-site argument values.
//   2. Splice the callee's instructions into the caller's block at the
//      call-site position, with operands + results rewritten through the
//      rename map.
//   3. Replace the caller's use of the call's result with the renamed
//      callee-return value: set `callerRename[callSite.result] = renamedReturn`
//      and apply the map to every subsequent instruction and the terminator.
//
// A single pass over each block handles any number of inlined calls because
// `callerRename` accumulates mappings as we go; later uses are rewritten
// transparently.
//
// ## Size budget
//
// To avoid runaway code growth, a single caller will not grow beyond
// `max(4× original, original + 2× MAX_CALLEE_INSTRS)` instructions across
// all inline decisions. The floor lets a trivially-small caller (e.g. a
// one-instr thunk `return abs(n);`) absorb one or two small callees that
// would otherwise be blocked by the strict multiplicative bound.
//
// ## Post-conditions
//
// - `verifyIrFunction` returns zero errors on every modified function.
// - `valueCount` reflects the new high-water mark (old count + freshly
//   allocated inlined-value ids).
// - `blocks.length` is unchanged (we only splice into existing blocks;
//   single-block callees produce no new blocks).
//
// The caller (`integration.ts`) re-runs `constantFold` + `deadCode` on every
// modified function afterwards so the inlined constants / unused args get
// cleaned up before lowering.

import {
  asValueId,
  type IrBlock,
  type IrBranch,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrTerminator,
  type IrValueId,
} from "../nodes.js";

const MAX_CALLEE_INSTRS = 10;
const CALLER_SIZE_BUDGET_MULTIPLIER = 4;

/**
 * Inline small, non-recursive, single-block callees across the module.
 * Returns the same `IrModule` reference when no function changes.
 */
export function inlineSmall(mod: IrModule): IrModule {
  const byName = new Map<string, IrFunction>();
  for (const fn of mod.functions) byName.set(fn.name, fn);

  const recursiveSet = computeRecursiveSet(mod, byName);

  const newFunctions: IrFunction[] = [];
  let anyChanged = false;
  for (const fn of mod.functions) {
    const inlined = inlineIntoFunction(fn, byName, recursiveSet);
    if (inlined !== fn) anyChanged = true;
    newFunctions.push(inlined);
  }
  if (!anyChanged) return mod;
  return { functions: newFunctions };
}

// ---------------------------------------------------------------------------
// Per-function inlining
// ---------------------------------------------------------------------------

function inlineIntoFunction(
  caller: IrFunction,
  byName: ReadonlyMap<string, IrFunction>,
  recursiveSet: ReadonlySet<string>,
): IrFunction {
  const originalSize = countInstrs(caller);
  let nextValueId = caller.valueCount;
  let currentSize = originalSize;
  let anyFuncChange = false;

  const newBlocks: IrBlock[] = [];
  for (const block of caller.blocks) {
    // callerRename collects rewrites that apply to caller-scope SSA ids
    // produced by prior instructions in THIS block. Specifically, each time
    // we inline a call, we add:
    //   callSite.result  →  renamedReturn (callee's return value post-rename)
    // so every later instruction / the terminator uses the inlined value
    // transparently.
    const callerRename = new Map<IrValueId, IrValueId>();

    const newInstrs: IrInstr[] = [];
    let blockChanged = false;

    for (const instr of block.instrs) {
      // First, apply any accumulated renames to this instruction's operands.
      const rewritten = renameInstrOperands(instr, callerRename);
      if (rewritten !== instr) blockChanged = true;

      if (rewritten.kind !== "call") {
        newInstrs.push(rewritten);
        continue;
      }

      const callee = byName.get(rewritten.target.name);
      if (!callee || !canInline(callee, recursiveSet)) {
        newInstrs.push(rewritten);
        continue;
      }

      const body = callee.blocks[0]!;
      const calleeSize = body.instrs.length;
      const budget = Math.max(CALLER_SIZE_BUDGET_MULTIPLIER * originalSize, originalSize + 2 * MAX_CALLEE_INSTRS);
      if (currentSize + calleeSize > budget) {
        newInstrs.push(rewritten);
        continue;
      }

      // Return terminator shape — already guarded by `canInline`, but assert
      // locally so TypeScript narrows and we catch invariants slipping.
      const term = body.terminator;
      if (term.kind !== "return" || term.values.length !== 1) {
        newInstrs.push(rewritten);
        continue;
      }
      const returnValueId = term.values[0]!;

      // Build the callee-scope rename: params first (to call-site args),
      // then every instr result gets a fresh caller-scope id.
      const calleeRename = new Map<IrValueId, IrValueId>();
      if (rewritten.args.length !== callee.params.length) {
        // Arity mismatch would be a bug upstream — bail out safely rather
        // than emit malformed IR.
        newInstrs.push(rewritten);
        continue;
      }
      for (let i = 0; i < callee.params.length; i++) {
        calleeRename.set(callee.params[i]!.value, rewritten.args[i]!);
      }
      for (const inst of body.instrs) {
        if (inst.result !== null) {
          calleeRename.set(inst.result, asValueId(nextValueId++));
        }
      }

      // Splice callee body into caller (renamed).
      for (const inst of body.instrs) {
        newInstrs.push(renameAllInInstr(inst, calleeRename));
      }

      // The call's result becomes the renamed return value for all downstream
      // uses in this block and its terminator.
      const renamedReturn = calleeRename.get(returnValueId) ?? returnValueId;
      if (rewritten.result !== null) {
        callerRename.set(rewritten.result, renamedReturn);
      }

      currentSize += calleeSize;
      blockChanged = true;
      anyFuncChange = true;
    }

    const newTerm = renameTerminatorOperands(block.terminator, callerRename);
    if (newTerm !== block.terminator) blockChanged = true;

    if (!blockChanged) {
      newBlocks.push(block);
    } else {
      newBlocks.push({
        id: block.id,
        blockArgs: block.blockArgs,
        blockArgTypes: block.blockArgTypes,
        instrs: newInstrs,
        terminator: newTerm,
      });
    }
  }

  if (!anyFuncChange) return caller;
  return {
    ...caller,
    blocks: newBlocks,
    valueCount: nextValueId,
  };
}

// ---------------------------------------------------------------------------
// Inlinability check
// ---------------------------------------------------------------------------

function canInline(callee: IrFunction, recursiveSet: ReadonlySet<string>): boolean {
  if (callee.blocks.length !== 1) return false;
  if (recursiveSet.has(callee.name)) return false;
  const body = callee.blocks[0]!;
  if (body.instrs.length > MAX_CALLEE_INSTRS) return false;
  const term = body.terminator;
  if (term.kind !== "return") return false;
  if (term.values.length !== 1) return false;
  // raw.wasm may carry function-local backend indices that don't survive a
  // change of enclosing function — conservative skip.
  for (const inst of body.instrs) {
    if (inst.kind === "raw.wasm") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Recursion detection (transitive closure over the local call graph)
// ---------------------------------------------------------------------------

/**
 * Return the set of function names that are part of any call cycle (including
 * direct self-recursion) within the IR module. Only edges to locally-visible
 * callees count — cross-module / host imports don't appear in the graph.
 */
function computeRecursiveSet(mod: IrModule, byName: ReadonlyMap<string, IrFunction>): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const fn of mod.functions) {
    const set = new Set<string>();
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.kind === "call" && byName.has(instr.target.name)) {
          set.add(instr.target.name);
        }
      }
    }
    edges.set(fn.name, set);
  }
  const recursive = new Set<string>();
  for (const fn of mod.functions) {
    if (reachesSelf(fn.name, edges)) recursive.add(fn.name);
  }
  return recursive;
}

function reachesSelf(start: string, edges: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const visited = new Set<string>();
  const stack: string[] = [];
  const seed = edges.get(start);
  if (seed) for (const n of seed) stack.push(n);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === start) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const next = edges.get(cur);
    if (next) for (const n of next) stack.push(n);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Value-id remapping helpers
// ---------------------------------------------------------------------------

function countInstrs(fn: IrFunction): number {
  let n = 0;
  for (const b of fn.blocks) n += b.instrs.length;
  return n;
}

function mapId(rename: ReadonlyMap<IrValueId, IrValueId>, v: IrValueId): IrValueId {
  return rename.get(v) ?? v;
}

/**
 * Rewrite operand IDs in an instruction. Does NOT touch `result` — reserved
 * for caller-scope renames (where we only redirect uses, not definitions).
 */
function renameInstrOperands(inst: IrInstr, rename: ReadonlyMap<IrValueId, IrValueId>): IrInstr {
  if (rename.size === 0) return inst;
  switch (inst.kind) {
    case "const":
    case "global.get":
    case "raw.wasm":
      return inst;
    case "call": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "global.set": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "binary": {
      const l = mapId(rename, inst.lhs);
      const r = mapId(rename, inst.rhs);
      if (l === inst.lhs && r === inst.rhs) return inst;
      return { ...inst, lhs: l, rhs: r };
    }
    case "unary": {
      const r = mapId(rename, inst.rand);
      if (r === inst.rand) return inst;
      return { ...inst, rand: r };
    }
    case "select": {
      const c = mapId(rename, inst.condition);
      const t = mapId(rename, inst.whenTrue);
      const f = mapId(rename, inst.whenFalse);
      if (c === inst.condition && t === inst.whenTrue && f === inst.whenFalse) return inst;
      return { ...inst, condition: c, whenTrue: t, whenFalse: f };
    }
    case "box":
    case "unbox":
    case "tag.test": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "string.const":
      return inst;
    case "string.concat":
    case "string.eq": {
      const l = mapId(rename, inst.lhs);
      const r = mapId(rename, inst.rhs);
      if (l === inst.lhs && r === inst.rhs) return inst;
      return { ...inst, lhs: l, rhs: r };
    }
    case "string.len": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "object.new": {
      let changed = false;
      const newValues: IrValueId[] = [];
      for (const a of inst.values) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newValues.push(n);
      }
      if (!changed) return inst;
      return { ...inst, values: newValues };
    }
    case "object.get": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "object.set": {
      const v = mapId(rename, inst.value);
      const nv = mapId(rename, inst.newValue);
      if (v === inst.value && nv === inst.newValue) return inst;
      return { ...inst, value: v, newValue: nv };
    }
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new": {
      let changed = false;
      const newCaps: IrValueId[] = [];
      for (const c of inst.captures) {
        const n = mapId(rename, c);
        if (n !== c) changed = true;
        newCaps.push(n);
      }
      if (!changed) return inst;
      return { ...inst, captures: newCaps };
    }
    case "closure.cap": {
      const s = mapId(rename, inst.self);
      if (s === inst.self) return inst;
      return { ...inst, self: s };
    }
    case "closure.call": {
      const c = mapId(rename, inst.callee);
      let changed = c !== inst.callee;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, callee: c, args: newArgs };
    }
    case "refcell.new": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "refcell.get": {
      const c = mapId(rename, inst.cell);
      if (c === inst.cell) return inst;
      return { ...inst, cell: c };
    }
    case "refcell.set": {
      const c = mapId(rename, inst.cell);
      const v = mapId(rename, inst.value);
      if (c === inst.cell && v === inst.value) return inst;
      return { ...inst, cell: c, value: v };
    }
    // Slice 4 (#1169d): class ops.
    case "class.new": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "class.get": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "class.set": {
      const v = mapId(rename, inst.value);
      const nv = mapId(rename, inst.newValue);
      if (v === inst.value && nv === inst.newValue) return inst;
      return { ...inst, value: v, newValue: nv };
    }
    case "class.call": {
      const r = mapId(rename, inst.receiver);
      let changed = r !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: r, args: newArgs };
    }
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return inst;
    case "slot.write": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "vec.len": {
      const v = mapId(rename, inst.vec);
      if (v === inst.vec) return inst;
      return { ...inst, vec: v };
    }
    case "vec.get": {
      const v = mapId(rename, inst.vec);
      const idx = mapId(rename, inst.index);
      if (v === inst.vec && idx === inst.index) return inst;
      return { ...inst, vec: v, index: idx };
    }
    case "forof.vec": {
      const v = mapId(rename, inst.vec);
      // Body instrs must also have their operands rewritten.
      let bodyChanged = v !== inst.vec;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, vec: v, body: newBody };
    }
    // Slice 7a (#1169f): generator ops.
    case "gen.push": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "gen.epilogue":
      // No operands to rewrite.
      return inst;
  }
}

/**
 * Rewrite operands AND result through `rename`. Used when splicing a callee
 * instruction into the caller — every callee-scope id (including results)
 * must be mapped to a caller-scope id.
 */
function renameAllInInstr(inst: IrInstr, rename: ReadonlyMap<IrValueId, IrValueId>): IrInstr {
  const operandsRenamed = renameInstrOperands(inst, rename);
  if (operandsRenamed.result === null) return operandsRenamed;
  const newResult = rename.get(operandsRenamed.result) ?? operandsRenamed.result;
  if (newResult === operandsRenamed.result) return operandsRenamed;
  return { ...operandsRenamed, result: newResult };
}

function renameTerminatorOperands(t: IrTerminator, rename: ReadonlyMap<IrValueId, IrValueId>): IrTerminator {
  if (rename.size === 0) return t;
  switch (t.kind) {
    case "return": {
      let changed = false;
      const vals: IrValueId[] = [];
      for (const v of t.values) {
        const n = mapId(rename, v);
        if (n !== v) changed = true;
        vals.push(n);
      }
      if (!changed) return t;
      return { ...t, values: vals };
    }
    case "br": {
      const b = renameBranchOperands(t.branch, rename);
      if (b === t.branch) return t;
      return { ...t, branch: b };
    }
    case "br_if": {
      const c = mapId(rename, t.condition);
      const tt = renameBranchOperands(t.ifTrue, rename);
      const ff = renameBranchOperands(t.ifFalse, rename);
      if (c === t.condition && tt === t.ifTrue && ff === t.ifFalse) return t;
      return { ...t, condition: c, ifTrue: tt, ifFalse: ff };
    }
    case "unreachable":
      return t;
  }
}

function renameBranchOperands(br: IrBranch, rename: ReadonlyMap<IrValueId, IrValueId>): IrBranch {
  let changed = false;
  const args: IrValueId[] = [];
  for (const a of br.args) {
    const n = mapId(rename, a);
    if (n !== a) changed = true;
    args.push(n);
  }
  if (!changed) return br;
  return { target: br.target, args };
}
