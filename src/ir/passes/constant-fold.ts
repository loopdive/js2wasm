// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Constant folding for the middle-end IR — part of Phase 3a (#1167a).
//
// Two classes of rewrites:
//
//   1. `binary(const, const)` / `unary(const)` → `const <computed>`.
//      The instruction keeps its result IrValueId; only the `kind` +
//      operands are replaced with `{ kind: "const", value: <computed> }`.
//      Downstream uses of the result ID keep working with no rename.
//
//   2. `br_if(const cond, A, B)` → `br(A)` or `br(B)`.
//      A constant condition collapses the branch to an unconditional `br`.
//      The dead side becomes unreachable — `deadCode` removes it next.
//
// The pass walks block.instrs linearly, building up a value-id → IrConst
// map as it goes. Use-def information is NOT persistent — we rebuild the
// const-def map every call (see `lower.ts:293-326` `collectIrUses` /
// `collectTerminatorUses` for the same pattern).
//
// Opcode-specific folding goes through a dispatch table (see
// `BINARY_FOLD_TABLE`) so new Wasm ops can be added without bloating a
// single switch.
//
// `raw.wasm` is opaque — CF never rewrites it and never reads through it.

import {
  type IrBinop,
  type IrBlock,
  type IrConst,
  type IrFunction,
  type IrInstr,
  type IrInstrBinary,
  type IrInstrUnary,
  type IrTerminator,
  type IrUnop,
  type IrValueId,
} from "../nodes.js";

/**
 * Fold constant `prim`/`br_if` instructions. Returns the same reference
 * when no changes are made.
 */
export function constantFold(fn: IrFunction): IrFunction {
  // Seed the const-def map from every existing `const` instruction. The
  // seed is global across blocks — inter-block constant references are
  // valid in Phase 2+ IR, so folding needs to see them.
  const constDefs = new Map<IrValueId, IrConst>();
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.kind === "const" && instr.result !== null) {
        constDefs.set(instr.result, instr.value);
      }
    }
  }

  let changed = false;
  const newBlocks: IrBlock[] = fn.blocks.map((block) => {
    const newInstrs: IrInstr[] = [];
    for (const instr of block.instrs) {
      const rewritten = tryFoldInstr(instr, constDefs);
      if (rewritten !== instr) {
        changed = true;
        // A fold turned a binary/unary into a const — record the new def
        // so subsequent ops in the same or later blocks see it folded.
        if (rewritten.kind === "const" && rewritten.result !== null) {
          constDefs.set(rewritten.result, rewritten.value);
        }
      }
      newInstrs.push(rewritten);
    }

    const newTerm = tryFoldTerminator(block.terminator, constDefs);
    if (newTerm !== block.terminator) changed = true;

    if (newInstrs === block.instrs && newTerm === block.terminator) {
      // Nothing changed in this block.
      return block;
    }
    return {
      id: block.id,
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: newInstrs,
      terminator: newTerm,
    };
  });

  if (!changed) return fn;
  return {
    ...fn,
    blocks: newBlocks,
  };
}

// ---------------------------------------------------------------------------
// Instruction folding
// ---------------------------------------------------------------------------

function tryFoldInstr(instr: IrInstr, constDefs: ReadonlyMap<IrValueId, IrConst>): IrInstr {
  if (instr.kind === "binary") return tryFoldBinary(instr, constDefs);
  if (instr.kind === "unary") return tryFoldUnary(instr, constDefs);
  return instr;
}

function tryFoldBinary(instr: IrInstrBinary, constDefs: ReadonlyMap<IrValueId, IrConst>): IrInstr {
  const l = constDefs.get(instr.lhs);
  const r = constDefs.get(instr.rhs);
  if (!l || !r) return instr;
  const folded = foldBinary(instr.op, l, r);
  if (!folded) return instr;
  return {
    kind: "const",
    value: folded,
    result: instr.result,
    resultType: instr.resultType,
    site: instr.site,
  };
}

function tryFoldUnary(instr: IrInstrUnary, constDefs: ReadonlyMap<IrValueId, IrConst>): IrInstr {
  const o = constDefs.get(instr.rand);
  if (!o) return instr;
  const folded = foldUnary(instr.op, o);
  if (!folded) return instr;
  return {
    kind: "const",
    value: folded,
    result: instr.result,
    resultType: instr.resultType,
    site: instr.site,
  };
}

// ---------------------------------------------------------------------------
// Terminator folding
// ---------------------------------------------------------------------------

