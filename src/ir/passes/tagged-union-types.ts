// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Tagged-union struct registry for the middle-end IR.
//
// An `IrType { kind: "union", members: ValType[] }` lowers to a WasmGC struct
// with a discriminator field (`$tag: i32`) plus a value field (`$val: T`)
// carrying the widest scalar member type. Each distinct member-set is
// emitted into the module's type table exactly once, memoised by a canonical
// string key derived from the sorted member kinds.
//
// V1 scope — homogeneous-width unions only
// =========================================
//
// We support unions whose non-null members all fit in the *same* ValType
// width class. In practice that's:
//
//   - `f64 | null`        — `$val: f64`, null signalled by $tag=2.
//   - `f64 | bool`        — `$val: f64`, bool 0/1 stored as 0.0/1.0 (or
//                           as-is — lowering passes inject the cast).
//   - `bool | null`       — `$val: i32`, null signalled by $tag=2.
//
// Heterogeneous unions (`f64 | string`, `bool | string`, `object(A) | object(B)`)
// would need either multiple typed `$val` fields or an externref-carrying
// member — both are explicitly out of scope for this issue. A union whose
// member set would be heterogeneous is instead treated as `dynamic`
// upstream in `propagate.ts`.
//
// Likewise, unions containing `externref` / `ref` / `funcref` / `ref_null`
// are rejected here — those already have their own representation and don't
// need a homogeneous tag+val struct.
//
// Canonical tag values
// ====================
//
//   0 = f64    (number)
//   1 = i32    (bool)
//   2 = null   / undefined  (representation is "the value in $val is absent")
//   3 = string ref          (externref to a WasmGC string)
//
// These constants are fixed module-wide. `UnionStructRegistry.tagFor(member)`
// projects each member ValType to its canonical tag; unsupported members
// throw.

import type { IrUnionLowering } from "../lower.js";
import type { StructTypeDef, ValType } from "../types.js";

/** Canonical tag constants — see module header. */
export const UNION_TAG_F64 = 0;
export const UNION_TAG_I32 = 1;
export const UNION_TAG_NULL = 2;
export const UNION_TAG_STRING = 3;

/**
 * Field layout within every $union_* struct. Keep this fixed across all
 * unions so tag reads and value reads don't have to dispatch on member set.
 */
export const UNION_TAG_FIELD_IDX = 0;
export const UNION_VAL_FIELD_IDX = 1;

/**
 * Minimal module-type sink — any container that can accept a WasmGC struct
 * type and report its index. Concretely the codegen module's
 * `ctx.mod.types`, but keeping the interface narrow makes the registry
 * independently unit-testable.
 */
export interface UnionTypeSink {
  /** Append `def` and return its module-wide type index. */
  push(def: StructTypeDef): number;
}

/**
 * Per-module registry of tagged-union struct types. Call `resolve(members)`
 * to get the `$union_<members>` lowering (registered lazily). Repeated
 * calls with equivalent member sets return the same lowering.
 */
export class UnionStructRegistry {
  private readonly cache = new Map<string, IrUnionLowering>();

  constructor(private readonly sink: UnionTypeSink) {}

