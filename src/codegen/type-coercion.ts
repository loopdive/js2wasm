/**
 * Type coercion utilities for Wasm codegen.
 *
 * Extracted from expressions.ts to keep concerns separated.
 * Contains: coerceType, pushDefaultValue, defaultValueInstrs, coercionInstrs.
 */

import type { CodegenContext, FunctionContext, ClosureInfo } from "./index.js";
import { allocLocal, allocTempLocal, releaseTempLocal, addUnionImports, addStringConstantGlobal, isAnyValue, ensureAnyHelpers } from "./index.js";
import { registerCoerceType } from "./shared.js";
import type { Instr, ValType, StructTypeDef, ArrayTypeDef } from "../ir/types.js";

/**
 * Emit a guarded ref.cast: use ref.test to check if the cast will succeed.
 * If it fails, push ref.null instead of trapping with "illegal cast".
 * The value on the stack should be an anyref (from any.convert_extern).
 * The result is always ref_null $typeIdx (nullable) to accommodate the null fallback.
 *
 * Usage: push externref, call any.convert_extern, then call this function.
 */
export function emitGuardedRefCast(
  fctx: FunctionContext,
  typeIdx: number,
): void {
  const tmpLocal = allocTempLocal(fctx, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.tee", index: tmpLocal });
  fctx.body.push({ op: "ref.test", typeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx } as ValType },
    then: [
      { op: "local.get", index: tmpLocal },
      { op: "ref.cast_null", typeIdx },
    ],
    else: [
      { op: "ref.null", typeIdx },
    ],
  });
  releaseTempLocal(fctx, tmpLocal);
}

/**
 * Callback type for compiling a string literal onto the Wasm stack.
 * Used by coerceType when it needs to push a @@toPrimitive hint string.
 * The caller (expressions.ts) passes its local compileStringLiteral function.
 */
export type CompileStringLiteralFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
) => void;

/**
 * Check if a type index corresponds to a vec struct (__vec_*) and return its
 * array type index and element type if so.
 */
function getVecInfo(
  ctx: CodegenContext,
  typeIdx: number,
): { arrTypeIdx: number; elemType: ValType } | null {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return null;
  const sd = typeDef as StructTypeDef;
  if (!sd.name?.startsWith("__vec_")) return null;
  // Vec struct: field 0 = $length (i32), field 1 = $data (ref $arr)
  if (sd.fields.length < 2) return null;
  const dataField = sd.fields[1]!;
  if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
  const arrTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { arrTypeIdx, elemType: (arrDef as ArrayTypeDef).element };
}

/**
 * Check if a type index corresponds to a tuple struct (__tuple_*) and return
 * its field types if so.
 */
function getTupleFields(
  ctx: CodegenContext,
  typeIdx: number,
): ValType[] | null {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return null;
  const sd = typeDef as StructTypeDef;
  if (!sd.name?.startsWith("__tuple_")) return null;
  return sd.fields.map(f => f.type);
}

/**
 * Emit instructions to convert a vec struct on the stack to a tuple struct,
 * or between two different vec types (e.g. vec_externref -> vec_f64).
 * Returns true if conversion was emitted, false if the types don't match.
 *
 * Vec layout:  struct { $length: i32, $data: ref $arr }
 * Tuple layout: struct { $_0: T0, $_1: T1, ... }
 */
/**
 * Check if the source and destination are both named struct types (__anon_*)
 * where the destination fields are a subset of the source fields. If so, emit
 * field-by-field extraction to construct the narrower struct.
 */
function getStructNarrowInfo(
  ctx: CodegenContext,
  fromTypeIdx: number,
  toTypeIdx: number,
): { srcFields: { name: string; type: ValType; fieldIdx: number }[]; dstFields: { name: string; type: ValType }[] } | null {
  const fromDef = ctx.mod.types[fromTypeIdx];
  const toDef = ctx.mod.types[toTypeIdx];
  if (!fromDef || fromDef.kind !== "struct") return null;
  if (!toDef || toDef.kind !== "struct") return null;
  const srcStruct = fromDef as StructTypeDef;
  const dstStruct = toDef as StructTypeDef;

  // Build field name -> index map for source struct
  const srcFieldMap = new Map<string, { type: ValType; fieldIdx: number }>();
  for (let i = 0; i < srcStruct.fields.length; i++) {
    srcFieldMap.set(srcStruct.fields[i]!.name, { type: srcStruct.fields[i]!.type, fieldIdx: i });
  }

  // Check if all destination fields exist in the source
  const srcFields: { name: string; type: ValType; fieldIdx: number }[] = [];
  for (const field of dstStruct.fields) {
    const srcField = srcFieldMap.get(field.name);
    if (!srcField) return null; // field not found in source
    srcFields.push({ name: field.name, type: srcField.type, fieldIdx: srcField.fieldIdx });
  }

  return {
    srcFields,
    dstFields: dstStruct.fields.map(f => ({ name: f.name, type: f.type })),
  };
}

function emitSafeStructConversion(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
): boolean {
  // Case 1: vec -> tuple
  const srcVec = getVecInfo(ctx, fromTypeIdx);
  if (srcVec) {
    const tupleFields = getTupleFields(ctx, toTypeIdx);
    if (tupleFields) {
      return emitVecToTupleBody(ctx, fctx, fromTypeIdx, toTypeIdx, srcVec, tupleFields);
    }

    // Case 2: vec -> vec (different element types)
    const dstVec = getVecInfo(ctx, toTypeIdx);
    if (dstVec && srcVec.elemType.kind !== dstVec.elemType.kind) {
      return emitVecToVecBody(ctx, fctx, fromTypeIdx, toTypeIdx, srcVec, dstVec);
    }
    // Also handle vec -> vec where both are ref but different typeIdx
    if (dstVec && (srcVec.elemType.kind === "ref" || srcVec.elemType.kind === "ref_null") &&
        (dstVec.elemType.kind === "ref" || dstVec.elemType.kind === "ref_null")) {
      const srcRefIdx = (srcVec.elemType as { typeIdx: number }).typeIdx;
      const dstRefIdx = (dstVec.elemType as { typeIdx: number }).typeIdx;
      if (srcRefIdx !== dstRefIdx) {
        return emitVecToVecBody(ctx, fctx, fromTypeIdx, toTypeIdx, srcVec, dstVec);
      }
    }
  }

  // Case 3: struct narrowing — destination fields are a subset of source fields
  const narrowInfo = getStructNarrowInfo(ctx, fromTypeIdx, toTypeIdx);
  if (narrowInfo) {
    return emitStructNarrowBody(ctx, fctx, fromTypeIdx, toTypeIdx, narrowInfo);
  }

  return false;
}

