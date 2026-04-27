// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Middle-end SSA IR — per spec #1131.
//
// This file is intentionally separate from `types.ts` (the backend Wasm IR).
// The middle-end IR sits between the TypedAST and the Wasm IR, and carries:
//   - Symbolic references to functions, globals, and types (not raw indices).
//   - Typed SSA value nodes carrying IrType, not ValType.
//   - Basic-block structure with block arguments (linear SSA with blockargs).
//   - Source location metadata (for error reporting and debug info).
//
// Phase 1 scope: the smallest set of node shapes needed to describe
// `function f(): number { return <literal>; }`. The union is open —
// Phase 2 & 3 widen the Instr and Terminator sets.

import type { ValType } from "./types.js";

// ---------------------------------------------------------------------------
// Symbolic references
// ---------------------------------------------------------------------------
//
// Symbolic refs are the whole reason the middle-end IR exists. The legacy
// pipeline embeds raw funcIdx / globalIdx integers in emitted instructions,
// so any late import addition must re-walk every body via
// `shiftLateImportIndices` to rewrite those integers. The IR instead emits
// a symbolic `IrFuncRef { name }`; lowering resolves it to a concrete index
// AFTER all imports are finalized, making the shift pass a no-op on the
// IR path.

export interface IrFuncRef {
  readonly kind: "func";
  /** Unique function name (same namespace as `ctx.funcMap`). */
  readonly name: string;
}

export interface IrGlobalRef {
  readonly kind: "global";
  /** Unique global name (same namespace as `ctx.globalMap` or similar). */
  readonly name: string;
}

export interface IrTypeRef {
  readonly kind: "type";
  /** Unique WasmGC type name (same namespace as `ctx.typeNames`). */
  readonly name: string;
}

export type IrSymRef = IrFuncRef | IrGlobalRef | IrTypeRef;

// ---------------------------------------------------------------------------
// IR types
// ---------------------------------------------------------------------------
//
// IrType is the middle-end's own type. It is a discriminated union over the
// shapes the middle-end needs to describe:
//
//   { kind: "val",   val: ValType }      A single concrete Wasm value type —
//                                        the 1:1 wrapper around a backend
//                                        ValType (i32, f64, externref, …).
//   { kind: "union", members: ValType[] } A tagged union of ValTypes, lowered
//                                        to a canonical WasmGC struct with a
//                                        `$tag: i32` discriminator + one or
//                                        more `$val` fields. V1 scope:
//                                        homogeneous-width members only
//                                        (e.g. `f64|bool`, `f64|null`).
//                                        Members containing `externref` /
//                                        `ref` / `funcref` fall back to
//                                        `dynamic` upstream.
//   { kind: "boxed", inner: ValType }    A heap-allocated single-field box
//                                        (`struct (field $val inner)`) —
//                                        lets the middle-end materialise
//                                        scalars on the heap when a
//                                        downstream pass needs a reference.
//
// Every IrType use-site that would have passed a raw `ValType` now either
//   (a) wraps with `irVal(v)` to produce `{ kind: "val", val: v }`, or
//   (b) reads back via `asVal(t)` which returns the underlying `ValType`
//       when `t.kind === "val"`, otherwise `null`.
//
// Lowering contract (in `lower.ts`):
//   { kind: "val",   val }     → `val` (unchanged).
//   { kind: "union", members } → ref to the canonical `$union_<members>`
//                                struct (registered once per module via
//                                `passes/tagged-union-types.ts`).
//   { kind: "boxed", inner }   → ref to a single-field struct with the
//                                inner ValType as its `$val`.

/**
 * A canonical object shape — a sorted list of named fields with their IR
 * types. Equal shapes (same names, same types in the same canonical order)
 * resolve to the same WasmGC struct via the lowerer's resolver. Carrying
 * the field types as `IrType` (not `ValType`) lets a struct-of-string or
 * struct-of-object compose cleanly: the resolver recursively materializes
 * field types when registering the WasmGC struct.
 *
 * Names must be unique. The constructor in `from-ast.ts` sorts by name
 * before constructing the IrType so structurally-identical shapes compare
 * equal regardless of source order.
 */
export interface IrObjectShape {
  readonly fields: readonly { readonly name: string; readonly type: IrType }[];
}

/**
 * Slice 3 (#1169c) — a closure's caller-visible signature. Used both as
 * the IR-level type discriminator for closure values and as the resolver
 * lookup key for the supertype struct + lifted func type. The implicit
 * `__self` struct param at index 0 of the lifted body is NOT present in
 * `params` — it's added by the resolver when synthesizing the func type.
 */
export interface IrClosureSignature {
  readonly params: readonly IrType[];
  readonly returnType: IrType;
}

/**
 * Slice 4 (#1169d) — descriptor for one field on a class.
 */
export interface IrClassFieldDescriptor {
  readonly name: string;
  readonly type: IrType;
}

/**
 * Slice 4 (#1169d) — descriptor for one instance method on a class. The
 * implicit `this` receiver is NOT listed in `params` — the lowerer
 * prepends it when emitting the call. A void method has
 * `returnType: null`.
 */
export interface IrClassMethodDescriptor {
  readonly name: string;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
}

/**
 * Slice 4 (#1169d) — symbolic descriptor for a class declared in the
 * compilation unit. Carries the structural info the IR builder needs to
 * type-check `new`/field-access/method-call expressions on instances of
 * this class without consulting the lowering resolver.
 *
 *   - `className`        unique discriminator (one class per name per unit)
 *   - `fields`           user fields in canonical order (alphabetical)
 *                        — the lowerer maps each field `name` to a Wasm
 *                        struct field index via `resolveClass`, which knows
 *                        about the legacy `__tag` prefix at field 0.
 *   - `methods`          instance methods with caller-visible signatures.
 *                        Static methods are out of slice 4 scope and are
 *                        not listed.
 *   - `constructorParams` user-visible param list for `new C(...)`.
 *
 * Class methods themselves are NOT IR-claimable in slice 4 — they remain
 * on the legacy class-bodies path. The IR only references them by name
 * (`<className>_<methodName>`) at call-site lowering, where the resolver
 * maps the name to the legacy-allocated funcIdx.
 */
