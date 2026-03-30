/**
 * Type coercion utilities for Wasm codegen.
 *
 * Extracted from expressions.ts to keep concerns separated.
 * Contains: coerceType, pushDefaultValue, defaultValueInstrs, coercionInstrs.
 */

import type { CodegenContext, FunctionContext, ClosureInfo, OptionalParamInfo } from "./index.js";
import { allocLocal, allocTempLocal, releaseTempLocal, addUnionImports, addStringConstantGlobal, isAnyValue, ensureAnyHelpers, getArrTypeIdxFromVec } from "./index.js";
import { registerCoerceType, ensureLateImport, flushLateImportShifts } from "./shared.js";
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
  // Save the pre-cast anyref so downstream multi-struct dispatch can use it
  // when the cast produced null (wrong struct type, not genuinely null). (#792)
  (fctx as any).__lastGuardedCastBackup = tmpLocal;
}

/**
 * Emit a guarded funcref cast: use ref.test to check if the cast will succeed.
 * If it fails, push ref.null instead of trapping with "illegal cast".
 * The value on the stack should be a funcref (from struct.get of a closure field).
 * The result is always ref_null $funcTypeIdx (nullable).
 *
 * Unlike emitGuardedRefCast, this uses funcref locals (not anyref) since
 * funcref is NOT a subtype of anyref in the WasmGC type hierarchy.
 */
export function emitGuardedFuncRefCast(
  fctx: FunctionContext,
  funcTypeIdx: number,
): void {
  const tmpFunc = allocLocal(fctx, `__gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  fctx.body.push({ op: "local.tee", index: tmpFunc } as unknown as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: funcTypeIdx } as unknown as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType },
    then: [
      { op: "local.get", index: tmpFunc } as unknown as Instr,
      { op: "ref.cast_null", typeIdx: funcTypeIdx } as unknown as Instr,
    ],
    else: [
      { op: "ref.null", typeIdx: funcTypeIdx } as unknown as Instr,
    ],
  } as Instr);
}

/**
 * Callback type for compiling a string literal onto the Wasm stack.
 * Used by coerceType when it needs to push a @@toPrimitive hint string.
 * The caller (expressions.ts) passes its local compileStringLiteral function.
 * @deprecated No longer needed — coerceType now emits hint strings directly via global.get.
 */
export type CompileStringLiteralFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
) => void;

/**
 * Push a string constant onto the Wasm stack using the string_constants global import.
 * Registers the string if not already registered, then emits global.get.
 */
function pushStringHint(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: string,
): void {
  addStringConstantGlobal(ctx, hint);
  const globalIdx = ctx.stringGlobalMap.get(hint);
  if (globalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: globalIdx });
  }
}

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
 * Build instructions to construct a vec struct from a JS array (externref).
 * Uses __extern_length + __extern_get to read elements and build the WasmGC array.
 * Returns instruction array producing ref_null $vecType on the stack. (#792)
 */
function buildVecFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  externLocal: number,
  vecTypeIdx: number,
  vecInfo: { arrTypeIdx: number; elemType: ValType },
): Instr[] {
  const lenIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  const getIdx = ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  if (lenIdx === undefined || getIdx === undefined) {
    return [{ op: "ref.null", typeIdx: vecTypeIdx } as Instr];
  }

  const lenLocal = allocLocal(fctx, `__vec_len_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__vec_arr_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecInfo.arrTypeIdx });
  const idxLocal = allocLocal(fctx, `__vec_idx_${fctx.locals.length}`, { kind: "i32" });

  const buildElemCoerce = (): Instr[] => {
    const et = vecInfo.elemType;
    if (et.kind === "f64" && unboxIdx !== undefined) {
      return [{ op: "call", funcIdx: unboxIdx } as Instr];
    }
    if (et.kind === "i32" && unboxIdx !== undefined) {
      return [
        { op: "call", funcIdx: unboxIdx } as Instr,
        { op: "i32.trunc_sat_f64_s" } as unknown as Instr,
      ];
    }
    if (et.kind === "externref") return [];
    if (et.kind === "ref" || et.kind === "ref_null") {
      const elemTypeIdx = (et as { typeIdx: number }).typeIdx;
      // Check if the target is a tuple struct — if so, build the tuple from
      // the externref array element (e.g. [key, value] from Object.entries)
      // instead of trying ref.cast which would fail for JS arrays.
      const tupleFields = getTupleFields(ctx, elemTypeIdx);
      if (tupleFields && getIdx !== undefined) {
        // Stack has: externref (a JS array like [key, value])
        // Save it to a temp local so we can extract each field
        const tmpElem = allocLocal(fctx, `__tuple_src_${fctx.locals.length}`, { kind: "externref" });
        const instrs: Instr[] = [
          { op: "local.set", index: tmpElem } as Instr,
        ];
        // For each tuple field, extract from the JS array by index
        for (let fi = 0; fi < tupleFields.length; fi++) {
          const fieldType = tupleFields[fi]!;
          // Push the JS array and the index
          instrs.push({ op: "local.get", index: tmpElem } as Instr);
          if (boxIdx !== undefined) {
            instrs.push({ op: "f64.const", value: fi } as Instr);
            instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
          } else {
            instrs.push({ op: "ref.null.extern" } as Instr);
          }
          instrs.push({ op: "call", funcIdx: getIdx } as Instr);
          // Coerce the externref element to the tuple field type
          if (fieldType.kind === "f64" && unboxIdx !== undefined) {
            instrs.push({ op: "call", funcIdx: unboxIdx } as Instr);
          } else if (fieldType.kind === "i32" && unboxIdx !== undefined) {
            instrs.push({ op: "call", funcIdx: unboxIdx } as Instr);
            instrs.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
          }
          // externref fields don't need conversion
        }
        // Build the tuple struct from all fields on the stack
        instrs.push({ op: "struct.new", typeIdx: elemTypeIdx } as Instr);
        return instrs;
      }
      // Default: try anyref cast (works for WasmGC structs passed through externref)
      return [
        { op: "any.convert_extern" } as Instr,
        { op: "ref.cast_null", typeIdx: elemTypeIdx } as Instr,
      ];
    }
    return [];
  };

  return [
    { op: "local.get", index: externLocal } as Instr,
    { op: "call", funcIdx: lenIdx } as Instr,
    { op: "i32.trunc_sat_f64_s" } as unknown as Instr,
    { op: "local.set", index: lenLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "array.new_default", typeIdx: vecInfo.arrTypeIdx } as Instr,
    { op: "local.set", index: arrLocal } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: idxLocal } as Instr,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: idxLocal } as Instr,
          { op: "local.get", index: lenLocal } as Instr,
          { op: "i32.ge_u" } as Instr,
          { op: "br_if", depth: 1 } as Instr,
          { op: "local.get", index: arrLocal } as Instr,
          { op: "local.get", index: idxLocal } as Instr,
          { op: "local.get", index: externLocal } as Instr,
          ...(boxIdx !== undefined
            ? [
                { op: "local.get", index: idxLocal } as Instr,
                { op: "f64.convert_i32_s" } as Instr,
                { op: "call", funcIdx: boxIdx } as Instr,
              ]
            : [{ op: "ref.null.extern" } as Instr]),
          { op: "call", funcIdx: getIdx } as Instr,
          ...buildElemCoerce(),
          { op: "array.set", typeIdx: vecInfo.arrTypeIdx } as Instr,
          { op: "local.get", index: idxLocal } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.set", index: idxLocal } as Instr,
          { op: "br", depth: 0 } as Instr,
        ],
      } as Instr],
    } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "local.get", index: arrLocal } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx } as Instr,
  ];
}