function tryFoldTerminator(t: IrTerminator, constDefs: ReadonlyMap<IrValueId, IrConst>): IrTerminator {
  if (t.kind !== "br_if") return t;
  const cond = constDefs.get(t.condition);
  if (cond === undefined) return t;
  const truthy = isConstTruthy(cond);
  if (truthy === null) return t; // unknown truthiness (e.g., f64 NaN edge case)
  const taken = truthy ? t.ifTrue : t.ifFalse;
  return { kind: "br", branch: taken, site: t.site };
}

/**
 * Extract a boolean from a const used as a `br_if` condition. `br_if`
 * conditions are i32 — `null` means we can't decide (shouldn't happen in
 * well-typed IR, but being defensive).
 */
function isConstTruthy(c: IrConst): boolean | null {
  switch (c.kind) {
    case "bool":
      return c.value;
    case "i32":
      return c.value !== 0;
    case "f64":
      // Wasm br_if expects i32; f64-typed conditions shouldn't reach here in
      // well-typed IR. If they do, treat as undecidable.
      return null;
    case "i64":
    case "f32":
    case "null":
    case "undefined":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Opcode dispatch tables
// ---------------------------------------------------------------------------

type BinaryFolder = (l: IrConst, r: IrConst) => IrConst | null;

const BINARY_FOLD_TABLE: Readonly<Record<IrBinop, BinaryFolder>> = {
  // f64 arithmetic — IEEE-754 semantics match JS number math, so plain
  // JS operators give the right result including NaN / Infinity cases.
  "f64.add": (l, r) => f64Arith(l, r, (a, b) => a + b),
  "f64.sub": (l, r) => f64Arith(l, r, (a, b) => a - b),
  "f64.mul": (l, r) => f64Arith(l, r, (a, b) => a * b),
  "f64.div": (l, r) => f64Arith(l, r, (a, b) => a / b),
  // f64 comparison → bool. JS comparison returns the right values for NaN
  // (always false) except for f64.ne, which must be true for NaN != NaN.
  "f64.eq": (l, r) => f64Cmp(l, r, (a, b) => a === b),
  "f64.ne": (l, r) => f64Cmp(l, r, (a, b) => a !== b),
  "f64.lt": (l, r) => f64Cmp(l, r, (a, b) => a < b),
  "f64.le": (l, r) => f64Cmp(l, r, (a, b) => a <= b),
  "f64.gt": (l, r) => f64Cmp(l, r, (a, b) => a > b),
  "f64.ge": (l, r) => f64Cmp(l, r, (a, b) => a >= b),
  // i32 comparison (bool === / !==) → bool.
  "i32.eq": (l, r) => i32Cmp(l, r, (a, b) => a === b),
  "i32.ne": (l, r) => i32Cmp(l, r, (a, b) => a !== b),
  // i32 logical (bool && / bool ||, operands are 0|1).
  "i32.and": (l, r) => i32Bool(l, r, (a, b) => a !== 0 && b !== 0),
  "i32.or": (l, r) => i32Bool(l, r, (a, b) => a !== 0 || b !== 0),
};

function foldBinary(op: IrBinop, l: IrConst, r: IrConst): IrConst | null {
  return BINARY_FOLD_TABLE[op](l, r);
}

function foldUnary(op: IrUnop, rand: IrConst): IrConst | null {
  switch (op) {
    case "f64.neg":
      if (rand.kind !== "f64") return null;
      return { kind: "f64", value: -rand.value };
    case "i32.eqz": {
      const v = toI32(rand);
      if (v === null) return null;
      return { kind: "bool", value: v === 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Const-operand helpers
// ---------------------------------------------------------------------------

function f64Arith(l: IrConst, r: IrConst, fn: (a: number, b: number) => number): IrConst | null {
  if (l.kind !== "f64" || r.kind !== "f64") return null;
  return { kind: "f64", value: fn(l.value, r.value) };
}

function f64Cmp(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  if (l.kind !== "f64" || r.kind !== "f64") return null;
  return { kind: "bool", value: fn(l.value, r.value) };
}

function i32Cmp(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  return { kind: "bool", value: fn(la, ra) };
}

function i32Bool(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  return { kind: "bool", value: fn(la, ra) };
}

function toI32(c: IrConst): number | null {
  if (c.kind === "i32") return c.value;
  if (c.kind === "bool") return c.value ? 1 : 0;
  return null;
}