export interface IrClassShape {
  readonly className: string;
  readonly fields: readonly IrClassFieldDescriptor[];
  readonly methods: readonly IrClassMethodDescriptor[];
  readonly constructorParams: readonly IrType[];
}

export type IrType =
  | { readonly kind: "val"; readonly val: ValType }
  // Backend-agnostic string marker (#1169a). The actual Wasm representation
  // is decided at lowering time via `IrLowerResolver.resolveString`:
  //   - host-strings backend  → `externref`
  //   - native-strings backend → `(ref $AnyString)`
  // Keeping the IR type backend-agnostic mirrors how `union`/`boxed` defer
  // their concrete struct to the resolver. From the middle-end's point of
  // view a `string` value is a single SSA def with no member structure.
  | { readonly kind: "string" }
  // Backend-agnostic object-shape marker (#1169b). The actual WasmGC struct
  // is registered lazily by `IrLowerResolver.resolveObject`. Like `union`
  // and `boxed`, the IR carries enough information to drive the resolver
  // without committing to a specific Wasm typeIdx until lowering time.
  | { readonly kind: "object"; readonly shape: IrObjectShape }
  // Backend-agnostic closure marker (#1169c). Carries the caller-visible
  // signature only — captures are an implementation detail of the
  // closure-construction site, not a type-system property. Two closure
  // values with the same signature but different captures share the same
  // IrType (matches the legacy funcref-wrapper supertype pattern). The
  // resolver registers a base WasmGC struct per signature plus a subtype
  // struct per (signature, captureFieldTypes) pair.
  | { readonly kind: "closure"; readonly signature: IrClosureSignature }
  // Slice 4 (#1169d) — symbolic class instance reference. The Wasm-level
  // value type is `(ref $ClassStruct)` where the struct is registered by
  // the legacy `collectClassDeclaration` pass; the resolver maps
  // `shape.className` to the concrete struct typeIdx + the fieldIdx /
  // method funcIdx tables. The IR carries the full shape so the
  // AST→IR lowerer can statically resolve field types and method
  // signatures without resolver round-trips.
  | { readonly kind: "class"; readonly shape: IrClassShape }
  | { readonly kind: "union"; readonly members: readonly ValType[] }
  // Slice 3 (#1169c) repurposes `boxed` as the ref-cell type for mutable
  // captures. The inner ValType is the cell's stored type; the resolver
  // delegates to `getOrRegisterRefCellType` so legacy and IR ref cells
  // share the same WasmGC struct.
  | { readonly kind: "boxed"; readonly inner: ValType };

/** Wrap a plain ValType as an IrType — the common path for Phase 1/2 callers. */
export function irVal(v: ValType): IrType {
  return { kind: "val", val: v };
}

/**
 * Return the single underlying ValType for a `val`-kind IrType, else `null`.
 * Call sites that previously did `t.kind === "f64"` against an `IrType` now
 * do `asVal(t)?.kind === "f64"`.
 */
export function asVal(t: IrType): ValType | null {
  return t.kind === "val" ? t.val : null;
}

/**
 * Structural equality for IrType. Two types are equal iff they have the same
 * shape and their underlying ValType members compare structurally equal.
 *
 * Used by the verifier and by migration assertions. We keep the implementation
 * local to avoid pulling a full deep-equal dep into the IR layer.
 */
export function irTypeEquals(a: IrType, b: IrType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "val" && b.kind === "val") return valTypeEquals(a.val, b.val);
  if (a.kind === "string" && b.kind === "string") return true;
  if (a.kind === "boxed" && b.kind === "boxed") return valTypeEquals(a.inner, b.inner);
  if (a.kind === "union" && b.kind === "union") {
    if (a.members.length !== b.members.length) return false;
    for (let i = 0; i < a.members.length; i++) {
      if (!valTypeEquals(a.members[i]!, b.members[i]!)) return false;
    }
    return true;
  }
  if (a.kind === "object" && b.kind === "object") {
    return objectShapeEquals(a.shape, b.shape);
  }
  if (a.kind === "closure" && b.kind === "closure") {
    return closureSignatureEquals(a.signature, b.signature);
  }
  if (a.kind === "class" && b.kind === "class") {
    return classShapeEquals(a.shape, b.shape);
  }
  return false;
}

/**
 * Slice 4 (#1169d): structural equality for class shapes. `className` is
 * the discriminator — every class is unique within a compilation unit, so
 * two `IrClassShape` values with the same `className` represent the same
 * class. We don't recurse into `fields` / `methods` / `constructorParams`
 * because they're a deterministic projection of `className` (one
 * declaration per class per unit). Cross-unit class types are out of
 * slice 4 scope.
 */
export function classShapeEquals(a: IrClassShape, b: IrClassShape): boolean {
  return a.className === b.className;
}

/**
 * Structural equality for closure signatures. Recurses through param /
 * return IrTypes via `irTypeEquals` so a closure-of-closure or a
 * closure-of-object compares correctly.
 */
export function closureSignatureEquals(a: IrClosureSignature, b: IrClosureSignature): boolean {
  if (a.params.length !== b.params.length) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (!irTypeEquals(a.params[i]!, b.params[i]!)) return false;
  }
  return irTypeEquals(a.returnType, b.returnType);
}

/**
 * Structural equality for object shapes. Field lists must be parallel
 * (same length, same order, same name and IrType per slot). Recursing
 * via `irTypeEquals` lets nested object fields compare correctly.
 */
export function objectShapeEquals(a: IrObjectShape, b: IrObjectShape): boolean {
  if (a.fields.length !== b.fields.length) return false;
  for (let i = 0; i < a.fields.length; i++) {
    const fa = a.fields[i]!;
    const fb = b.fields[i]!;
    if (fa.name !== fb.name) return false;
    if (!irTypeEquals(fa.type, fb.type)) return false;
  }
  return true;
}