/** Emit vec -> tuple conversion body */
function emitVecToTupleBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  srcVec: { arrTypeIdx: number; elemType: ValType },
  tupleFields: ValType[],
): boolean {
  const { arrTypeIdx, elemType } = srcVec;

  // Save the vec ref to a temp local (must be ref_null since locals need a default value)
  const vecRefType: ValType = { kind: "ref_null", typeIdx: fromTypeIdx };
  const tmpLocal = allocTempLocal(fctx, vecRefType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Save the data array and length for bounds checking
  const dataLocal = allocTempLocal(fctx, { kind: "ref_null", typeIdx: arrTypeIdx } as ValType);
  const lenLocal = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // For each tuple field, read from the vec's data array with bounds check and coerce
  for (let i = 0; i < tupleFields.length; i++) {
    const fieldType = tupleFields[i]!;

    // Bounds-checked read: if i < len, read data[i]; else push default
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "i32.lt_u" } as Instr);

    const thenInstrs: Instr[] = [
      { op: "local.get", index: dataLocal } as Instr,
      { op: "i32.const", value: i } as Instr,
      { op: "array.get", typeIdx: arrTypeIdx } as Instr,
    ];
    const elseInstrs: Instr[] = defaultValueInstrs(elemType);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: elemType },
      then: thenInstrs,
      else: elseInstrs,
    } as Instr);

    // Coerce the vec element type to the tuple field type if needed
    if (elemType.kind !== fieldType.kind) {
      coerceType(ctx, fctx, elemType, fieldType);
    } else if ((elemType.kind === "ref" || elemType.kind === "ref_null") &&
               (fieldType.kind === "ref" || fieldType.kind === "ref_null")) {
      const fromRefIdx = (elemType as { typeIdx: number }).typeIdx;
      const toRefIdx = (fieldType as { typeIdx: number }).typeIdx;
      if (fromRefIdx !== toRefIdx) {
        coerceType(ctx, fctx, elemType, fieldType);
      }
    }
  }

  releaseTempLocal(fctx, lenLocal);
  releaseTempLocal(fctx, dataLocal);

  // Construct the tuple struct
  fctx.body.push({ op: "struct.new", typeIdx: toTypeIdx });

  releaseTempLocal(fctx, tmpLocal);
  return true;
}

/** Emit vec -> vec conversion body (element-by-element with coercion) */
function emitVecToVecBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  srcVec: { arrTypeIdx: number; elemType: ValType },
  dstVec: { arrTypeIdx: number; elemType: ValType },
): boolean {
  // Save the source vec ref to a temp local
  const srcRefType: ValType = { kind: "ref_null", typeIdx: fromTypeIdx };
  const srcLocal = allocTempLocal(fctx, srcRefType);
  fctx.body.push({ op: "local.set", index: srcLocal });

  // Get the length from the source vec
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 0 }); // length (i32)

  // Allocate a temp for the length
  const lenLocal = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: lenLocal });

  // Create the destination array: array.new_default $dstArr length
  fctx.body.push({ op: "array.new_default", typeIdx: dstVec.arrTypeIdx });

  // Save the new array to a temp local
  const dstArrRefType: ValType = { kind: "ref_null", typeIdx: dstVec.arrTypeIdx };
  const dstArrLocal = allocTempLocal(fctx, dstArrRefType);
  fctx.body.push({ op: "local.set", index: dstArrLocal });

  // Loop: copy elements with coercion using nested block/loop structure.
  // We capture the loop body by recording the fctx.body position before and after
  // emitting, then splicing the instructions into a nested block/loop. This avoids
  // swapping fctx.body which would break addUnionImports index shifting.
  const iLocal = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  const loopBodyStart = fctx.body.length;

  // if (i >= len) break out of block (depth 1 from loop body)
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_u" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // dstArr[i] = coerce(srcArr[i])
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  // Read source element
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "array.get", typeIdx: srcVec.arrTypeIdx });
  // Coerce element type
  if (srcVec.elemType.kind !== dstVec.elemType.kind) {
    coerceType(ctx, fctx, srcVec.elemType, dstVec.elemType);
  }
  // Write to destination
  fctx.body.push({ op: "array.set", typeIdx: dstVec.arrTypeIdx });

  // i++
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  // continue loop (depth 0 = innermost = loop)
  fctx.body.push({ op: "br", depth: 0 });

  // Splice the emitted loop body into a nested block/loop structure
  const loopBody = fctx.body.splice(loopBodyStart);
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Construct the destination vec struct: { length, dstArr }
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: toTypeIdx });

  releaseTempLocal(fctx, iLocal);
  releaseTempLocal(fctx, dstArrLocal);
  releaseTempLocal(fctx, lenLocal);
  releaseTempLocal(fctx, srcLocal);
  return true;
}

