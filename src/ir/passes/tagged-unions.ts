// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Tagged-union lowering pass — spec #1167c Pass 2.
//
// When a value's propagated type is a `union` whose members are all
// Wasm-representable (homogeneous scalar widths — `f64|bool`, `f64|null`,
// `bool|null`), we want the middle-end IR to carry it as
// `IrType { kind: "union" }` and lower it to a WasmGC
// `$union_<members>` struct — not as an externref that the legacy path
// would round-trip through `__box_number`/`__unbox_number`.
//
// Pipeline role
// =============
//
// The PRODUCERS of `IrType.union` values (from-ast Slice 2 / propagation)
// and the CONSUMERS (`box`/`unbox`/`tag.test` lowering, already shipped in
// #1168) sit on either side of this pass. What this pass owns in V1:
//
//   1. Validation — scan every `box`/`unbox`/`tag.test` occurrence and
//      confirm the union referenced is supported by the V1 tagged-union
//      registry (homogeneous scalar widths, no externref / ref / funcref
//      members). Surfacing unsupported unions as pass output (rather than
//      letting lower.ts throw) gives the integration step a clean place to
//      fall back to the legacy path for that function.
//
//   2. Identity — unions that are already representable pass through
//      unchanged. The module's struct types are registered lazily when the
//      lowerer first sees the union (via `resolver.resolveUnion`), so no
//      registry interaction is needed here.
//
// What this pass does NOT do in V1
// ================================
//
// Pass 2's longer-term role is active REWRITING: converting externref-
// valued locals whose propagated LatticeType is a union into
// `IrType.union` with matching `box`/`unbox`/`tag.test` instructions. That
// rewrite depends on a LatticeType overlay being attached to each IrValueId
// (so the pass knows the value is logically `f64|bool` and not just an
// externref), which #1168 does not yet provide. Until that overlay lands,
// the transformation target set is empty: current from-ast does not emit
// externref-valued unions, and the `box`/`unbox`/`tag.test` IR instructions
// already lower straight to struct ops.
//
// So in V1 this pass returns the module unchanged. It exists in the
// pipeline as a clearly-named hook so the eventual rewrite lives in a
// purpose-built module instead of bolting onto lower.ts.
//
// Why not skip the pass entirely
// ==============================
//
// Wiring it into `integration.ts` now — even as an identity pass — means
// the pipeline topology is stable. When #1168-follow-up adds the lattice
// overlay, the implementation here grows inside this file; nothing else
// shifts. Passes are cheap when they're no-ops.
//
// The pass also validates. A future caller that hand-builds an IrFunction
// with an unsupported union (e.g. `union<f64, externref>`) can surface the
// error via this pass's `errors` output instead of crashing in lower.ts.

import type { IrFunction, IrInstr, IrModule, IrType } from "../nodes.js";
import type { ValType } from "../types.js";

export interface TaggedUnionsError {
  readonly func: string;
  readonly block: number;
  readonly message: string;
}

export interface TaggedUnionsResult {
  readonly module: IrModule;
  readonly errors: readonly TaggedUnionsError[];
}

/**
 * Run the tagged-unions pass. V1: validates that every `box`/`unbox`/
 * `tag.test` operand references a registry-supported union; returns the
 * module unchanged. Errors are reported but non-fatal — the caller decides
 * whether to fall back.
 */
export function taggedUnions(mod: IrModule): IrModule {
  return runTaggedUnions(mod).module;
}

/**
 * Variant exposed for tests / callers that want the full error list.
 * Most pipeline callers should use `taggedUnions` which discards errors.
 */
export function runTaggedUnions(mod: IrModule): TaggedUnionsResult {
  const errors: TaggedUnionsError[] = [];
  for (const fn of mod.functions) {
    validateFunction(fn, errors);
  }
  return { module: mod, errors };
}

// ---------------------------------------------------------------------------
// Validation — registry-support check
// ---------------------------------------------------------------------------

function validateFunction(fn: IrFunction, errors: TaggedUnionsError[]): void {
  for (const block of fn.blocks) {
    const blockId = block.id as number;
    for (const instr of block.instrs) {
      checkInstr(fn, blockId, instr, errors);
    }
  }
}

function checkInstr(fn: IrFunction, blockId: number, instr: IrInstr, errors: TaggedUnionsError[]): void {
  if (instr.kind === "box") {
    if (instr.toType.kind !== "union") {
      errors.push({
        func: fn.name,
        block: blockId,
        message: `box target must be a union IrType, got ${instr.toType.kind}`,
      });
      return;
    }
    if (!isRegistrySupported(instr.toType)) {
      errors.push({
        func: fn.name,
        block: blockId,
        message: `box target union<${memberList(instr.toType)}> is not supported by the V1 tagged-union registry`,
      });
    }
    return;
  }
  if (instr.kind === "unbox" || instr.kind === "tag.test") {
    // The operand's type is checked by the IR verifier; we only re-verify the
    // union shape here to surface unsupported members distinctly from the
    // SSA-scope verifier errors.
    const operandType = findOperandType(fn, instr.value);
    if (!operandType || operandType.kind !== "union") return;
    if (!isRegistrySupported(operandType)) {
      errors.push({
        func: fn.name,
        block: blockId,
        message: `${instr.kind} operand union<${memberList(operandType)}> is not supported by the V1 tagged-union registry`,
      });
    }
    return;
  }
}

/**
 * Mirror of `UnionStructRegistry.resolve`'s acceptance rules, kept local so
 * this pass doesn't depend on a `UnionTypeSink` just to do a read-only
 * support check. V1 homogeneous-scalar rules:
 *
 *   - ≥ 2 members
 *   - all members scalar (f64 / i32)
 *   - no externref / ref / funcref / eqref / anyref members
 */
function isRegistrySupported(t: Extract<IrType, { kind: "union" }>): boolean {
  if (t.members.length < 2) return false;
  for (const m of t.members) {
    if (!isScalarMember(m)) return false;
  }
  // Homogeneous-width check: allow any mix of f64 and i32 (V1 accepts mixed
  // — the `$val` width is the widest, which is f64 for f64+i32). Strings,
  // refs, and other widths are rejected above.
  return true;
}

function isScalarMember(m: ValType): boolean {
  return m.kind === "f64" || m.kind === "i32";
}

function memberList(t: Extract<IrType, { kind: "union" }>): string {
  return t.members.map((m) => m.kind).join(",");
}

// ---------------------------------------------------------------------------
// Local type-of lookup — scans the whole function (cheap; only used on
// error paths and for the unbox/tag.test checks).
// ---------------------------------------------------------------------------

function findOperandType(fn: IrFunction, value: number): IrType | null {
  for (const p of fn.params) {
    if ((p.value as number) === value) return p.type;
  }
  for (const block of fn.blocks) {
    for (let i = 0; i < block.blockArgs.length; i++) {
      if ((block.blockArgs[i] as number) === value) return block.blockArgTypes[i] ?? null;
    }
    for (const instr of block.instrs) {
      if (instr.result !== null && (instr.result as number) === value) return instr.resultType ?? null;
    }
  }
  return null;
}