function valTypeEquals(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ref" || a.kind === "ref_null") {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SSA values
// ---------------------------------------------------------------------------

/**
 * An SSA value ID — uniquely identifies one defining instruction or block arg
 * within one IrFunction. Values are NOT shared across functions.
 *
 * Represented as a branded number for cheap comparison + map-key use. `-1`
 * is reserved as an intentionally invalid sentinel and must never appear in
 * an emitted IR graph.
 */
export type IrValueId = number & { readonly __brand: "IrValueId" };

export function asValueId(n: number): IrValueId {
  return n as IrValueId;
}

/** Allocate sequential IrValueIds within a function. */
export class IrValueIdAllocator {
  private next = 0;
  fresh(): IrValueId {
    return asValueId(this.next++);
  }
  get count(): number {
    return this.next;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type IrConst =
  | { readonly kind: "i32"; readonly value: number }
  | { readonly kind: "i64"; readonly value: bigint }
  | { readonly kind: "f32"; readonly value: number }
  | { readonly kind: "f64"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "null"; readonly ty: IrType }
  | { readonly kind: "undefined" };

// ---------------------------------------------------------------------------
// Instructions (pure, side-effecting, and memory ops)
// ---------------------------------------------------------------------------
//
// An IrInstr defines zero or one SSA values (`result`). Multi-result support
// (for destructuring / tuple returns) is deferred to Phase 2.
//
// `site` carries source-location info for diagnostics and source maps. It's
// kept minimal — line/column — and is optional so Phase 1 builders can omit
// it without the verifier complaining.

export interface IrSiteId {
  readonly line: number;
  readonly column: number;
}

export interface IrInstrBase {
  /** SSA def produced by this instr. `null` for void instrs. */
  readonly result: IrValueId | null;
  /** Static type of the result, if any. Redundant w/ `result`'s type but kept local for verifier speed. */
  readonly resultType: IrType | null;
  /** Source location for diagnostics. Optional in Phase 1. */
  readonly site?: IrSiteId;
}

/** Materialize a constant into an SSA value. */
export interface IrInstrConst extends IrInstrBase {
  readonly kind: "const";
  readonly value: IrConst;
}

/** Call a function by symbolic reference. Return value (if any) is `result`. */
export interface IrInstrCall extends IrInstrBase {
  readonly kind: "call";
  readonly target: IrFuncRef;
  readonly args: readonly IrValueId[];
}

/** Read a global by symbolic reference. */
export interface IrInstrGlobalGet extends IrInstrBase {
  readonly kind: "global.get";
  readonly target: IrGlobalRef;
}

/** Write a global by symbolic reference. Void-result. */
export interface IrInstrGlobalSet extends IrInstrBase {
  readonly kind: "global.set";
  readonly target: IrGlobalRef;
  readonly value: IrValueId;
}

/**
 * Typed binary primitive. The `op` tag encodes both operand type(s) and the
 * operation, so the lowerer can map 1:1 to a Wasm instruction without
 * re-inferring types. Phase 1 covers the numeric/bool subset.
 */
export type IrBinop =
  // f64 arithmetic
  | "f64.add"
  | "f64.sub"
  | "f64.mul"
  | "f64.div"
  // f64 comparison → i32 (bool)
  | "f64.eq"
  | "f64.ne"
  | "f64.lt"
  | "f64.le"
  | "f64.gt"
  | "f64.ge"
  // i32 comparison (used for bool === / !==) → i32
  | "i32.eq"
  | "i32.ne"
  // i32 logical (for bool && / || — operands assumed 0|1)
  | "i32.and"
  | "i32.or";

/**
 * Typed unary primitive. `f64.neg` negates a number. `i32.eqz` implements
 * bool negation (`!x` where x is bool — 0↔1).
 */
export type IrUnop = "f64.neg" | "i32.eqz";

export interface IrInstrBinary extends IrInstrBase {
  readonly kind: "binary";
  readonly op: IrBinop;
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
}

export interface IrInstrUnary extends IrInstrBase {
  readonly kind: "unary";
  readonly op: IrUnop;
  readonly rand: IrValueId;
}

/**
 * Conditional expression — lowers to Wasm `select`. Both arms are evaluated;
 * this is safe for pure Phase 1 expressions (no calls, no side effects).
 * Branching control flow (for statements with side effects) comes in Phase 2
 * via `br_if` terminators.
 */
export interface IrInstrSelect extends IrInstrBase {
  readonly kind: "select";
  readonly condition: IrValueId;
  readonly whenTrue: IrValueId;
  readonly whenFalse: IrValueId;
}

/**
 * Escape hatch: a raw backend instruction sequence with no SSA structure.
 * Phase 1 uses this as a bridge so we can describe any function without
 * re-encoding the whole Wasm opcode set in IR. Phase 2 will narrow uses.
 * The verifier treats it as an opaque block: stack contract must match.
 */
export interface IrInstrRawWasm extends IrInstrBase {
  readonly kind: "raw.wasm";
  /** Backend ops to emit verbatim. */
  readonly ops: readonly import("./types.js").Instr[];
  /** Wasm value-stack delta after running `ops` (positive = pushes). */
  readonly stackDelta: number;
}

/**
 * Box a scalar into a tagged-union struct. `toType` must be an `IrType.union`
 * whose `members` contains `value`'s static ValType. Lowering emits
 * `struct.new $union_<members>` with the matching tag constant + the value
 * in the `$val` field. Result is `(ref $union_<members>)` / the `toType`.
 */
export interface IrInstrBox extends IrInstrBase {
  readonly kind: "box";
  readonly value: IrValueId;
  readonly toType: IrType;
}

/**
 * Unbox a tagged-union value to one of its member ValTypes. The caller must
 * have proved the tag already (via `tag.test` earlier in the same IR path);
 * lowering emits a plain `struct.get $val` without a tag check at runtime.
 * A debug-mode assertion can still verify the tag.
 */
export interface IrInstrUnbox extends IrInstrBase {
  readonly kind: "unbox";
  readonly value: IrValueId;
  readonly tag: ValType;
}

/**
 * Runtime tag discriminator — result (via `IrInstrBase.result`) is `i32`,
 * 1 if `value`'s runtime tag matches `tag`, else 0. `value` must be a
 * tagged-union type containing `tag` as a member. Lowers to
 * `struct.get $tag; i32.const <N>; i32.eq`.
 */
export interface IrInstrTagTest extends IrInstrBase {
  readonly kind: "tag.test";
  readonly value: IrValueId;
  readonly tag: ValType;
}

// ---------------------------------------------------------------------------
// String operations (#1169a — IR Phase 4 Slice 1)
// ---------------------------------------------------------------------------
//
// All string ops are backend-agnostic at the IR level: they carry the raw
// JS string value (for `string.const`) or operand IDs, and rely on the
// `IrLowerResolver` to emit the appropriate backend op sequence (host
// `wasm:js-string` builtins vs. native NativeString GC structs).

/**
 * Materialize a string literal as an SSA value of `IrType.string`. The
 * backend representation is determined by `IrLowerResolver.emitStringConst`:
 *   - host strings → register a `string_constants.<value>` global import,
 *                    emit `global.get`.
 *   - native       → emit inline `array.new_fixed` of the WTF-16 code units,
 *                    then `struct.new $NativeString`.
 */
export interface IrInstrStringConst extends IrInstrBase {
  readonly kind: "string.const";
  /** Raw JS string; the lowerer treats `value.length` as UTF-16 code units. */
  readonly value: string;
}

/**
 * Concatenate two strings — the ECMAScript `s1 + s2` operator restricted to
 * the case where both operands are statically known to be strings. Result
 * type: `IrType.string`.
 */
export interface IrInstrStringConcat extends IrInstrBase {
  readonly kind: "string.concat";
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
}

/**
 * String equality. `===` and `!==` are both modeled via this single instr —
 * `negate: true` ↔ `!==`. Result type: `i32` (bool).
 */
export interface IrInstrStringEq extends IrInstrBase {
  readonly kind: "string.eq";
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
  readonly negate: boolean;
}

/**
 * String length — corresponds to the JS `s.length` property access. Despite
 * the underlying Wasm op returning `i32`, the IR result is `f64` to match
 * JS Number semantics, so consumers can compose with the rest of the
 * numeric IR without an extra coercion step. Lowering inserts the
 * `f64.convert_i32_s` after the backend's length op.
 */
export interface IrInstrStringLen extends IrInstrBase {
  readonly kind: "string.len";
  readonly value: IrValueId;
}

// ---------------------------------------------------------------------------
// Object operations (#1169b — IR Phase 4 Slice 2)
// ---------------------------------------------------------------------------

/**
 * Materialize an object literal as a WasmGC struct. `shape` declares the
 * struct's field layout (already canonically sorted by name); `values` is
 * parallel to `shape.fields` and must have the same length. Lowering emits
 * each value in canonical order followed by `struct.new $obj_<shape>`.
 *
 * Result type: `{ kind: "object", shape }`.
 */
export interface IrInstrObjectNew extends IrInstrBase {
  readonly kind: "object.new";
  readonly shape: IrObjectShape;
  readonly values: readonly IrValueId[];
}

/**
 * Read a named field from an object. `value` must be of `IrType.object`
 * with a shape whose `fields` contain `name`. Lowering emits
 * `struct.get $obj_<shape> <fieldIdx>`.
 *
 * Result type: the field's IrType (must match `resultType`).
 */
export interface IrInstrObjectGet extends IrInstrBase {
  readonly kind: "object.get";
  readonly value: IrValueId;
  readonly name: string;
}

/**
 * Write a named field on an object. `value` must be `IrType.object`,
 * `newValue` must match the field's IrType. Void result. Lowering emits
 * `struct.set $obj_<shape> <fieldIdx>`.
 */
export interface IrInstrObjectSet extends IrInstrBase {
  readonly kind: "object.set";
  readonly value: IrValueId;
  readonly name: string;
  readonly newValue: IrValueId;
}

// ---------------------------------------------------------------------------
// Closure + ref-cell operations (#1169c — IR Phase 4 Slice 3)
// ---------------------------------------------------------------------------

/**
 * Materialize a closure value. `liftedFunc` names the lifted top-level
 * function (registered in the IR module as a synthesized BuiltFn).
 * `signature` is the caller-visible signature (used to look up the
 * supertype struct + funcref type). `captures` populates the subtype's
 * capture fields parallel to `captureFieldTypes`.
 *
 * Lowering emits:
 *   ref.func $lifted
 *   <push each capture>
 *   struct.new $closure_<signature>_<captureSig>
 *
 * Result type: `{ kind: "closure"; signature }`. The Wasm-level value
 * type is the supertype struct so call_ref against the base func type
 * accepts any subtype.
 */
export interface IrInstrClosureNew extends IrInstrBase {
  readonly kind: "closure.new";
  readonly liftedFunc: IrFuncRef;
  readonly signature: IrClosureSignature;
  /** Capture-field IrTypes in struct field order (post-funcref). */
  readonly captureFieldTypes: readonly IrType[];
  /** SSA values populating the capture fields, parallel to captureFieldTypes. */
  readonly captures: readonly IrValueId[];
}

/**
 * Read a capture field from the implicit `__self` closure struct. Only
 * valid inside a lifted closure body whose IrFunction carries
 * `closureSubtype` metadata. `index` is the 0-based capture position
 * (post-funcref).
 *
 * Lowering emits:
 *   <self>
 *   ref.cast $self_subtype
 *   struct.get $self_subtype (index+1)
 */
export interface IrInstrClosureCap extends IrInstrBase {
  readonly kind: "closure.cap";
  /** SSA value of the closure-typed __self param (the lifted func's param 0). */
  readonly self: IrValueId;
  readonly index: number;
}

/**
 * Invoke a closure value. `callee` must be `IrType.closure`. `args` must
 * match the signature's params arity and types.
 *
 * Lowering emits:
 *   <emit callee>          ;; pushes self
 *   <emit args>
 *   <emit callee>          ;; pushes self again — second use forces a Wasm local
 *   struct.get $base_struct $func
 *   call_ref $base_funcType
 *
 * Result type: `signature.returnType`.
 */
export interface IrInstrClosureCall extends IrInstrBase {
  readonly kind: "closure.call";
  readonly callee: IrValueId;
  readonly args: readonly IrValueId[];
}

/**
 * Wrap a primitive value in a fresh ref cell. Lowering:
 *   <emit value>
 *   struct.new $refcell_<inner>
 *
 * Result type: `{ kind: "boxed"; inner: <ValType of value> }`.
 */
export interface IrInstrRefCellNew extends IrInstrBase {
  readonly kind: "refcell.new";
  readonly value: IrValueId;
}

/**
 * Read the inner value out of a ref cell. `cell` must be `IrType.boxed`.
 * Result type is `irVal(cell.inner)`.
 *
 * Lowering: `<emit cell>; struct.get $refcell 0`.
 */
export interface IrInstrRefCellGet extends IrInstrBase {
  readonly kind: "refcell.get";
  readonly cell: IrValueId;
}

/**
 * Write a new value through a ref cell. `cell` must be `IrType.boxed`,
 * `value` ValType must equal `cell.inner`. Void result.
 *
 * Lowering: `<emit cell>; <emit value>; struct.set $refcell 0`.
 */
export interface IrInstrRefCellSet extends IrInstrBase {
  readonly kind: "refcell.set";
  readonly cell: IrValueId;
  readonly value: IrValueId;
}

// ---------------------------------------------------------------------------
// Class operations (#1169d — IR Phase 4 Slice 4)
// ---------------------------------------------------------------------------
//
// Class instances live as `(ref $ClassStruct)` at the Wasm level. The IR
// represents them via `IrType.class` carrying the full `IrClassShape`, and
// `IrInstrClass*` ops symbolically reference the class through `shape`.
// The lowerer's `resolveClass` maps `shape.className` → struct typeIdx +
// constructor / method funcIdx + per-field index, all of which were
// allocated by the legacy `collectClassDeclaration` pass before the IR
// runs.
//
// Slice 4 keeps class methods themselves on the legacy path. The IR only
// claims OUTER functions that USE class instances — `class.call` resolves
// to a direct `call $<className>_<methodName>` against the legacy-compiled
// method body, with `this` prepended as the first argument.

/**
 * Construct a class instance via the legacy-registered constructor.
 *
 * Lowering:
 *   <emit each arg in order>
 *   call $<className>_new
 *
 * Result type: `{ kind: "class"; shape }`. The Wasm-level value type is
 * `(ref $ClassStruct)` (non-null) — `<className>_new` is registered with
 * a non-null ref result by `collectClassDeclaration`.
 */
export interface IrInstrClassNew extends IrInstrBase {
  readonly kind: "class.new";
  readonly shape: IrClassShape;
  readonly args: readonly IrValueId[];
}

/**
 * Read a named field from a class instance. `value` must be `IrType.class`
 * with a shape containing `fieldName`. Lowering emits:
 *   <emit value>
 *   struct.get $<className> <wasmFieldIdx>
 *
 * The wasm field index accounts for the legacy `__tag` prefix at field 0
 * — see `IrLowerResolver.resolveClass`.
 *
 * Result type: the field's IrType (also placed in `resultType`).
 */
export interface IrInstrClassGet extends IrInstrBase {
  readonly kind: "class.get";
  readonly value: IrValueId;
  readonly fieldName: string;
}

/**
 * Write a named field on a class instance. Void result. Lowering emits:
 *   <emit value>
 *   <emit newValue>
 *   struct.set $<className> <wasmFieldIdx>
 *
 * The legacy `collectClassDeclaration` pass widens all class fields to
 * `mutable: true`, so `struct.set` is always valid.
 */
export interface IrInstrClassSet extends IrInstrBase {
  readonly kind: "class.set";
  readonly value: IrValueId;
  readonly fieldName: string;
  readonly newValue: IrValueId;
}

/**
 * Invoke an instance method. `receiver` must be `IrType.class` whose
 * shape contains `methodName`. The implicit `this` is prepended as the
 * first call argument. Lowering emits:
 *   <emit receiver>
 *   <emit each arg in order>
 *   call $<className>_<methodName>
 *
 * Result type: the method descriptor's `returnType`. A void method has
 * `result: null` and `resultType: null`; the AST→IR lowerer rejects
 * such calls in expression position so we never see a void method as
 * `lowerExpr` output.
 */
export interface IrInstrClassCall extends IrInstrBase {
  readonly kind: "class.call";
  readonly receiver: IrValueId;
  readonly methodName: string;
  readonly args: readonly IrValueId[];
}

// ---------------------------------------------------------------------------
// Slot ops + for-of (#1169e — IR Phase 4 Slice 6)
// ---------------------------------------------------------------------------
//
// Slice 6 introduces the first STATEMENT-level loop to the IR. Before this
// slice the IR could only express tail-shaped programs (return / if-else
// terminating in return); for-of bodies in contrast have non-terminating
// statement sequences and need cross-iteration mutable state (the loop
// counter, the element binding, any outer-scope accumulator the body
// updates).
//
// To avoid adding general structured-CFG recovery to the lowerer (which
// today inlines `br` / `br_if` recursively without a Wasm `block` / `loop`
// concept), Slice 6 takes a HIGH-LEVEL approach: a single `forof.vec`
// instruction declaratively encodes the loop, and the lowerer emits a
// known-good Wasm pattern directly. The body's IR instrs are still real
// IR (so the optimisation passes can rewrite them) but mutable
// cross-iteration state lives in WASM-LOCAL slots accessed via
// `slot.read` / `slot.write`.

/**
 * Read a Wasm-local slot. `index` is the function-level slot index assigned
 * at IR build time (allocated via `IrFunctionBuilder.declareSlot`). The slot's
 * declared type must be a primitive ValType; the result IrType is `irVal`
 * of that ValType.
 *
 * Lowering: `local.get <slotIndex>`.
 */
export interface IrInstrSlotRead extends IrInstrBase {
  readonly kind: "slot.read";
  readonly slotIndex: number;
}

/**
 * Write a value to a Wasm-local slot. The value's IrType must be `val` with
 * a ValType matching the slot's declared type. Void result.
 *
 * Lowering: `<emit value>; local.set <slotIndex>`.
 */
export interface IrInstrSlotWrite extends IrInstrBase {
  readonly kind: "slot.write";
  readonly slotIndex: number;
  readonly value: IrValueId;
}

/**
 * Read `vec.length` (i32) from a vec struct. The vec must have an IrType
 * that the lowerer's resolver recognises as a vec (typeIdx with a layout of
 * `{ length: i32, data: (ref $arr) }`). Result is f64 (matching JS Number
 * semantics — same approach as `string.len`); lowering inserts the
 * `f64.convert_i32_s` after the i32 read.
 */
export interface IrInstrVecLen extends IrInstrBase {
  readonly kind: "vec.len";
  readonly vec: IrValueId;
}

/**
 * Index into a vec struct's data array. `index` must be an SSA value of
 * IrType `irVal({ kind: "i32" })` (f64-to-i32 conversion happens at the
 * caller — for-of always uses an i32 counter so this is always already i32).
 *
 * `resultType` carries the vec element's IrType (the lowerer matches it
 * against the vec struct's data array's element type).
 *
 * Lowering: `<emit vec>; struct.get $vec data; <emit index>; array.get $arr`.
 */
export interface IrInstrVecGet extends IrInstrBase {
  readonly kind: "vec.get";
  readonly vec: IrValueId;
  readonly index: IrValueId;
}

/**
 * Statement-level `for (const <bind> of <vec>) <body>` loop instruction.
 *
 * Encodes the array fast path declaratively. The lowerer emits:
 *   <emit vec>
 *   local.set <vecSlot>
 *   local.get <vecSlot>
 *   struct.get $vec data
 *   local.set <dataSlot>
 *   local.get <vecSlot>
 *   struct.get $vec length
 *   local.set <lenSlot>
 *   i32.const 0
 *   local.set <counterSlot>
 *   block
 *     loop
 *       local.get <counterSlot>
 *       local.get <lenSlot>
 *       i32.ge_s
 *       br_if 1                  ;; exit loop
 *       local.get <dataSlot>
 *       local.get <counterSlot>
 *       array.get $arr
 *       local.set <elementSlot>
 *       <body instrs>
 *       local.get <counterSlot>
 *       i32.const 1
 *       i32.add
 *       local.set <counterSlot>
 *       br 0                     ;; continue
 *     end
 *   end
 *
 * The vec must have a non-null ref type pointing to a registered vec struct
 * (the resolver's `resolveVec` resolves it to typeIdx + length/data field
 * indices + element array typeIdx + element ValType). Nullable vec types
 * are not in slice 6 — the selector keeps them on the legacy path.
 *
 * Slot indices are pre-allocated via `IrFunctionBuilder.declareSlot` before
 * the from-ast layer emits this instr.
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForOfVec extends IrInstrBase {
  readonly kind: "forof.vec";
  /** SSA value of the iterable. Lowered as the vec ref. */
  readonly vec: IrValueId;
  /** Element type — must match the vec's data array's element ValType. */
  readonly elementType: IrType;
  /** Pre-allocated slot indices (Wasm local indices) for the loop's state. */
  readonly counterSlot: number;
  readonly lengthSlot: number;
  readonly vecSlot: number;
  readonly dataSlot: number;
  readonly elementSlot: number;
  /** Body instrs emitted inside the loop. */
  readonly body: readonly IrInstr[];
}

// ---------------------------------------------------------------------------
// Coercion + iterator protocol (#1182 — IR Phase 4 Slice 6 part 3)
// ---------------------------------------------------------------------------
//
// Slice 6 part 3 widens the for-of bridge to the host iterator protocol
// — `for (const x of <set>)`, `for (const x of <map>)`, generators, and
// any other JS iterable that responds to `Symbol.iterator`. A new
// declarative `forof.iter` instr (parallel to `forof.vec`) carries the
// loop's state slots and body buffer; the lowerer emits the
// `block { loop { ... } }` Wasm pattern with calls to the existing
// `__iterator` / `__iterator_next` / `__iterator_done` /
// `__iterator_value` / `__iterator_return` host imports (registered
// lazily by `addIteratorImports`).
//
// The granular `iter.*` instrs (iter.new / iter.next / iter.done /
// iter.value / iter.return) are part of the IR surface even though
// `forof.iter` doesn't decompose into them at the body-buffer level.
// Future passes that want to reason about iterator manipulation
// outside a for-of loop (e.g., a generator's next() inlined into a
// caller, or async-iter in slice 7) can produce these directly.

/**
 * Coerce a reference-typed IR value to externref. Used by the iterator-
 * protocol arm of `lowerForOfStatement` to feed an arbitrary iterable
 * into the externref-typed `__iterator` host import.
 *
 * The input value must have a reference IrType (val/ref, val/ref_null,
 * val/externref, object, class, closure, or string). Numeric values
 * (i32, f64, etc.) cannot be coerced — the from-ast layer rejects them
 * upstream.
 *
 * Lowering:
 *   - val/externref input → no-op (input already externref)
 *   - any other ref input → `extern.convert_any` after pushing the value.
 *
 * Result type: `irVal({ kind: "externref" })`.
 */
export interface IrInstrCoerceToExternref extends IrInstrBase {
  readonly kind: "coerce.to_externref";
  readonly value: IrValueId;
}

/**
 * Slice 6 part 3 (#1182) — opaque iterator handle for the host iterator
 * protocol. Calls `__iterator(iterable)` to obtain the iterator object.
 *
 * Lowering:
 *   <emit iterable>           ;; pushes externref
 *   call $__iterator           ;; -> externref (the iterator)
 *
 * Result type: `irVal({ kind: "externref" })`.
 */
export interface IrInstrIterNew extends IrInstrBase {
  readonly kind: "iter.new";
  readonly iterable: IrValueId;
  /** True if this is a `for await` loop — calls `__async_iterator` instead. False for slice 6. */
  readonly async: boolean;
}

/**
 * Call iter.next() and return the result object handle (externref).
 * The result is later split into `done` / `value` via separate instrs
 * so the optimizer can decide whether to evaluate `value` (skip if done).
 *
 * Lowering: <emit iter>; call $__iterator_next  -> externref
 *
 * Result type: `irVal({ kind: "externref" })`. Side-effecting (advances
 * the iterator) — DCE must not eliminate it.
 */
export interface IrInstrIterNext extends IrInstrBase {
  readonly kind: "iter.next";
  readonly iter: IrValueId;
}

/**
 * Test whether an iterator-result object's `.done` is true.
 *
 * Lowering: <emit resultObj>; call $__iterator_done -> i32
 *
 * Result type: `irVal({ kind: "i32" })`. The operand field is named
 * `resultObj` (not `result`) to avoid colliding with the SSA-def
 * `result` field inherited from `IrInstrBase`.
 */
export interface IrInstrIterDone extends IrInstrBase {
  readonly kind: "iter.done";
  readonly resultObj: IrValueId;
}

/**
 * Read the `.value` slot of an iterator-result object.
 *
 * Lowering: <emit resultObj>; call $__iterator_value -> externref
 *
 * Result type: `irVal({ kind: "externref" })`. See `IrInstrIterDone`
 * for the `resultObj` naming rationale.
 */
export interface IrInstrIterValue extends IrInstrBase {
  readonly kind: "iter.value";
  readonly resultObj: IrValueId;
}

/**
 * Call `iter.return()` if defined. Used by the iterator-close try/finally
 * so abrupt exits notify the iterator (slice 6 step E, deferred to a
 * try/finally-aware follow-up).
 *
 * Lowering: <emit iter>; call $__iterator_return
 *
 * Result type: void (`result: null`). Side-effecting.
 */
export interface IrInstrIterReturn extends IrInstrBase {
  readonly kind: "iter.return";
  readonly iter: IrValueId;
}

/**
 * Statement-level `for (const <bind> of <iterable>) <body>` loop using
 * the host iterator protocol. The lowerer emits:
 *
 *   <emit iterable>
 *   call $__iterator
 *   local.set <iterSlot>
 *   block
 *     loop
 *       local.get <iterSlot>
 *       call $__iterator_next
 *       local.tee <resultSlot>
 *       call $__iterator_done
 *       br_if 1                  ;; exit loop on done=true
 *       local.get <resultSlot>
 *       call $__iterator_value
 *       local.set <elementSlot>
 *       <body instrs>
 *       br 0                     ;; continue
 *     end
 *   end
 *   local.get <iterSlot>
 *   call $__iterator_return       ;; normal-exit close
 *
 * The iterable must be an IR value of externref type (the from-ast
 * layer inserts a `coerce.to_externref` if the source value isn't
 * already externref). Slot indices are pre-allocated via
 * `IrFunctionBuilder.declareSlot`.
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForOfIter extends IrInstrBase {
  readonly kind: "forof.iter";
  /** SSA value of the iterable as externref (caller pre-coerces). */
  readonly iterable: IrValueId;
  /** Pre-allocated externref slot for the iterator handle. */
  readonly iterSlot: number;
  /** Pre-allocated externref slot for the iterator-result object. */
  readonly resultSlot: number;
  /** Pre-allocated externref slot for the current element value. */
  readonly elementSlot: number;
  /** Body instrs emitted inside the loop. */
  readonly body: readonly IrInstr[];
}

// ---------------------------------------------------------------------------
// String for-of (#1183 — IR Phase 4 Slice 6 part 4)
// ---------------------------------------------------------------------------
//
// Slice 6 part 4 adds the string fast path. When `iterableType.kind ===
// "string"` and the compiler is in native-strings mode, the for-of loop
// iterates code units via `__str_charAt(str, i)` — a counter loop with
// a `(ref $AnyString, i32) -> (ref $AnyString)` host helper. In host-
// strings mode the dispatch falls through to `forof.iter` (#1182).
//
// `forof.string` is a STATEMENT-level declarative instr that mirrors
// `forof.vec` and `forof.iter`. Carries the string SSA value, the four
// slot indices (counter / length / str / element), and the body buffer.

/**
 * Statement-level `for (const c of <string>) <body>` loop using the
 * native-strings counter pattern. Emitted only when the resolver
 * reports `nativeStrings(): true` — host-strings mode falls through
 * to `forof.iter` upstream in `lowerForOfStatement`.
 *
 * The lowerer emits:
 *   <emit str>
 *   local.set <strSlot>
 *   local.get <strSlot>
 *   struct.get $AnyString $len
 *   local.set <lengthSlot>
 *   i32.const 0
 *   local.set <counterSlot>
 *   block
 *     loop
 *       local.get <counterSlot>
 *       local.get <lengthSlot>
 *       i32.ge_s
 *       br_if 1
 *       local.get <strSlot>
 *       local.get <counterSlot>
 *       call $__str_charAt
 *       local.set <elementSlot>
 *       <body instrs>
 *       local.get <counterSlot>
 *       i32.const 1
 *       i32.add
 *       local.set <counterSlot>
 *       br 0
 *     end
 *   end
 *
 * Slot types (set by from-ast):
 *   counterSlot — i32
 *   lengthSlot  — i32
 *   strSlot     — `(ref $AnyString)` (resolver.resolveString())
 *   elementSlot — `(ref $AnyString)` — each iteration produces a
 *                 single-char string
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForOfString extends IrInstrBase {
  readonly kind: "forof.string";
  /** SSA value of the string (IrType.string). */
  readonly str: IrValueId;
  readonly counterSlot: number;
  readonly lengthSlot: number;
  readonly strSlot: number;
  readonly elementSlot: number;
  /** Body instrs emitted inside the loop. */
  readonly body: readonly IrInstr[];
}