/** Emit struct narrowing: extract a subset of fields from a larger struct */
function emitStructNarrowBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  info: { srcFields: { name: string; type: ValType; fieldIdx: number }[]; dstFields: { name: string; type: ValType }[] },
): boolean {
  // Save the source struct ref to a temp local
  const srcRefType: ValType = { kind: "ref_null", typeIdx: fromTypeIdx };
  const tmpLocal = allocTempLocal(fctx, srcRefType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // For each destination field, get the corresponding source field
  for (let i = 0; i < info.dstFields.length; i++) {
    const srcField = info.srcFields[i]!;
    const dstField = info.dstFields[i]!;

    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: srcField.fieldIdx });

    // Coerce if types differ
    if (srcField.type.kind !== dstField.type.kind) {
      coerceType(ctx, fctx, srcField.type, dstField.type);
    } else if ((srcField.type.kind === "ref" || srcField.type.kind === "ref_null") &&
               (dstField.type.kind === "ref" || dstField.type.kind === "ref_null")) {
      const fromRefIdx = (srcField.type as { typeIdx: number }).typeIdx;
      const toRefIdx = (dstField.type as { typeIdx: number }).typeIdx;
      if (fromRefIdx !== toRefIdx) {
        coerceType(ctx, fctx, srcField.type, dstField.type);
      }
    }
  }

  // Construct the destination struct
  fctx.body.push({ op: "struct.new", typeIdx: toTypeIdx });

  releaseTempLocal(fctx, tmpLocal);
  return true;
}

/**
 * Coerce a Wasm value on the stack from one type to another.
 *
 * @param compileStringLiteralFn Optional callback for emitting string literals
 *   (needed for @@toPrimitive hint arguments). If not provided, toPrimitive
 *   paths that require a hint string will fall through to the default path.
 */