  /**
   * Resolve the lowering for a union member set. Returns `null` when the
   * union is not representable under V1 rules (heterogeneous widths, or
   * contains reference-type members).
   */
  resolve(members: readonly ValType[]): IrUnionLowering | null {
    if (members.length < 2) {
      // A "union" of 0 or 1 members isn't a union — callers should have
      // simplified to the single member first.
      return null;
    }

    // Reject reference-type members. They're already references; boxing into
    // another struct layer adds no value and V1 doesn't support heterogeneous
    // widths anyway.
    for (const m of members) {
      if (
        m.kind === "externref" ||
        m.kind === "ref_extern" ||
        m.kind === "ref" ||
        m.kind === "ref_null" ||
        m.kind === "funcref" ||
        m.kind === "eqref" ||
        m.kind === "anyref"
      ) {
        return null;
      }
      // V1 accepts only scalar numeric / bool / null-carrying members.
      if (!isScalarUnionMember(m)) return null;
    }

    // Determine the $val field's ValType — must be homogeneous across
    // non-null members. null is tag-only; it doesn't constrain $val width.
    const nonNull = members.filter((m) => !isNullMember(m));
    if (nonNull.length === 0) return null;
    const valType = pickHomogeneousVal(nonNull);
    if (!valType) return null;

    const key = canonicalKey(members);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const name = buildUnionName(members);
    const def: StructTypeDef = {
      kind: "struct",
      name,
      fields: [
        { name: "$tag", type: { kind: "i32" }, mutable: false },
        { name: "$val", type: valType, mutable: false },
      ],
    };
    const typeIdx = this.sink.push(def);
    const lowering: IrUnionLowering = {
      typeIdx,
      tagFieldIdx: UNION_TAG_FIELD_IDX,
      valFieldIdx: UNION_VAL_FIELD_IDX,
      tagFor(member: ValType): number {
        return tagFor(member);
      },
    };
    this.cache.set(key, lowering);
    return lowering;
  }
}

/**
 * Canonical tag constant for a ValType that may appear in a union. Kept as
 * a free function so unit tests can exercise it without instantiating the
 * full registry.
 */
export function tagFor(member: ValType): number {
  switch (member.kind) {
    case "f64":
      return UNION_TAG_F64;
    case "i32":
      return UNION_TAG_I32;
    case "externref":
    case "ref_extern":
      return UNION_TAG_STRING;
    default:
      // Caller should have validated via `isScalarUnionMember` before asking.
      throw new Error(`tagFor: unsupported union member kind "${member.kind}"`);
  }
}

function isScalarUnionMember(m: ValType): boolean {
  return m.kind === "f64" || m.kind === "i32" || isNullMember(m);
}

/**
 * Null is represented as an i32 member by convention. The tag (UNION_TAG_NULL)
 * is what actually signals "null"; the $val slot is meaningless for null.
 *
 * V1 doesn't model `null` as a distinct ValType — upstream lattice
 * `{kind:"null"}` (if/when introduced) maps here by convention; any other
 * scalar continues to ride its own kind. This helper is an extension point.
 */
function isNullMember(_m: ValType): boolean {
  // Currently no ValType kind directly encodes null — null members of a
  // union are handled via tag discrimination in the lattice layer, and
  // reach this registry already reduced to their scalar $val width.
  return false;
}

/**
 * For homogeneous-width V1 unions, pick the single ValType the $val field
 * will carry. Returns `null` when the members disagree (heterogeneous).
 *
 * Widening rules (scalar only):
 *   - All-f64                      → f64
 *   - All-i32                      → i32
 *   - Mixed f64/i32                → f64 (i32 zero-extends into f64 bits
 *                                   at box time; caller injects the cast).
 */
function pickHomogeneousVal(members: readonly ValType[]): ValType | null {
  let sawF64 = false;
  let sawI32 = false;
  for (const m of members) {
    if (m.kind === "f64") sawF64 = true;
    else if (m.kind === "i32") sawI32 = true;
    else return null;
  }
  if (sawF64) return { kind: "f64" };
  if (sawI32) return { kind: "i32" };
  return null;
}

/**
 * Canonical string key for a member set — used to memoise the registry.
 * Sorts by kind so `[f64, i32]` and `[i32, f64]` share the same struct type.
 */
function canonicalKey(members: readonly ValType[]): string {
  const sorted = [...members].map(memberKey).sort();
  return sorted.join("|");
}

function memberKey(m: ValType): string {
  if (m.kind === "ref" || m.kind === "ref_null") {
    return `${m.kind}:${(m as { typeIdx: number }).typeIdx}`;
  }
  return m.kind;
}

/**
 * Human-readable type name — used for debugging / wasm text.
 * Example: `{f64, i32}` → `$union_f64_i32`.
 */
function buildUnionName(members: readonly ValType[]): string {
  const parts = [...members].map(memberKey).sort();
  return `$union_${parts.join("_")}`;
}