export type IrInstr =
  | IrInstrConst
  | IrInstrCall
  | IrInstrGlobalGet
  | IrInstrGlobalSet
  | IrInstrBinary
  | IrInstrUnary
  | IrInstrSelect
  | IrInstrRawWasm
  | IrInstrBox
  | IrInstrUnbox
  | IrInstrTagTest
  | IrInstrStringConst
  | IrInstrStringConcat
  | IrInstrStringEq
  | IrInstrStringLen
  | IrInstrObjectNew
  | IrInstrObjectGet
  | IrInstrObjectSet
  | IrInstrClosureNew
  | IrInstrClosureCap
  | IrInstrClosureCall
  | IrInstrRefCellNew
  | IrInstrRefCellGet
  | IrInstrRefCellSet
  | IrInstrClassNew
  | IrInstrClassGet
  | IrInstrClassSet
  | IrInstrClassCall
  | IrInstrSlotRead
  | IrInstrSlotWrite
  | IrInstrVecLen
  | IrInstrVecGet
  | IrInstrForOfVec
  | IrInstrCoerceToExternref
  | IrInstrIterNew
  | IrInstrIterNext
  | IrInstrIterDone
  | IrInstrIterValue
  | IrInstrIterReturn
  | IrInstrForOfIter
  | IrInstrForOfString;