export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  compileStringLiteralFn?: CompileStringLiteralFn,
): void {
  if (from.kind === to.kind) {
    // Same kind but check if ref typeIdx differs (e.g. ref $AnyValue vs ref $SomeStruct)
    if ((from.kind === "ref" || from.kind === "ref_null") &&
        (to.kind === "ref" || to.kind === "ref_null")) {
      const fromIdx = (from as { typeIdx: number }).typeIdx;
      const toIdx = (to as { typeIdx: number }).typeIdx;
      if (fromIdx === toIdx) return;
      // Boxing: non-any ref → any ref
      if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
        ensureAnyHelpers(ctx);
        const funcIdx = ctx.funcMap.get("__any_box_ref");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return;
        }
      }
      // Unboxing: any ref → non-any ref (extract refval and cast)
      if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
        ensureAnyHelpers(ctx);
        // Get the refval field (eqref), then guarded ref.cast to target type
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
        // Guard: ref.test before ref.cast to avoid illegal cast traps
        const tmpEq = allocTempLocal(fctx, { kind: "eqref" } as ValType);
        fctx.body.push({ op: "local.tee", index: tmpEq });
        fctx.body.push({ op: "ref.test", typeIdx: toIdx });
        if (to.kind === "ref_null") {
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: to },
            then: [
              { op: "local.get", index: tmpEq },
              { op: "ref.cast_null", typeIdx: toIdx },
            ],
            else: [
              { op: "ref.null", typeIdx: toIdx },
            ],
          });
        } else {
          // Non-null target: cast if test passes, otherwise unreachable (type error)
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
            then: [
              { op: "local.get", index: tmpEq },
              { op: "ref.cast_null", typeIdx: toIdx },
            ],
            else: [
              { op: "ref.null", typeIdx: toIdx },
            ],
          });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
        }
        releaseTempLocal(fctx, tmpEq);
        return;
      }
      // Different struct types, neither is AnyValue.
      // Check if this is a vec-to-tuple conversion (array passed to destructuring param).
      // Vec structs have layout: { $length: i32, $data: ref $arr }
      // Tuple structs have layout: { $_0: T0, $_1: T1, ... }
      // A blind ref.cast would trap since they are unrelated types.
      if (emitSafeStructConversion(ctx, fctx, fromIdx, toIdx)) {
        return;
      }
      // For related struct types (subtypes), use guarded ref.cast to avoid
      // illegal cast traps when runtime type differs from static type.
      {
        const guardFrom = from.kind === "ref_null" ? { kind: "anyref" } as ValType : { kind: "anyref" } as ValType;
        const tmpGuard = allocTempLocal(fctx, guardFrom);
        fctx.body.push({ op: "local.tee", index: tmpGuard });
        fctx.body.push({ op: "ref.test", typeIdx: toIdx });
        if (to.kind === "ref_null") {
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: to },
            then: [
              { op: "local.get", index: tmpGuard },
              { op: "ref.cast_null", typeIdx: toIdx },
            ],
            else: [
              { op: "ref.null", typeIdx: toIdx },
            ],
          });
        } else {
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
            then: [
              { op: "local.get", index: tmpGuard },
              { op: "ref.cast_null", typeIdx: toIdx },
            ],
            else: [
              { op: "ref.null", typeIdx: toIdx },
            ],
          });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
        }
        releaseTempLocal(fctx, tmpGuard);
      }
      return;
    }
    return;
  }
  // ref is a subtype of ref_null — no coercion needed for same typeIdx
  if (from.kind === "ref" && to.kind === "ref_null") {
    // But check for any-value boxing (ref $X → ref_null $AnyValue)
    if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_ref");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // ref $X is a subtype of ref_null $X for same typeIdx — no coercion needed.
    // For different typeIdx, cast to target type (handles subtypes/related structs).
    const fromRefIdx = (from as { typeIdx: number }).typeIdx;
    const toRefNullIdx = (to as { typeIdx: number }).typeIdx;
    if (fromRefIdx !== toRefNullIdx) {
      if (!emitSafeStructConversion(ctx, fctx, fromRefIdx, toRefNullIdx)) {
        // Guarded cast: ref $X → ref_null $Y — avoid illegal cast trap
        const tmpRefNull = allocTempLocal(fctx, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.tee", index: tmpRefNull });
        fctx.body.push({ op: "ref.test", typeIdx: toRefNullIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: to },
          then: [
            { op: "local.get", index: tmpRefNull },
            { op: "ref.cast_null", typeIdx: toRefNullIdx },
          ],
          else: [
            { op: "ref.null", typeIdx: toRefNullIdx },
          ],
        });
        releaseTempLocal(fctx, tmpRefNull);
      }
    }
    return;
  }
  if (from.kind === "ref_null" && to.kind === "ref") {
    // Unboxing: ref_null $AnyValue → ref $X
    if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
      ensureAnyHelpers(ctx);
      const toIdx = (to as { typeIdx: number }).typeIdx;
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
      // Guarded cast: eqref → ref $X
      const tmpUnbox = allocTempLocal(fctx, { kind: "eqref" } as ValType);
      fctx.body.push({ op: "local.tee", index: tmpUnbox });
      fctx.body.push({ op: "ref.test", typeIdx: toIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
        then: [
          { op: "local.get", index: tmpUnbox },
          { op: "ref.cast_null", typeIdx: toIdx },
        ],
        else: [
          { op: "ref.null", typeIdx: toIdx },
        ],
      });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      releaseTempLocal(fctx, tmpUnbox);
      return;
    }
    // ref_null $X → ref $Y: cast and assert non-null at runtime
    const fromNullIdx = (from as { typeIdx: number }).typeIdx;
    const toNonNullIdx = (to as { typeIdx: number }).typeIdx;
    if (fromNullIdx !== toNonNullIdx) {
      if (!emitSafeStructConversion(ctx, fctx, fromNullIdx, toNonNullIdx)) {
        // Guarded cast: ref_null $X → ref $Y
        const tmpCast = allocTempLocal(fctx, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.tee", index: tmpCast });
        fctx.body.push({ op: "ref.test", typeIdx: toNonNullIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toNonNullIdx } as ValType },
          then: [
            { op: "local.get", index: tmpCast },
            { op: "ref.cast_null", typeIdx: toNonNullIdx },
          ],
          else: [
            { op: "ref.null", typeIdx: toNonNullIdx },
          ],
        });
        releaseTempLocal(fctx, tmpCast);
      }
    }
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    return;
  }

  // ── Boxing: primitive → ref $AnyValue ──
  if (isAnyValue(to, ctx)) {
    ensureAnyHelpers(ctx);
    if (from.kind === "i32") {
      const funcIdx = ctx.funcMap.get("__any_box_i32");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (from.kind === "f64") {
      const funcIdx = ctx.funcMap.get("__any_box_f64");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (from.kind === "i64") {
      // i64 → AnyValue: convert to f64 first, then box as f64
      const funcIdx = ctx.funcMap.get("__any_box_f64");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "f64.convert_i64_s" });
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    if (from.kind === "externref") {
      const funcIdx = ctx.funcMap.get("__any_box_string");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (from.kind === "ref" || from.kind === "ref_null") {
      const funcIdx = ctx.funcMap.get("__any_box_ref");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
  }

  // ── Unboxing: ref $AnyValue → primitive ──
  if (isAnyValue(from, ctx)) {
    ensureAnyHelpers(ctx);
    if (to.kind === "i32") {
      const funcIdx = ctx.funcMap.get("__any_unbox_i32");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (to.kind === "f64") {
      // Inline AnyValue → f64 unboxing with correct handling for all tags.
      // The __any_unbox_f64 helper only handles tag 2 (i32) and falls back to
      // reading f64val for everything else, which is wrong for:
      //   tag 1 (undefined) → should be NaN, not 0.0
      //   tag 4 (boolean)   → should be f64(i32val), not 0.0
      const anyTypeIdx = ctx.anyValueTypeIdx;
      if (anyTypeIdx >= 0) {
        const tmpAny = allocTempLocal(fctx, from);
        const tmpTag = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: tmpAny });
        fctx.body.push({ op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 }); // tag
        fctx.body.push({ op: "local.set", index: tmpTag });

        // tag == 2 (i32 number) || tag == 4 (boolean) → f64.convert_i32_s(i32val)
        fctx.body.push({ op: "local.get", index: tmpTag });
        fctx.body.push({ op: "i32.const", value: 2 });
        fctx.body.push({ op: "i32.eq" });
        fctx.body.push({ op: "local.get", index: tmpTag });
        fctx.body.push({ op: "i32.const", value: 4 });
        fctx.body.push({ op: "i32.eq" });
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            { op: "local.get", index: tmpAny },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 }, // i32val
            { op: "f64.convert_i32_s" },
          ],
          else: [
            // tag == 1 (undefined) → NaN
            { op: "local.get", index: tmpTag },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [
                { op: "f64.const", value: NaN },
              ],
              else: [
                // default: f64val (covers tag 0/null=0, tag 3/f64, tag 5/string, tag 6/object)
                { op: "local.get", index: tmpAny },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 }, // f64val
              ],
            } as unknown as Instr,
          ],
        });
        releaseTempLocal(fctx, tmpTag);
        releaseTempLocal(fctx, tmpAny);
        return;
      }
      // Fallback to helper if anyTypeIdx not available
      const funcIdx = ctx.funcMap.get("__any_unbox_f64");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (to.kind === "i64") {
      // AnyValue → i64: unbox as f64 first, then truncate to i64
      const funcIdx = ctx.funcMap.get("__any_unbox_f64");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        return;
      }
    }
    if (to.kind === "externref") {
      // Convert GC ref (AnyValue struct) to externref via extern.convert_any
      fctx.body.push({ op: "extern.convert_any" });
      return;
    }
  }

  // i64 → f64 (Number(bigint))
  if (from.kind === "i64" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i64_s" });
    return;
  }
  // f64 → i64 (BigInt(number))
  if (from.kind === "f64" && to.kind === "i64") {
    fctx.body.push({ op: "i64.trunc_sat_f64_s" });
    return;
  }
  // i32 → i64
  if (from.kind === "i32" && to.kind === "i64") {
    fctx.body.push({ op: "i64.extend_i32_s" });
    return;
  }
  // i64 → i32
  if (from.kind === "i64" && to.kind === "i32") {
    // Truncate: check if non-zero (truthiness for conditions)
    fctx.body.push({ op: "i64.const", value: 0n });
    fctx.body.push({ op: "i64.ne" });
    return;
  }
  // i32 → f64
  if (from.kind === "i32" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  // f64 → i32
  if (from.kind === "f64" && to.kind === "i32") {
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    return;
  }
  // externref → i32 (unbox as number to preserve value, then truncate)
  if (from.kind === "externref" && to.kind === "i32") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      return;
    }
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
    return;
  }
  // externref → f64 (unbox number)
  if (from.kind === "externref" && to.kind === "f64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop and push default
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  // externref → i64 (unbox number then truncate to i64)
  if (from.kind === "externref" && to.kind === "i64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      return;
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i64.const", value: 0n });
    return;
  }
  // externref → ref/ref_null: convert externref back to anyref, then cast to target struct type.
  // Uses any.convert_extern + ref.cast (non-nullable) or ref.cast_null (nullable).
  if (from.kind === "externref" && (to.kind === "ref" || to.kind === "ref_null")) {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    // Guard with ref.test to avoid illegal cast traps.
    // Save the anyref to a local, test if it can be cast, and produce
    // null if the cast would fail (for ref_null targets) or trap gracefully.
    const tmpAnyLocal = allocTempLocal(fctx, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.tee", index: tmpAnyLocal });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    if (to.kind === "ref_null") {
      // If test passes: cast; otherwise: push null
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: to },
        then: [
          { op: "local.get", index: tmpAnyLocal },
          { op: "ref.cast_null", typeIdx: toIdx },
        ],
        else: [
          { op: "ref.null", typeIdx: toIdx },
        ],
      });
    } else {
      // Non-null target: if test fails, produce a null and ref.as_non_null will trap
      // with a clearer error than illegal cast
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
        then: [
          { op: "local.get", index: tmpAnyLocal },
          { op: "ref.cast_null", typeIdx: toIdx },
        ],
        else: [
          { op: "ref.null", typeIdx: toIdx },
        ],
      });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
    }
    releaseTempLocal(fctx, tmpAnyLocal);
    return;
  }
  // f64 → externref (box number)
  if (from.kind === "f64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop f64 and push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // i32 → externref (box as number to preserve value)
  if (from.kind === "i32" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop i32 and push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // i64 → externref (box as number: convert i64 → f64, then box)
  if (from.kind === "i64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop i64 and push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // ref/ref_null → externref: check @@toPrimitive("string") first, then toString(), else extern.convert_any
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    for (const [name, idx] of ctx.structMap) {
      if (idx === typeIdx) {
        // Check for [Symbol.toPrimitive] method first
        const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
        if (toPrimFuncIdx !== undefined) {
          // Call ClassName_@@toPrimitive(self, "string")
          addStringConstantGlobal(ctx, "string");
          if (compileStringLiteralFn) {
            compileStringLiteralFn(ctx, fctx, "string");
          }
          fctx.body.push({ op: "call", funcIdx: toPrimFuncIdx });
          // Coerce result to externref if needed
          const funcDefIdx = toPrimFuncIdx - ctx.numImportFuncs;
          const funcDef = funcDefIdx >= 0 ? ctx.mod.functions[funcDefIdx] : undefined;
          const funcType = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
          // Default to "externref" for imports (funcDefIdx < 0) which typically return externref
          const retKind = (funcType?.kind === "func" && funcType.results?.[0]?.kind) || "externref";
          if (retKind === "f64") {
            // Ensure __box_number is available via union imports
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_number")!;
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else if (retKind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            // Ensure __box_number is available via union imports
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_number")!;
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
          // externref/ref return → use extern.convert_any for ref types
          if (retKind === "ref" || retKind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          return;
        }
        const toStringFuncIdx = ctx.funcMap.get(`${name}_toString`);
        if (toStringFuncIdx !== undefined) {
          // Call ClassName_toString(self) — self is already on stack
          fctx.body.push({ op: "call", funcIdx: toStringFuncIdx });
          return;
        }
        break;
      }
    }
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }
  // ref/ref_null → eqref: no-op (GC struct refs are subtypes of eqref)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "eqref") {
    return;
  }
  // ref/ref_null → anyref: no-op (GC struct refs are subtypes of anyref)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "anyref") {
    return;
  }
  // externref → ref (non-nullable): convert to anyref then guarded cast
  if (from.kind === "externref" && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    // Guarded: ref.test before ref.cast to avoid illegal cast traps
    const tmpExtRef = allocTempLocal(fctx, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.tee", index: tmpExtRef });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
      then: [
        { op: "local.get", index: tmpExtRef },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: [
        { op: "ref.null", typeIdx: toIdx },
      ],
    });
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    releaseTempLocal(fctx, tmpExtRef);
    return;
  }
  // externref → ref_null: convert to anyref, then use if/else to handle null and type mismatch
  if (from.kind === "externref" && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    // Store in a temp local, check for null or type mismatch
    const tmpLocal = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    // Use ref.test to check both null and type compatibility (ref.test returns 0 for null)
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: tmpLocal } as Instr,
        { op: "ref.cast", typeIdx: toIdx } as Instr,
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    });
    releaseTempLocal(fctx, tmpLocal);
    return;
  }
  // eqref/anyref → ref: guarded cast to target struct type
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    // Guarded: ref.test before ref.cast to avoid illegal cast traps
    const tmpEqAny = allocTempLocal(fctx, from);
    fctx.body.push({ op: "local.tee", index: tmpEqAny });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
      then: [
        { op: "local.get", index: tmpEqAny },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: [
        { op: "ref.null", typeIdx: toIdx },
      ],
    });
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    releaseTempLocal(fctx, tmpEqAny);
    return;
  }
  // eqref/anyref → ref_null: null-safe and type-safe cast
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    const tmpLocal = allocTempLocal(fctx, from);
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    // Use ref.test to check both null and type compatibility (ref.test returns 0 for null)
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: tmpLocal } as Instr,
        { op: "ref.cast", typeIdx: toIdx } as Instr,
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    });
    releaseTempLocal(fctx, tmpLocal);
    return;
  }

  // anyref/eqref → externref: extern.convert_any
  if ((from.kind === "anyref" || from.kind === "eqref") && to.kind === "externref") {
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }
  // externref → anyref: any.convert_extern
  if (from.kind === "externref" && to.kind === "anyref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    return;
  }
  // externref → eqref: any.convert_extern (eqref is subtype of anyref)
  if (from.kind === "externref" && to.kind === "eqref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    return;
  }
  // Remaining → externref fallback (funcref, etc.): drop and push null
  if (to.kind === "externref") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // ref (struct) → f64: JS ToNumber semantics — check @@toPrimitive("number") first, then valueOf
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    for (const [name, idx] of ctx.structMap) {
      if (idx === typeIdx) {
        // Check for [Symbol.toPrimitive] method first — takes precedence over valueOf
        const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
        if (toPrimFuncIdx !== undefined) {
          // Call ClassName_@@toPrimitive(self, "number")
          addStringConstantGlobal(ctx, "number");
          if (compileStringLiteralFn) {
            compileStringLiteralFn(ctx, fctx, "number");
          }
          fctx.body.push({ op: "call", funcIdx: toPrimFuncIdx });
          // Coerce result to f64 if needed
          const funcDef = ctx.mod.functions[toPrimFuncIdx - ctx.numImportFuncs];
          const funcType = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
          const retKind = (funcType?.kind === "func" && funcType.results?.[0]?.kind) || "f64";
          if (retKind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
          } else if (retKind === "externref") {
            addUnionImports(ctx);
            const unboxIdx = ctx.funcMap.get("__unbox_number");
            if (unboxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: unboxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "f64.const", value: NaN });
            }
          }
          // f64 return → already correct type
          return;
        }
        const fields = ctx.structFields.get(name);
        if (!fields) { break; }
        const fieldIdx = fields.findIndex(f => f.name === "valueOf");
        if (fieldIdx < 0) {
          // No valueOf field — check for a class method valueOf (ClassName_valueOf)
          const valueOfFuncIdx = ctx.funcMap.get(`${name}_valueOf`);
          if (valueOfFuncIdx !== undefined) {
            // Call ClassName_valueOf(self) — self is already on stack
            fctx.body.push({ op: "call", funcIdx: valueOfFuncIdx });
            // Check return type — if not f64, convert to f64
            const voFuncDefIdx = valueOfFuncIdx - ctx.numImportFuncs;
            const voFuncDef = voFuncDefIdx >= 0 ? ctx.mod.functions[voFuncDefIdx] : undefined;
            const funcType = voFuncDef ? ctx.mod.types[voFuncDef.typeIdx] : undefined;
            if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            } else if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "externref") {
              // valueOf returned externref (e.g. WrapperString_valueOf returns a string)
              // Convert externref → f64 via __unbox_number or parseFloat
              addUnionImports(ctx);
              const unboxIdx = ctx.funcMap.get("__unbox_number");
              if (unboxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: unboxIdx });
              } else {
                const pfIdx = ctx.funcMap.get("parseFloat");
                if (pfIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: pfIdx });
                } else {
                  // Last resort: drop and push NaN
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "f64.const", value: NaN });
                }
              }
            }
            return;
          }
          // No valueOf — ToNumber({}) = NaN per spec
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        const valueOfField = fields[fieldIdx];
        if (!valueOfField) {
          // Field index valid from findIndex but entry missing — treat as NaN
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        if (valueOfField.type.kind === "ref" || valueOfField.type.kind === "ref_null") {
          // valueOf is a closure ref — call it via call_ref
          const closureTypeIdx = (valueOfField.type as { typeIdx: number }).typeIdx;
          // Find closure info by struct type index
          const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (closureInfo) {
            // Save struct ref to local, extract valueOf closure, call it
            const structLocal = allocLocal(fctx, `__coerce_struct_${fctx.locals.length}`, from);
            fctx.body.push({ op: "local.set", index: structLocal });
            // Get closure ref from struct
            fctx.body.push({ op: "local.get", index: structLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            const closureLocal = allocLocal(fctx, `__coerce_closure_${fctx.locals.length}`, valueOfField.type);
            fctx.body.push({ op: "local.tee", index: closureLocal });
            // Push closure ref as self param, then funcref from field 0
            // call_ref signature: [closure_ref, funcref] → results
            fctx.body.push({ op: "local.get", index: closureLocal });
            fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
            fctx.body.push({ op: "ref.as_non_null" });
            fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
            // If valueOf returns void/null, result is NaN; if f64, keep it
            if (!closureInfo.returnType || closureInfo.returnType.kind === "i32") {
              // void → push NaN (the call produced nothing or an i32)
              if (closureInfo.returnType?.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
              } else {
                fctx.body.push({ op: "f64.const", value: NaN });
              }
            }
            // f64 return → value is already on stack
            return;
          }
        }
        if (valueOfField.type.kind === "externref") {
          // valueOf is externref (can't call_ref) — push NaN
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        if (valueOfField.type.kind === "eqref") {
          // valueOf field is eqref (a closure struct stored without externref wrapping).
          // Recover the closure and call it by trying each known closure type
          // that was tracked for this struct's valueOf field.
          const trackedTypes = ctx.valueOfClosureTypes.get(name) ?? [];
          const callableClosureTypes: { closureTypeIdx: number; info: ClosureInfo }[] = [];
          for (const closureTypeIdx of trackedTypes) {
            const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            // Include all zero-param closures: f64/i32 return for value, void/null for side effects (returns NaN)
            if (info && info.paramTypes.length === 0) {
              callableClosureTypes.push({ closureTypeIdx, info });
            }
          }
          if (callableClosureTypes.length > 0) {
            // Save struct ref, extract valueOf eqref
            const structLocal = allocLocal(fctx, `__vo_struct_${fctx.locals.length}`, from);
            fctx.body.push({ op: "local.set", index: structLocal });
            fctx.body.push({ op: "local.get", index: structLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            const eqLocal = allocLocal(fctx, `__vo_eq_${fctx.locals.length}`, { kind: "eqref" });
            fctx.body.push({ op: "local.set", index: eqLocal });
            // Try each closure type with nested if/else
            const buildDispatch = (idx: number): Instr[] => {
              if (idx >= callableClosureTypes.length) {
                return [{ op: "f64.const", value: NaN } as Instr];
              }
              const { closureTypeIdx, info } = callableClosureTypes[idx]!;
              const closureLocal = allocLocal(fctx, `__vo_cl_${fctx.locals.length}`, { kind: "ref", typeIdx: closureTypeIdx });
              const thenInstrs: Instr[] = [
                { op: "local.get", index: eqLocal } as Instr,
                { op: "ref.cast", typeIdx: closureTypeIdx },
                { op: "local.tee", index: closureLocal } as Instr,
                { op: "local.get", index: closureLocal } as Instr,
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
                { op: "ref.cast", typeIdx: info.funcTypeIdx },
                { op: "ref.as_non_null" } as Instr,
                { op: "call_ref", typeIdx: info.funcTypeIdx },
              ];
              if (info.returnType?.kind === "i32") {
                thenInstrs.push({ op: "f64.convert_i32_s" } as Instr);
              } else if (!info.returnType || info.returnType.kind !== "f64") {
                // void/null return — call was for side effects; push NaN (ToNumber(undefined) = NaN)
                thenInstrs.push({ op: "f64.const", value: NaN } as Instr);
              }
              return [
                { op: "local.get", index: eqLocal } as Instr,
                { op: "ref.test", typeIdx: closureTypeIdx },
                { op: "if", blockType: { kind: "val" as const, type: { kind: "f64" as const } }, then: thenInstrs, else: buildDispatch(idx + 1) } as Instr,
              ];
            };
            for (const instr of buildDispatch(0)) {
              fctx.body.push(instr);
            }
            return;
          }
          // No closure types found — check for a standalone ClassName_valueOf function (#433)
          // Method shorthand syntax (e.g. { valueOf() { ... } }) compiles as a standalone
          // function rather than a closure stored in the struct field.
          const standaloneValueOf = ctx.funcMap.get(`${name}_valueOf`);
          if (standaloneValueOf !== undefined) {
            fctx.body.push({ op: "call", funcIdx: standaloneValueOf });
            const funcType = ctx.mod.types[ctx.mod.functions[standaloneValueOf - ctx.numImportFuncs]?.typeIdx ?? -1];
            if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            }
            return;
          }
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        break;
      }
    }
  }

  // Fallback: drop + push default
  fctx.body.push({ op: "drop" });
  pushDefaultValue(fctx, to);
}

/**
 * Emit a safe externref-to-f64 conversion that handles GC struct references.
 *
 * When an externref might hold a WasmGC struct (e.g., from `extern.convert_any`
 * on an object literal), calling the JS host `Number(v)` throws
 * "Cannot convert object to primitive value". This function emits inline Wasm
 * that uses `__typeof_number` to check if the externref is a JS number before
 * calling `__unbox_number`. For non-number externrefs (including GC structs),
 * it returns NaN per JS ToNumber semantics for objects without valueOf.
 *
 * Expects one externref on the stack; leaves one f64.
 */
export function emitSafeExternrefToF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  addUnionImports(ctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number")!;
  const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
  const tmpLocal = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: tmpLocal } as unknown as Instr);
  // Check if it's a JS number (typeof === "number")
  fctx.body.push({ op: "call", funcIdx: typeofNumIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: [
      // JS number: safe to unbox
      { op: "local.get", index: tmpLocal } as Instr,
      { op: "call", funcIdx: unboxIdx } as Instr,
    ],
    else: [
      // Not a number (GC struct, string, null, etc.): return NaN
      { op: "f64.const", value: NaN } as Instr,
    ],
  } as unknown as Instr);
  releaseTempLocal(fctx, tmpLocal);
}