/**
 * Build instructions to construct a tuple struct from an externref value at runtime.
 * Tries each known vec type via ref.test; if one matches, extracts elements and
 * constructs the tuple. Falls back to ref.null if no vec type matches.
 *
 * This handles the case where an externref wraps a vec (e.g. __vec_f64 from [1,2,3])
 * but the target parameter type is a tuple struct (__tuple_*).
 */
function buildTupleFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anyLocal: number,
  tupleTypeIdx: number,
  tupleFields: ValType[],
): Instr[] {
  const resultType: ValType = { kind: "ref_null", typeIdx: tupleTypeIdx };

  // Try each known vec type
  let instrs: Instr[] = [{ op: "ref.null", typeIdx: tupleTypeIdx } as Instr];

  for (const [_key, vecIdx] of ctx.vecTypeMap) {
    const vecInfo = getVecInfo(ctx, vecIdx);
    if (!vecInfo) continue;

    const { arrTypeIdx, elemType } = vecInfo;

    // Build the then-branch: cast to this vec, extract elements, build tuple
    const vecLocal = allocLocal(fctx, `__tup_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecIdx });
    const dataLocal = allocLocal(fctx, `__tup_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx } as ValType);
    const lenLocal = allocLocal(fctx, `__tup_len_${fctx.locals.length}`, { kind: "i32" });

    const thenInstrs: Instr[] = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.cast", typeIdx: vecIdx } as Instr,
      { op: "local.set", index: vecLocal } as Instr,
      // Get data array and length
      { op: "local.get", index: vecLocal } as Instr,
      { op: "struct.get", typeIdx: vecIdx, fieldIdx: 1 } as Instr,
      { op: "local.set", index: dataLocal } as Instr,
      { op: "local.get", index: vecLocal } as Instr,
      { op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 } as Instr,
      { op: "local.set", index: lenLocal } as Instr,
    ];

    // For each tuple field, bounds-checked read from the vec
    for (let i = 0; i < tupleFields.length; i++) {
      const fieldType = tupleFields[i]!;

      // Bounds check: if i < len, read data[i]; else default
      const readInstrs: Instr[] = [
        { op: "local.get", index: dataLocal } as Instr,
        { op: "i32.const", value: i } as Instr,
        { op: "array.get", typeIdx: arrTypeIdx } as Instr,
      ];

      const defaultInstrs: Instr[] = defaultValueInstrs(elemType);

      thenInstrs.push(
        { op: "i32.const", value: i } as Instr,
        { op: "local.get", index: lenLocal } as Instr,
        { op: "i32.lt_u" } as Instr,
        {
          op: "if",
          blockType: { kind: "val" as const, type: elemType },
          then: readInstrs,
          else: defaultInstrs,
        } as Instr,
      );

      // Coerce element type to tuple field type if needed
      if (elemType.kind !== fieldType.kind ||
          ((elemType.kind === "ref" || elemType.kind === "ref_null") &&
           (fieldType.kind === "ref" || fieldType.kind === "ref_null") &&
           (elemType as { typeIdx: number }).typeIdx !== (fieldType as { typeIdx: number }).typeIdx)) {
        // Inline coercion: most common case is f64 → externref (box) or externref → f64 (unbox)
        if (elemType.kind === "f64" && fieldType.kind === "externref") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            thenInstrs.push({ op: "call", funcIdx: boxIdx } as Instr);
          }
        } else if (elemType.kind === "externref" && fieldType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            thenInstrs.push({ op: "call", funcIdx: unboxIdx } as Instr);
          }
        } else if (elemType.kind === "f64" && fieldType.kind === "f64") {
          // same type, no coercion needed
        } else if (elemType.kind === "externref" && fieldType.kind === "externref") {
          // same type, no coercion needed
        } else if ((elemType.kind === "ref" || elemType.kind === "ref_null") && fieldType.kind === "externref") {
          thenInstrs.push({ op: "extern.convert_any" } as Instr);
        } else if (elemType.kind === "externref" && (fieldType.kind === "ref" || fieldType.kind === "ref_null")) {
          const toRefIdx = (fieldType as { typeIdx: number }).typeIdx;
          thenInstrs.push(
            { op: "any.convert_extern" } as Instr,
            { op: "ref.cast_null", typeIdx: toRefIdx } as Instr,
          );
        }
      }
    }

    // Construct the tuple
    thenInstrs.push({ op: "struct.new", typeIdx: tupleTypeIdx } as Instr);

    // Wrap in: ref.test(vecIdx) → if then: build tuple, else: previous chain
    instrs = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx: vecIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenInstrs,
        else: instrs,
      } as Instr,
    ];
  }

  return instrs;
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
 * @param toPrimitiveHint Optional ToPrimitive hint ("number", "string", or "default").
 *   When converting ref → f64 or ref → externref, the hint determines which string
 *   is passed to [Symbol.toPrimitive]. If not specified, defaults to "number" for
 *   f64 targets and "string" for externref targets.
 * @param compileStringLiteralFn Deprecated — no longer used, kept for API compat.
 */
