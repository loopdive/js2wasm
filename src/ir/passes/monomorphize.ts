// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Middle-end IR monomorphization — spec #1167c Pass 1.
//
// Clones polymorphic callees that are called with distinct argument type
// tuples across call sites, then redirects each call site to its
// type-specialised clone. This turns a single externref-boxing-through
// function into N narrow functions whose bodies can lower straight to
// ValType-typed Wasm code — avoiding the round-trip through `__box_number`
// / `__unbox_number` that the legacy path incurs on every boxed call.
//
// Why not re-run `buildTypeMap` afterwards
// ========================================
//
// `propagate.ts:buildTypeMap` walks the TypeScript AST. A clone such as
// `identity$string` has no `ts.FunctionDeclaration` — it exists only in
// the IR. So we cannot re-seed clone signatures by re-running buildTypeMap.
// Instead this pass RETURNS the clone signatures it produced; the pipeline
// integrates them into the `calleeTypes` override map (used by the
// AST→IR lowerer and subsequent passes) BEFORE downstream passes run.
//
// V1 scope — what we clone
// ========================
//
// A callee is monomorphizable iff ALL of:
//
//   - non-recursive (not part of any SCC, including self-loops)
//   - single-block body
//   - body instructions do NOT consume any parameter as an operand.
//     Rationale: if a callee's `f64.add(param, const)` is retyped from
//     `param: f64` to `param: externref`, the instruction's operand type
//     no longer matches the operator — producing invalid Wasm. V1 rejects
//     such callees; later phases will re-infer instruction resultTypes
//     under the retyped params.
//   - body size ≤ MAX_CALLEE_SIZE
//   - there exist ≥ 2 distinct argument-type tuples across its call sites
//   - distinct tuple count ≤ MAX_VARIANTS_PER_CALLEE
//
// The operand-free-of-params guard is narrow BUT covers the common
// "identity-like" polymorphic helpers (return-param, return-const) that
// pure-numeric code paths boxed-and-unboxed through on the legacy path.
//
// Growth guard (pass-end)
// =======================
//
// Before applying any clone, we compute the total new instructions across
// every planned clone. If `originalSize + newInstrs > 1.5 * originalSize`,
// we abandon the entire monomorphization. The guard fires pass-end, not
// per-callee, so the compositional blow-up across A→B→C each with 4
// variants (up to 64 clones of C) is detected globally.
//
// The "abandon the entire pass" fallback is coarse — a more sophisticated
// policy would drop the worst-ROI plans first. For V1 the coarse choice
// matches the spec's conservative posture: when in doubt, keep the module
// small.

import {
  asBlockId,
  type IrBlock,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrParam,
  type IrType,
  type IrValueId,
} from "../nodes.js";
import type { ValType } from "../types.js";

/** Maximum number of distinct type tuples we'll clone a single callee for. */
const MAX_VARIANTS_PER_CALLEE = 4;
/** Callees bigger than this are never cloned. */
const MAX_CALLEE_SIZE = 20;
/** New instructions budget relative to the module's pre-pass instruction count. */
const GROWTH_BUDGET = 0.5;

/**
 * Signature of an IR-only clone. The caller integrates this into its
 * `calleeTypes` override map so downstream passes see the narrowed types.
 */
export interface MonomorphizeCloneSignature {
  readonly params: readonly IrType[];
  readonly returnType: IrType;
}

export interface MonomorphizeResult {
  readonly module: IrModule;
  /** Map from clone name → signature. Empty when the pass made no changes. */
  readonly cloneSignatures: ReadonlyMap<string, MonomorphizeCloneSignature>;
}

/**
 * Monomorphize polymorphic callees across an IR module. Returns the input
 * module unchanged (and an empty signature map) when no profitable clones
 * exist or the growth budget would be exceeded.
 */