// ---------------------------------------------------------------------------
// Slot definitions (#1169e — IR Phase 4 Slice 6)
// ---------------------------------------------------------------------------

/**
 * Slice 6 (#1169e) — declaration of one Wasm-local slot used for cross-
 * iteration mutable state. Slots are allocated by the IR builder and
 * surface in the lowered Wasm function as additional locals appended
 * after the params and the SSA-driven locals.
 *
 *   - `index`        stable slot index, used by `slot.read` / `slot.write`.
 *                    NOT a Wasm local index — the lowerer translates slot
 *                    index N to Wasm local index `params + ssaLocals + N`.
 *   - `name`         debug name for the local.
 *   - `type`         primitive ValType (i32 / f64 / etc.) — slots only
 *                    carry primitives; reference-typed cross-iteration
 *                    state is rare in slice-6 loop bodies.
 */
export interface IrSlotDef {
  readonly index: number;
  readonly name: string;
  readonly type: ValType;
}

// ---------------------------------------------------------------------------
// Terminators
// ---------------------------------------------------------------------------
//
// Every basic block ends with exactly one terminator. Block args replace phi
// nodes: `br target(a, b)` passes SSA values into the target's block-arg slots.

export interface IrBranch {
  readonly target: IrBlockId;
  readonly args: readonly IrValueId[];
}