export function pushDefaultValue(fctx: FunctionContext, type: ValType): void {
  switch (type.kind) {
    case "f64":
      // Use NaN as sentinel for "undefined/missing argument" (#787).
      // NaN is correct because: (1) it matches what explicit `undefined` compiles to
      // in f64 context (f64.const NaN), and (2) NaN is not a valid intended argument
      // in most cases (unlike 0, which IS a valid number).
      // Callee checks: local.get x; local.get x; f64.ne (NaN self-test).
      fctx.body.push({ op: "f64.const", value: NaN });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    case "i64":
      fctx.body.push({ op: "i64.const", value: 0n });
      break;
    case "externref":
      fctx.body.push({ op: "ref.null.extern" });
      break;
    case "eqref":
      fctx.body.push({ op: "ref.null.eq" });
      break;
    case "anyref":
      fctx.body.push({ op: "ref.null.eq" } as Instr);
      break;
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: type.typeIdx });
      break;
    case "ref":
      // ref.null produces (ref null N), but (ref N) is non-nullable.
      // Push ref.null then ref.as_non_null to satisfy Wasm validation.
      // This traps at runtime if actually executed, but parameter-padding
      // contexts typically don't reach non-null ref params with null values.
      // For if/else branches, callers should widen to ref_null first.
      fctx.body.push({ op: "ref.null", typeIdx: type.typeIdx });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      break;
    default:
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
  }
}