export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
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
  // When the cast fails (e.g., JS array passed where vec struct expected),
  // try to construct the target from the JS object via __extern_get (#792).
  if (from.kind === "externref" && (to.kind === "ref" || to.kind === "ref_null")) {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    const vecInfo = getVecInfo(ctx, toIdx);

    // Save externref BEFORE converting to anyref — needed for __extern_get fallback
    const tmpExternLocal = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: tmpExternLocal });

    fctx.body.push({ op: "any.convert_extern" } as Instr);
    const tmpAnyLocal = allocTempLocal(fctx, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.tee", index: tmpAnyLocal });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });

    // Build else-branch: when cast fails, construct from JS object if possible
    let elseBranch: Instr[];
    if (vecInfo) {
      elseBranch = buildVecFromExternref(ctx, fctx, tmpExternLocal, toIdx, vecInfo);
    } else {
      // Check if the target is a tuple struct — if so, try converting from any known vec type
      const tupleFields = getTupleFields(ctx, toIdx);
      if (tupleFields) {
        elseBranch = buildTupleFromExternref(ctx, fctx, tmpAnyLocal, toIdx, tupleFields);
      } else {
        elseBranch = [{ op: "ref.null", typeIdx: toIdx } as Instr];
      }
    }

    const resultType: ValType = { kind: "ref_null", typeIdx: toIdx };
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [
        { op: "local.get", index: tmpAnyLocal },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: elseBranch,
    });
    // Don't ref.as_non_null for non-null targets — let downstream handle null
    // via multi-struct dispatch (#792)

    // Save pre-cast anyref backup for multi-struct dispatch
    (fctx as any).__lastGuardedCastBackup = tmpAnyLocal;
    releaseTempLocal(fctx, tmpExternLocal);
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
    const name = ctx.typeIdxToStructName.get(typeIdx);
    if (name !== undefined) {
      // Check for [Symbol.toPrimitive] method first
      const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
      if (toPrimFuncIdx !== undefined) {
        // Call ClassName_@@toPrimitive(self, hint)
        // Use provided hint, or default to "string" for externref target
        const hint = toPrimitiveHint ?? "string";
        pushStringHint(ctx, fctx, hint);
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
    }
    fctx.body.push({ op: "extern.convert_any" });
    // Vec structs (arrays) need Symbol.iterator to be iterable by JS APIs (#854).
    // After extern.convert_any, call __make_iterable to attach Symbol.iterator via sidecar.
    if (getArrTypeIdxFromVec(ctx, typeIdx) >= 0) {
      const makeIterIdx = ensureLateImport(ctx, "__make_iterable",
        [{ kind: "externref" }], [{ kind: "externref" }]);
      if (makeIterIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: makeIterIdx });
      }
    }
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
  // Re-entrancy guard: prevent infinite recursion when valueOf itself returns a struct.
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    const wasInsideValueOf = (ctx as any).__insideValueOfCoercion ?? false;
    if (wasInsideValueOf) {
      // Already inside a valueOf coercion — don't recurse, return NaN
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return;
    }
    (ctx as any).__insideValueOfCoercion = true;
    // The flag is cleared in a finally-like pattern — we save/restore it
    // before every return. Using a wrapper to keep it clean:
    const cleanup = () => { (ctx as any).__insideValueOfCoercion = wasInsideValueOf; };
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    const name = ctx.typeIdxToStructName.get(typeIdx);
    if (name !== undefined) {
      // Check for [Symbol.toPrimitive] method first — takes precedence over valueOf
      const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
        if (toPrimFuncIdx !== undefined) {
          // Call ClassName_@@toPrimitive(self, hint)
          // Use provided hint, or default to "number" for f64 target
          const hint = toPrimitiveHint ?? "number";
          pushStringHint(ctx, fctx, hint);
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
          cleanup(); return;
        }
        const fields = ctx.structFields.get(name);
        if (fields) {
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
              } else if (funcType?.kind === "func" &&
                         (funcType.results?.[0]?.kind === "ref" || funcType.results?.[0]?.kind === "ref_null")) {
                // valueOf returned an object ref — drop and push NaN
                fctx.body.push({ op: "drop" });
                fctx.body.push({ op: "f64.const", value: NaN });
              }
              cleanup(); return;
            }
            // No valueOf — try toString per ToPrimitive spec (#866)
            // JS spec: for "number"/"default" hint, valueOf is tried first, then toString.
            if (tryToStringFallback(ctx, fctx, from, typeIdx, name!, fields)) {
              cleanup(); return;
            }
            // No toString either — ToNumber({}) = NaN per spec
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: NaN });
            cleanup(); return;
          }
          const valueOfField = fields[fieldIdx];
          if (!valueOfField) {
            // Field index valid from findIndex but entry missing — treat as NaN
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: NaN });
            cleanup(); return;
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
              {
                const tmpFunc = allocTempLocal(fctx, { kind: "funcref" } as ValType);
                fctx.body.push({ op: "local.tee", index: tmpFunc } as unknown as Instr);
                fctx.body.push({ op: "ref.test", typeIdx: closureInfo.funcTypeIdx } as unknown as Instr);
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "val", type: { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx } as ValType },
                  then: [
                    { op: "local.get", index: tmpFunc } as unknown as Instr,
                    { op: "ref.cast_null", typeIdx: closureInfo.funcTypeIdx } as unknown as Instr,
                  ],
                  else: [
                    { op: "ref.null", typeIdx: closureInfo.funcTypeIdx } as unknown as Instr,
                  ],
                } as Instr);
                releaseTempLocal(fctx, tmpFunc);
              }
              fctx.body.push({ op: "ref.as_non_null" });
              fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
              // Convert valueOf result to f64
              if (!closureInfo.returnType) {
                // void return — push NaN
                fctx.body.push({ op: "f64.const", value: NaN });
              } else if (closureInfo.returnType.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
              } else if (closureInfo.returnType.kind === "externref" || closureInfo.returnType.kind === "ref_extern") {
                // valueOf returned a string (externref) — convert to f64
                addUnionImports(ctx);
                const unboxIdx = ctx.funcMap.get("__unbox_number");
                if (unboxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: unboxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "f64.const", value: NaN });
                }
              } else if (closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null") {
                // valueOf returned an object ref — drop and push NaN
                fctx.body.push({ op: "drop" });
                fctx.body.push({ op: "f64.const", value: NaN });
              }
              // f64 return → value is already on stack
              cleanup(); return;
            }
          }
          if (valueOfField.type.kind === "externref") {
            // valueOf is externref (can't call_ref) — push NaN
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: NaN });
            cleanup(); return;
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
                const funcTmp = allocLocal(fctx, `__vo_fn_${fctx.locals.length}`, { kind: "funcref" } as ValType);
                const thenInstrs: Instr[] = [
                  { op: "local.get", index: eqLocal } as Instr,
                  { op: "ref.cast", typeIdx: closureTypeIdx },
                  { op: "local.tee", index: closureLocal } as Instr,
                  { op: "local.get", index: closureLocal } as Instr,
                  { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
                  // Guarded funcref cast to avoid illegal cast traps
                  { op: "local.tee", index: funcTmp } as unknown as Instr,
                  { op: "ref.test", typeIdx: info.funcTypeIdx } as unknown as Instr,
                  { op: "if", blockType: { kind: "val", type: { kind: "ref_null", typeIdx: info.funcTypeIdx } as ValType },
                    then: [
                      { op: "local.get", index: funcTmp } as unknown as Instr,
                      { op: "ref.cast_null", typeIdx: info.funcTypeIdx } as unknown as Instr,
                    ],
                    else: [
                      { op: "ref.null", typeIdx: info.funcTypeIdx } as unknown as Instr,
                    ],
                  } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "call_ref", typeIdx: info.funcTypeIdx },
                ];
                if (info.returnType?.kind === "i32") {
                  thenInstrs.push({ op: "f64.convert_i32_s" } as Instr);
                } else if (info.returnType?.kind === "externref" || info.returnType?.kind === "ref_extern") {
                  // valueOf returned a string (externref) — convert to f64 via __unbox_number
                  addUnionImports(ctx);
                  const unboxIdx = ctx.funcMap.get("__unbox_number");
                  if (unboxIdx !== undefined) {
                    thenInstrs.push({ op: "call", funcIdx: unboxIdx } as Instr);
                  } else {
                    thenInstrs.push({ op: "drop" } as Instr);
                    thenInstrs.push({ op: "f64.const", value: NaN } as Instr);
                  }
                } else if (!info.returnType) {
                  // void return — call was for side effects; push NaN
                  thenInstrs.push({ op: "f64.const", value: NaN } as Instr);
                } else if (info.returnType.kind !== "f64") {
                  // non-f64 return (ref, etc.) — drop and push NaN
                  thenInstrs.push({ op: "drop" } as Instr);
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
              const retKind = funcType?.kind === "func" ? funcType.results?.[0]?.kind : undefined;
              if (retKind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
              } else if (retKind === "externref" || retKind === "ref_extern") {
                // valueOf returned a string (externref) — convert to f64
                addUnionImports(ctx);
                const unboxIdx = ctx.funcMap.get("__unbox_number");
                if (unboxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: unboxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "f64.const", value: NaN });
                }
              } else if (retKind === "ref" || retKind === "ref_null") {
                // valueOf returned an object ref — drop and push NaN
                fctx.body.push({ op: "drop" });
                fctx.body.push({ op: "f64.const", value: NaN });
              }
              return;
            }
            // No valueOf via eqref — try toString fallback (#866)
            if (tryToStringFallback(ctx, fctx, from, typeIdx, name!, fields)) {
              cleanup(); return;
            }
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: NaN });
            cleanup(); return;
          }
        }
      }
    }

  // Fallback: drop + push default
  fctx.body.push({ op: "drop" });
  pushDefaultValue(fctx, to, ctx);
}