export type IrBlockId = number & { readonly __brand: "IrBlockId" };

export function asBlockId(n: number): IrBlockId {
  return n as IrBlockId;
}

export interface IrTerminatorReturn {
  readonly kind: "return";
  readonly values: readonly IrValueId[];
  readonly site?: IrSiteId;
}

export interface IrTerminatorBr {
  readonly kind: "br";
  readonly branch: IrBranch;
  readonly site?: IrSiteId;
}

export interface IrTerminatorBrIf {
  readonly kind: "br_if";
  readonly condition: IrValueId;
  readonly ifTrue: IrBranch;
  readonly ifFalse: IrBranch;
  readonly site?: IrSiteId;
}

export interface IrTerminatorUnreachable {
  readonly kind: "unreachable";
  readonly site?: IrSiteId;
}

export type IrTerminator = IrTerminatorReturn | IrTerminatorBr | IrTerminatorBrIf | IrTerminatorUnreachable;

// ---------------------------------------------------------------------------
// Basic blocks
// ---------------------------------------------------------------------------

export interface IrBlock {
  readonly id: IrBlockId;
  /** SSA values bound on entry (replace phi nodes). Types are parallel to `blockArgTypes`. */
  readonly blockArgs: readonly IrValueId[];
  readonly blockArgTypes: readonly IrType[];
  readonly instrs: readonly IrInstr[];
  readonly terminator: IrTerminator;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export interface IrParam {
  readonly value: IrValueId;
  readonly type: IrType;
  readonly name: string;
}

export interface IrFunction {
  readonly name: string;
  readonly params: readonly IrParam[];
  readonly resultTypes: readonly IrType[];
  /** Entry block is always `blocks[0]`. */
  readonly blocks: readonly IrBlock[];
  readonly exported: boolean;
  /** Highest IrValueId allocated + 1 (useful for re-entering the builder). */
  readonly valueCount: number;
  /**
   * Slice 3 (#1169c): for closure-lifted bodies only, identifies the
   * subtype struct that captures live on. Set by `liftClosureBody` in
   * `from-ast.ts`. The lowerer reads this when emitting `closure.cap`
   * to compute the correct ref.cast target. Absent for nested function
   * declarations (which don't take a __self param) and for outer
   * functions.
   */
  readonly closureSubtype?: {
    readonly signature: IrClosureSignature;
    readonly captureFieldTypes: readonly IrType[];
  };
  /**
   * Slice 6 (#1169e): Wasm-local slots used for cross-iteration mutable
   * state in for-of loops. Empty for functions that don't contain a
   * for-of (or any other slot user). Slot indices are stable; the
   * lowerer maps slot index N to Wasm local index
   *   `params.length + ssaLocalCount + N`
   * — i.e. slots come AFTER the SSA-driven locals.
   */
  readonly slots?: readonly IrSlotDef[];
}

// ---------------------------------------------------------------------------
// Module — collection of IR functions visible simultaneously
// ---------------------------------------------------------------------------
//
// Module-scope passes (e.g. `inlineSmall` in Phase 3b — #1167b) need to see
// every IR-path function at once. The AST→IR lowerer emits per-function, so
// `integration.ts` accumulates the per-function results into an `IrModule`
// container between the build phase and the lower phase.
//
// The container holds only functions for now. Globals/types/imports remain
// resolved lazily via the symbolic-ref mechanism.

export interface IrModule {
  readonly functions: readonly IrFunction[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isIrFuncRef(x: unknown): x is IrFuncRef {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "func";
}

export function isIrGlobalRef(x: unknown): x is IrGlobalRef {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "global";
}

export function isIrTypeRef(x: unknown): x is IrTypeRef {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "type";
}