export function defaultValueInstrs(vt: ValType): Instr[] {
  switch (vt.kind) {
    case "f64":
      return [{ op: "f64.const", value: NaN } as Instr];
    case "f32":
      return [{ op: "f32.const", value: 0 } as Instr];
    case "i32":
      return [{ op: "i32.const", value: 0 } as Instr];
    case "i64":
      return [{ op: "i64.const", value: 0n } as Instr];
    case "externref":
    case "ref_extern":
      return [{ op: "ref.null.extern" } as Instr];
    case "ref":
      return [{ op: "ref.null", typeIdx: (vt as { typeIdx: number }).typeIdx }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: (vt as { typeIdx: number }).typeIdx }];
    case "eqref":
      return [{ op: "ref.null.eq" }];
    case "anyref":
      return [{ op: "ref.null.eq" } as Instr];
    case "funcref":
      return [{ op: "ref.null.func" }];
    default:
      // Fallback: f64 NaN (most arrays are f64 in this compiler)
      return [{ op: "f64.const", value: NaN } as Instr];
  }
}


/**
 * Generate Instr[] to coerce a value from one Wasm type to another.
 * Used in pre-built instruction arrays (e.g. array method callback loops)
 * where we can't call coerceType() which pushes to fctx.body.
 * Returns an empty array if no coercion is needed.
 */