/**
 * Try to call toString on a struct as a fallback for ToPrimitive when valueOf is missing (#866).
 * Per JS spec, ToPrimitive with "number"/"default" hint tries valueOf first, then toString.
 * If toString is found and returns a primitive, converts the result to f64 via __unbox_number.
 * Returns true if toString was found and code was emitted, false otherwise.
 * Expects the struct ref on top of the Wasm stack; consumes it.
 */
function tryToStringFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  typeIdx: number,
  structName: string,
  fields: { name: string; type: ValType }[],
): boolean {
  // 1. Check for toString struct field (closure ref)
  const toStrFieldIdx = fields.findIndex(f => f.name === "toString");
  if (toStrFieldIdx >= 0) {
    const toStrField = fields[toStrFieldIdx]!;
    if (toStrField.type.kind === "ref" || toStrField.type.kind === "ref_null") {
      const closureTypeIdx = (toStrField.type as { typeIdx: number }).typeIdx;
      const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
      if (closureInfo) {
        // Save struct ref, extract toString closure, call it
        const structLocal = allocLocal(fctx, `__ts_struct_${fctx.locals.length}`, from);
        fctx.body.push({ op: "local.set", index: structLocal });
        fctx.body.push({ op: "local.get", index: structLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: toStrFieldIdx });
        const closureLocal = allocLocal(fctx, `__ts_closure_${fctx.locals.length}`, toStrField.type);
        fctx.body.push({ op: "local.tee", index: closureLocal });
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
        {
          const tmpFunc = allocTempLocal(fctx, { kind: "funcref" } as ValType);
          fctx.body.push({ op: "local.tee", index: tmpFunc } as unknown as Instr);
          fctx.body.push({ op: "ref.test", typeIdx: closureInfo.funcTypeIdx } as unknown as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx } as ValType },
            then: [
              { op: "local.get", index: tmpFunc } as unknown as Instr,
              { op: "ref.cast_null", typeIdx: closureInfo.funcTypeIdx } as unknown as Instr,
            ],
            else: [
              { op: "ref.null", typeIdx: closureInfo.funcTypeIdx } as unknown as Instr,
            ],
          } as Instr);
          releaseTempLocal(fctx, tmpFunc);
        }
        fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
        // Convert toString result to f64
        emitToStringResultToF64(ctx, fctx, closureInfo.returnType);
        return true;
      }
    }
    if (toStrField.type.kind === "eqref") {
      // toString field is eqref — try tracked closure types
      const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
      // Also check toStringClosureTypes if available
      for (const closureTypeIdx of trackedTypes) {
        const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
        if (info && info.paramTypes.length === 0) {
          // Try this closure type
          const structLocal = allocLocal(fctx, `__ts_struct_${fctx.locals.length}`, from);
          fctx.body.push({ op: "local.set", index: structLocal });
          fctx.body.push({ op: "local.get", index: structLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: toStrFieldIdx });
          const eqLocal = allocLocal(fctx, `__ts_eq_${fctx.locals.length}`, { kind: "eqref" });
          fctx.body.push({ op: "local.set", index: eqLocal });
          // ref.test + cast + call
          fctx.body.push({ op: "local.get", index: eqLocal } as Instr);
          fctx.body.push({ op: "ref.test", typeIdx: closureTypeIdx } as unknown as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [
              { op: "local.get", index: eqLocal } as Instr,
              { op: "ref.cast", typeIdx: closureTypeIdx } as unknown as Instr,
              (() => {
                const closureLocal2 = allocLocal(fctx, `__ts_cl2_${fctx.locals.length}`, { kind: "ref", typeIdx: closureTypeIdx });
                return { op: "local.tee", index: closureLocal2 };
              })() as Instr,
              (() => {
                const closureLocal2 = fctx.locals.length - 1 + fctx.params.length;
                return { op: "local.get", index: closureLocal2 };
              })() as Instr,
              { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
              (() => {
                const funcTmp = allocTempLocal(fctx, { kind: "funcref" } as ValType);
                const instrs: Instr[] = [
                  { op: "local.tee", index: funcTmp } as unknown as Instr,
                  { op: "ref.test", typeIdx: info.funcTypeIdx } as unknown as Instr,
                  { op: "if", blockType: { kind: "val", type: { kind: "ref_null", typeIdx: info.funcTypeIdx } as ValType },
                    then: [
                      { op: "local.get", index: funcTmp } as unknown as Instr,
                      { op: "ref.cast_null", typeIdx: info.funcTypeIdx } as unknown as Instr,
                    ],
                    else: [
                      { op: "ref.null", typeIdx: info.funcTypeIdx } as unknown as Instr,
                    ],
                  } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "call_ref", typeIdx: info.funcTypeIdx } as Instr,
                ];
                releaseTempLocal(fctx, funcTmp);
                // Convert result to f64
                if (info.returnType?.kind === "i32") {
                  instrs.push({ op: "f64.convert_i32_s" } as Instr);
                } else if (info.returnType?.kind === "externref" || info.returnType?.kind === "ref_extern") {
                  addUnionImports(ctx);
                  const unboxIdx = ctx.funcMap.get("__unbox_number");
                  if (unboxIdx !== undefined) {
                    instrs.push({ op: "call", funcIdx: unboxIdx } as Instr);
                  } else {
                    instrs.push({ op: "drop" } as Instr);
                    instrs.push({ op: "f64.const", value: NaN } as Instr);
                  }
                } else if (!info.returnType || (info.returnType.kind !== "f64")) {
                  if (info.returnType) instrs.push({ op: "drop" } as Instr);
                  instrs.push({ op: "f64.const", value: NaN } as Instr);
                }
                return instrs;
              })(),
            ].flat() as Instr[],
            else: [
              { op: "f64.const", value: NaN } as Instr,
            ],
          } as Instr);
          return true;
        }
      }
    }
  }

  // 2. Check for standalone ClassName_toString method
  const toStrFuncIdx = ctx.funcMap.get(`${structName}_toString`);
  if (toStrFuncIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: toStrFuncIdx });
    const funcType = ctx.mod.types[ctx.mod.functions[toStrFuncIdx - ctx.numImportFuncs]?.typeIdx ?? -1];
    const retKind = funcType?.kind === "func" ? funcType.results?.[0]?.kind : undefined;
    emitToStringResultToF64ByKind(ctx, fctx, retKind);
    return true;
  }

  return false;
}