export function monomorphize(mod: IrModule): MonomorphizeResult {
  const byName = new Map<string, IrFunction>();
  for (const fn of mod.functions) byName.set(fn.name, fn);

  const recursiveSet = computeRecursiveSet(mod, byName);

  // -------------------------------------------------------------------------
  // Step 1 — collect every direct IR-local call site's (callee, argTypes).
  // -------------------------------------------------------------------------
  interface CallSite {
    /** Name of the function containing the call. */
    readonly callerName: string;
    /** Zero-based block index inside the caller. */
    readonly blockIdx: number;
    /** Zero-based instruction index inside the block. */
    readonly instrIdx: number;
    /** Name of the callee (resolved from IrFuncRef). */
    readonly calleeName: string;
    /** Tuple of argument types at this call site (in call-arg order). */
    readonly argTypes: readonly IrType[];
  }
  const callSites: CallSite[] = [];
  for (const fn of mod.functions) {
    const typeOf = buildLocalTypeOf(fn);
    fn.blocks.forEach((block, blockIdx) => {
      block.instrs.forEach((instr, instrIdx) => {
        if (instr.kind !== "call") return;
        if (!byName.has(instr.target.name)) return;
        const argTypes: IrType[] = [];
        for (const a of instr.args) {
          const t = typeOf(a);
          if (!t) return; // operand missing a resolvable type — skip the whole site
          argTypes.push(t);
        }
        if (argTypes.length !== instr.args.length) return;
        callSites.push({
          callerName: fn.name,
          blockIdx,
          instrIdx,
          calleeName: instr.target.name,
          argTypes,
        });
      });
    });
  }

  if (callSites.length === 0) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 2 — group call sites per callee by arg-type tuple.
  // -------------------------------------------------------------------------
  interface TupleGroup {
    readonly argTypes: readonly IrType[];
    readonly calls: CallSite[];
  }
  const grouped = new Map<string, Map<string, TupleGroup>>();
  for (const site of callSites) {
    if (recursiveSet.has(site.calleeName)) continue;
    const callee = byName.get(site.calleeName);
    if (!callee) continue;
    if (!isMonomorphizable(callee)) continue;
    let byKey = grouped.get(site.calleeName);
    if (!byKey) {
      byKey = new Map();
      grouped.set(site.calleeName, byKey);
    }
    const key = tupleKey(site.argTypes);
    let group = byKey.get(key);
    if (!group) {
      group = { argTypes: site.argTypes, calls: [] };
      byKey.set(key, group);
    }
    (group.calls as CallSite[]).push(site);
  }

  // -------------------------------------------------------------------------
  // Step 3 — plan clones.
  //
  // For each callee with > 1 distinct tuple and ≤ MAX_VARIANTS_PER_CALLEE:
  //   - Tuple 0 keeps targeting the original callee (no clone needed)
  //   - Tuples 1..N-1 each get a dedicated clone
  //
  // We only keep a plan if cloning preserves the callee's declared param
  // shape (same arity, same kind-count). A tuple whose arg count mismatches
  // the callee's param count is a bug upstream — skip the callee entirely.
  // -------------------------------------------------------------------------
  interface ClonePlan {
    readonly cloneName: string;
    readonly argTypes: readonly IrType[];
    readonly calls: readonly CallSite[];
  }
  const planByCallee = new Map<string, ClonePlan[]>();
  const usedNames = new Set<string>(byName.keys());
  for (const [calleeName, byKey] of grouped) {
    if (byKey.size < 2) continue;
    if (byKey.size > MAX_VARIANTS_PER_CALLEE) continue;
    const callee = byName.get(calleeName)!;
    const plans: ClonePlan[] = [];
    // Deterministic ordering: sort by tuple key so clone names are stable.
    const entries = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let skip = false;
    for (const [, group] of entries) {
      if (group.argTypes.length !== callee.params.length) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    // First tuple keeps the original callee. The rest get clones.
    for (let i = 1; i < entries.length; i++) {
      const [, group] = entries[i]!;
      const baseName = `${calleeName}$${nameSuffixFor(group.argTypes)}`;
      const cloneName = uniquifyName(baseName, usedNames);
      usedNames.add(cloneName);
      plans.push({ cloneName, argTypes: group.argTypes, calls: group.calls });
    }
    if (plans.length > 0) planByCallee.set(calleeName, plans);
  }

  if (planByCallee.size === 0) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 4 — pass-end growth guard.
  //
  // Sum new instructions across every planned clone; abandon the pass if
  // the total exceeds the budget. Evaluated AFTER all plans are collected
  // so compositional blow-ups (A→B→C each cloned N times) are visible.
  // -------------------------------------------------------------------------
  const originalSize = countModuleInstrs(mod);
  let newInstrs = 0;
  for (const [calleeName, plans] of planByCallee) {
    const calleeSize = countInstrs(byName.get(calleeName)!);
    newInstrs += plans.length * calleeSize;
  }
  if (newInstrs > originalSize * GROWTH_BUDGET) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 5 — build clones (fresh IrFunctions).
  // -------------------------------------------------------------------------
  const clonedFuncs: IrFunction[] = [];
  const cloneSignatures = new Map<string, MonomorphizeCloneSignature>();
  for (const [calleeName, plans] of planByCallee) {
    const callee = byName.get(calleeName)!;
    for (const plan of plans) {
      const { fn: clone, returnType } = cloneWithParamTypes(callee, plan.cloneName, plan.argTypes);
      clonedFuncs.push(clone);
      cloneSignatures.set(plan.cloneName, {
        params: plan.argTypes,
        returnType,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 6 — rewrite call sites in their source functions.
  // -------------------------------------------------------------------------
  interface Edit {
    readonly blockIdx: number;
    readonly instrIdx: number;
    readonly newTarget: string;
  }
  const edits = new Map<string, Edit[]>();
  for (const [, plans] of planByCallee) {
    for (const plan of plans) {
      for (const call of plan.calls) {
        let arr = edits.get(call.callerName);
        if (!arr) {
          arr = [];
          edits.set(call.callerName, arr);
        }
        arr.push({
          blockIdx: call.blockIdx,
          instrIdx: call.instrIdx,
          newTarget: plan.cloneName,
        });
      }
    }
  }

  const rewrittenFuncs: IrFunction[] = [];
  for (const fn of mod.functions) {
    const fnEdits = edits.get(fn.name);
    if (!fnEdits) {
      rewrittenFuncs.push(fn);
      continue;
    }
    rewrittenFuncs.push(applyEdits(fn, fnEdits));
  }

  return {
    module: { functions: [...rewrittenFuncs, ...clonedFuncs] },
    cloneSignatures,
  };
}

// ---------------------------------------------------------------------------
// Helpers — call graph and recursion detection
// ---------------------------------------------------------------------------

/** Set of function names that participate in any call cycle (self-loops included). */
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
// Helpers — local type resolution
// ---------------------------------------------------------------------------

/**
 * Build a function `(valueId) → IrType | null` for a single IrFunction. Looks
 * up params first, then any instruction's `resultType`. Returns null for
 * values we can't resolve locally (shouldn't happen in verified IR; we treat
 * defensively).
 */
function buildLocalTypeOf(fn: IrFunction): (v: IrValueId) => IrType | null {
  const map = new Map<IrValueId, IrType>();
  for (const p of fn.params) map.set(p.value, p.type);
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.result !== null && instr.resultType) {
        map.set(instr.result, instr.resultType);
      }
    }
    for (let i = 0; i < block.blockArgs.length; i++) {
      const id = block.blockArgs[i]!;
      const ty = block.blockArgTypes[i];
      if (ty) map.set(id, ty);
    }
  }
  return (v) => map.get(v) ?? null;
}

// ---------------------------------------------------------------------------
// Helpers — monomorphizability gate
// ---------------------------------------------------------------------------

/**
 * A callee is safely cloneable iff:
 *   - single-block
 *   - body ≤ MAX_CALLEE_SIZE instructions
 *   - body instructions do NOT reference any parameter as an operand
 *     (so retyping params cannot invalidate any operation)
 *   - terminator is a `return` (and single-block means that's the only
 *     terminator shape)
 */
function isMonomorphizable(fn: IrFunction): boolean {
  if (fn.blocks.length !== 1) return false;
  const block = fn.blocks[0]!;
  if (block.instrs.length > MAX_CALLEE_SIZE) return false;
  if (block.terminator.kind !== "return") return false;

  const paramIds = new Set<IrValueId>();
  for (const p of fn.params) paramIds.add(p.value);
  for (const instr of block.instrs) {
    for (const u of collectUses(instr)) {
      if (paramIds.has(u)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers — size accounting
// ---------------------------------------------------------------------------

function countInstrs(fn: IrFunction): number {
  let n = 0;
  for (const b of fn.blocks) n += b.instrs.length;
  return n;
}

function countModuleInstrs(mod: IrModule): number {
  let n = 0;
  for (const fn of mod.functions) n += countInstrs(fn);
  return n;
}

// ---------------------------------------------------------------------------
// Helpers — tuple key + name suffix
// ---------------------------------------------------------------------------

function tupleKey(types: readonly IrType[]): string {
  return types.map(irTypeKey).join(",");
}

function irTypeKey(t: IrType): string {
  if (t.kind === "val") return `v:${valTypeKey(t.val)}`;
  if (t.kind === "string") return "s";
  if (t.kind === "union") {
    const parts = [...t.members].map(valTypeKey).sort();
    return `u:${parts.join("|")}`;
  }
  return `b:${valTypeKey(t.inner)}`;
}

function valTypeKey(v: ValType): string {
  if (v.kind === "ref" || v.kind === "ref_null") {
    return `${v.kind}#${(v as { typeIdx: number }).typeIdx}`;
  }
  return v.kind;
}

/** Human-friendly suffix for a specialization: `identity$f64`, `identity$externref`, etc. */
function nameSuffixFor(types: readonly IrType[]): string {
  return types.map(irTypeKey).map(simplifyForName).join("_");
}

function simplifyForName(s: string): string {
  // Strip the `v:`/`u:`/`b:` tag — the clone name is for humans; resolution
  // goes through the name→IrFunction map in ctx.
  if (s.startsWith("v:")) return s.slice(2);
  if (s.startsWith("u:")) return `union_${s.slice(2).replace(/\|/g, "_")}`;
  if (s.startsWith("b:")) return `boxed_${s.slice(2)}`;
  return s;
}

function uniquifyName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}#${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Helpers — clone construction
// ---------------------------------------------------------------------------

/**
 * Deep-copy `callee` into a new IrFunction with `cloneName`, retyping each
 * parameter to the corresponding entry in `newParamTypes`. Also computes
 * and returns the clone's single return type (V1 restricts clones to
 * single-return, single-block shapes).
 *
 * Because `isMonomorphizable` guarantees no instruction consumes a param as
 * an operand, instruction-level resultTypes remain valid verbatim. Only the
 * function's own params (and downstream `fn.resultTypes`) shift.
 */
function cloneWithParamTypes(
  callee: IrFunction,
  cloneName: string,
  newParamTypes: readonly IrType[],
): { fn: IrFunction; returnType: IrType } {
  if (newParamTypes.length !== callee.params.length) {
    throw new Error(
      `ir/monomorphize: param-arity mismatch cloning ${callee.name}: expected ${callee.params.length}, got ${newParamTypes.length}`,
    );
  }

  // Param SSA ids are preserved verbatim (isMonomorphizable ensured nothing
  // in the body consumes them as operands, so no renaming is needed).
  const newParams: IrParam[] = callee.params.map((p, i) => ({
    value: p.value,
    type: newParamTypes[i]!,
    name: p.name,
  }));

  // Blocks are copied with terminator / instrs untouched. Single-block
  // invariant guarantees there is exactly one.
  const oldBlock = callee.blocks[0]!;
  const newBlock: IrBlock = {
    id: asBlockId(0),
    blockArgs: oldBlock.blockArgs,
    blockArgTypes: oldBlock.blockArgTypes,
    instrs: oldBlock.instrs.map((i) => i), // shallow copy is fine — instrs are frozen-shaped
    terminator: oldBlock.terminator,
  };

  // Compute return type from the (single) return terminator.
  const term = oldBlock.terminator;
  if (term.kind !== "return") {
    throw new Error(`ir/monomorphize: clone ${cloneName} has non-return terminator`);
  }
  if (term.values.length !== 1) {
    throw new Error(`ir/monomorphize: clone ${cloneName} has ${term.values.length} return values; V1 requires 1`);
  }
  const returnValueId = term.values[0]!;
  const returnType = deriveReturnType(returnValueId, newParams, oldBlock.instrs, callee);

  const fn: IrFunction = {
    name: cloneName,
    params: newParams,
    resultTypes: [returnType],
    blocks: [newBlock],
    exported: false,
    valueCount: callee.valueCount,
  };
  return { fn, returnType };
}

/**
 * Determine the return type of a monomorphized clone. Because the clone's
 * body instructions don't consume params, the return value is either:
 *   - a parameter → return type = retyped param type
 *   - an instruction result → return type = that instr's resultType
 *   - a block arg → entry block has no args in V1; this shouldn't happen
 */
function deriveReturnType(
  returnId: IrValueId,
  newParams: readonly IrParam[],
  instrs: readonly IrInstr[],
  callee: IrFunction,
): IrType {
  for (const p of newParams) {
    if (p.value === returnId) return p.type;
  }
  for (const inst of instrs) {
    if (inst.result === returnId && inst.resultType) return inst.resultType;
  }
  // Fall back to the callee's original declared return type.
  if (callee.resultTypes.length >= 1) return callee.resultTypes[0]!;
  throw new Error(`ir/monomorphize: cannot determine return type for clone of ${callee.name}`);
}

// ---------------------------------------------------------------------------
// Helpers — caller rewrites
// ---------------------------------------------------------------------------

function applyEdits(
  fn: IrFunction,
  edits: ReadonlyArray<{ readonly blockIdx: number; readonly instrIdx: number; readonly newTarget: string }>,
): IrFunction {
  const edited = new Map<string, string>(); // key = "blockIdx:instrIdx" → newTarget
  for (const e of edits) edited.set(`${e.blockIdx}:${e.instrIdx}`, e.newTarget);

  const newBlocks: IrBlock[] = fn.blocks.map((block, blockIdx) => {
    let blockChanged = false;
    const newInstrs: IrInstr[] = block.instrs.map((instr, instrIdx) => {
      const key = `${blockIdx}:${instrIdx}`;
      const newTarget = edited.get(key);
      if (!newTarget) return instr;
      if (instr.kind !== "call") return instr; // should never happen
      const newRef: IrFuncRef = { kind: "func", name: newTarget };
      blockChanged = true;
      return { ...instr, target: newRef };
    });
    if (!blockChanged) return block;
    return {
      id: block.id,
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: newInstrs,
      terminator: block.terminator,
    };
  });

  // Preserve reference identity if nothing actually changed. The caller of
  // the pass uses reference inequality to detect per-function changes.
  let anyChange = false;
  for (let i = 0; i < fn.blocks.length; i++) {
    if (newBlocks[i] !== fn.blocks[i]) {
      anyChange = true;
      break;
    }
  }
  if (!anyChange) return fn;
  return { ...fn, blocks: newBlocks };
}

// ---------------------------------------------------------------------------
// Helpers — SSA use collection (kept local so pass is self-contained)
// ---------------------------------------------------------------------------

function collectUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
    case "global.get":
    case "raw.wasm":
      return [];
    case "call":
      return instr.args;
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
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