export function coercionInstrs(ctx: CodegenContext, from: ValType, to: ValType): Instr[] {
  if (from.kind === to.kind) return [];
  // f64 → externref: box number
  if (from.kind === "f64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      return [{ op: "call", funcIdx } as Instr];
    }
  }
  // i32 → externref: convert to f64 then box
  if (from.kind === "i32" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      return [
        { op: "f64.convert_i32_s" } as Instr,
        { op: "call", funcIdx } as Instr,
      ];
    }
  }
  // i32 → f64
  if (from.kind === "i32" && to.kind === "f64") {
    return [{ op: "f64.convert_i32_s" } as Instr];
  }
  // f64 → i32
  if (from.kind === "f64" && to.kind === "i32") {
    return [{ op: "i32.trunc_sat_f64_s" } as Instr];
  }
  // externref → f64: unbox number
  if (from.kind === "externref" && to.kind === "f64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      return [{ op: "call", funcIdx } as Instr];
    }
  }
  // ref_null → ref: assert non-null
  if (from.kind === "ref_null" && to.kind === "ref") {
    return [{ op: "ref.as_non_null" } as Instr];
  }
  // ref/ref_null → externref: extern.convert_any
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    return [{ op: "extern.convert_any" } as Instr];
  }
  // externref → i32: unbox number then truncate
  if (from.kind === "externref" && to.kind === "i32") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      return [
        { op: "call", funcIdx } as Instr,
        { op: "i32.trunc_sat_f64_s" } as Instr,
      ];
    }
  }
  // i64 → f64
  if (from.kind === "i64" && to.kind === "f64") {
    return [{ op: "f64.convert_i64_s" } as Instr];
  }
  // f64 → i64
  if (from.kind === "f64" && to.kind === "i64") {
    return [{ op: "i64.trunc_sat_f64_s" } as Instr];
  }
  // i32 → i64
  if (from.kind === "i32" && to.kind === "i64") {
    return [{ op: "i64.extend_i32_s" } as Instr];
  }
  // i64 → i32
  if (from.kind === "i64" && to.kind === "i32") {
    return [{ op: "i32.wrap_i64" } as Instr];
  }
  // i64 → externref: convert to f64 then box
  if (from.kind === "i64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      return [
        { op: "f64.convert_i64_s" } as Instr,
        { op: "call", funcIdx } as Instr,
      ];
    }
  }
  // externref → i64: unbox number then truncate
  if (from.kind === "externref" && to.kind === "i64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      return [
        { op: "call", funcIdx } as Instr,
        { op: "i64.trunc_sat_f64_s" } as Instr,
      ];
    }
  }
  // ref/ref_null → f64: drop and push NaN (ToNumber on object without valueOf)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    return [
      { op: "drop" } as Instr,
      { op: "f64.const", value: NaN } as Instr,
    ];
  }
  // ref/ref_null → i32: drop and push 0
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "i32") {
    return [
      { op: "drop" } as Instr,
      { op: "i32.const", value: 0 } as Instr,
    ];
  }
  // funcref → externref: funcref is NOT a subtype of anyref in WasmGC,
  // so extern.convert_any cannot be used. Drop and push null as fallback.
  if (from.kind === "funcref" && to.kind === "externref") {
    return [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
  }
  // funcref → anyref: separate hierarchies in WasmGC, keep as no-op fallback
  if (from.kind === "funcref" && to.kind === "anyref") {
    return [];
  }
  // eqref → externref: extern.convert_any
  if (from.kind === "eqref" && to.kind === "externref") {
    return [{ op: "extern.convert_any" } as Instr];
  }
  // anyref → externref: extern.convert_any
  if (from.kind === "anyref" && to.kind === "externref") {
    return [{ op: "extern.convert_any" } as Instr];
  }
  // externref → anyref: any.convert_extern
  if (from.kind === "externref" && to.kind === "anyref") {
    return [{ op: "any.convert_extern" } as Instr];
  }
  // externref → eqref: any.convert_extern (anyref is supertype of eqref, but close enough for validation)
  if (from.kind === "externref" && to.kind === "eqref") {
    return [{ op: "any.convert_extern" } as Instr];
  }
  // externref → ref_null: any.convert_extern + ref.cast_null
  if (from.kind === "externref" && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    return [
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast_null", typeIdx: toIdx } as Instr,
    ];
  }
  // externref → ref: any.convert_extern + ref.cast
  if (from.kind === "externref" && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    return [
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: toIdx } as Instr,
    ];
  }
  // eqref/anyref → ref_null: ref.cast_null
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    return [{ op: "ref.cast_null", typeIdx: toIdx } as Instr];
  }
  // eqref/anyref → ref: ref.cast
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    return [{ op: "ref.cast", typeIdx: toIdx } as Instr];
  }
  return [];
}

// Register coerceType so shared.ts callers (closures, statements) can use it
registerCoerceType(coerceType);