/**
 * Convert the result of a toString call to f64.
 * Handles f64 (passthrough), i32 (convert), externref (unbox), and other types.
 */
function emitToStringResultToF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  returnType: ValType | null | undefined,
): void {
  if (!returnType) {
    // void return — push NaN
    fctx.body.push({ op: "f64.const", value: NaN });
  } else if (returnType.kind === "f64") {
    // already f64 — passthrough
  } else if (returnType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (returnType.kind === "externref" || returnType.kind === "ref_extern") {
    // toString returned a string — convert to f64 via __unbox_number
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
  } else {
    // ref or other — drop and push NaN
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: NaN });
  }
}

/**
 * Same as emitToStringResultToF64 but takes a string kind.
 */
function emitToStringResultToF64ByKind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  retKind: string | undefined,
): void {
  if (retKind === "f64") {
    // already f64 — passthrough
  } else if (retKind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (retKind === "externref" || retKind === "ref_extern") {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
  } else {
    // non-f64 return — drop and push NaN
    if (retKind && retKind !== "void") fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: NaN });
  }
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

/**
 * Emit instructions that push the JS `undefined` value onto the stack (#737).
 * Uses the __get_undefined host import when available; falls back to
 * ref.null.extern (indistinguishable from null) in standalone mode.
 * This is a local version to avoid circular deps with expressions.ts.
 */
function emitUndefinedValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
): void {
  const funcIdx = ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
  if (funcIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

export function pushDefaultValue(fctx: FunctionContext, type: ValType, ctx?: CodegenContext): void {
  switch (type.kind) {
    case "f64":
      // Default value for missing f64 args without initializers: 0.
      // For params WITH initializers, callers should use pushParamSentinel instead (#866).
      fctx.body.push({ op: "f64.const", value: 0 });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    case "i64":
      fctx.body.push({ op: "i64.const", value: 0n });
      break;
    case "externref":
      // When ctx is available, emit the actual JS `undefined` value (#737).
      // Missing function arguments should be `undefined`, not `null`.
      // In standalone mode (no host imports), falls back to ref.null.extern.
      if (ctx) {
        emitUndefinedValue(ctx, fctx);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
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

/**
 * Push the caller-side default for a missing optional parameter (#869).
 *
 * For constant defaults (number literal, boolean, null, undefined):
 *   Emit the constant value directly — no sentinel needed, callee never checks.
 *
 * For expression defaults (non-constant initializer):
 *   Fall back to the sNaN sentinel (0x7FF00000DEADC0DE) for f64 params.
 *   The callee detects this via i64.reinterpret_f64 + i64.eq and evaluates the expression.
 *
 * For params without initializers (just `?`):
 *   Emit the type's zero value (0, ref.null, etc.).
 */
export function pushParamSentinel(fctx: FunctionContext, type: ValType, ctx?: CodegenContext, optInfo?: OptionalParamInfo): void {
  // If we have a constant default, emit it directly (#869)
  if (optInfo?.constantDefault) {
    const cd = optInfo.constantDefault;
    if (cd.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: cd.value });
    } else {
      fctx.body.push({ op: "i32.const", value: cd.value });
    }
    return;
  }

  // Expression default or no constant available — use sentinel for f64
  if (type.kind === "f64" && (optInfo?.hasExpressionDefault ?? true)) {
    // Unique sNaN sentinel: quiet bit (bit 51) clear, custom payload.
    // JS NaN is always 0x7FF8000000000000 (quiet NaN), so this is distinguishable.
    fctx.body.push({ op: "i64.const", value: 0x7FF00000DEADC0DEn } as unknown as Instr);
    fctx.body.push({ op: "f64.reinterpret_i64" } as unknown as Instr);
  } else {
    pushDefaultValue(fctx, type, ctx);
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
export function coercionInstrs(ctx: CodegenContext, from: ValType, to: ValType, fctx?: FunctionContext): Instr[] {
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
  // externref → ref_null: any.convert_extern + guarded ref.cast_null
  if (from.kind === "externref" && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    if (fctx) {
      const tmp = allocTempLocal(fctx, { kind: "anyref" } as ValType);
      const result: Instr[] = [
        { op: "any.convert_extern" } as Instr,
        { op: "local.tee", index: tmp },
        { op: "ref.test", typeIdx: toIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
          then: [
            { op: "local.get", index: tmp } as Instr,
            { op: "ref.cast_null", typeIdx: toIdx } as Instr,
          ],
          else: [
            { op: "ref.null", typeIdx: toIdx },
          ],
        } as Instr,
      ];
      releaseTempLocal(fctx, tmp);
      return result;
    }
    // No fctx available — use original ref.cast (may trap as illegal_cast,
    // but that's more informative than silently returning null).
    return [
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast_null", typeIdx: toIdx } as unknown as Instr,
    ];
  }
  // externref → ref: any.convert_extern + guarded ref.cast
  if (from.kind === "externref" && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    if (fctx) {
      const tmp = allocTempLocal(fctx, { kind: "anyref" } as ValType);
      const result: Instr[] = [
        { op: "any.convert_extern" } as Instr,
        { op: "local.tee", index: tmp },
        { op: "ref.test", typeIdx: toIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
          then: [
            { op: "local.get", index: tmp } as Instr,
            { op: "ref.cast_null", typeIdx: toIdx } as Instr,
          ],
          else: [
            { op: "ref.null", typeIdx: toIdx },
          ],
        } as Instr,
      ];
      releaseTempLocal(fctx, tmp);
      return result;
    }
    // No fctx available — use original ref.cast
    return [
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: toIdx } as unknown as Instr,
    ];
  }
  // eqref/anyref → ref_null: guarded ref.cast_null
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    if (fctx) {
      const tmp = allocTempLocal(fctx, from);
      const result: Instr[] = [
        { op: "local.tee", index: tmp },
        { op: "ref.test", typeIdx: toIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
          then: [
            { op: "local.get", index: tmp } as Instr,
            { op: "ref.cast_null", typeIdx: toIdx } as Instr,
          ],
          else: [
            { op: "ref.null", typeIdx: toIdx },
          ],
        } as Instr,
      ];
      releaseTempLocal(fctx, tmp);
      return result;
    }
    return [{ op: "ref.cast_null", typeIdx: toIdx } as Instr];
  }
  // eqref/anyref → ref: guarded ref.cast
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    if (fctx) {
      const tmp = allocTempLocal(fctx, from);
      const result: Instr[] = [
        { op: "local.tee", index: tmp },
        { op: "ref.test", typeIdx: toIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
          then: [
            { op: "local.get", index: tmp } as Instr,
            { op: "ref.cast_null", typeIdx: toIdx } as Instr,
          ],
          else: [
            { op: "ref.null", typeIdx: toIdx },
          ],
        } as Instr,
      ];
      releaseTempLocal(fctx, tmp);
      return result;
    }
    return [{ op: "ref.cast", typeIdx: toIdx } as Instr];
  }
  return [];
}

// Register coerceType so shared.ts callers (closures, statements) can use it
registerCoerceType(coerceType);
