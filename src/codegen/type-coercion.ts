/**
 * Type coercion utilities — extracted from expressions.ts (#591).
 *
 * Contains coerceType, pushDefaultValue, defaultValueInstrs, coercionInstrs,
 * and the emitStringConstant helper used for Symbol.toPrimitive hint args.
 */
import type { CodegenContext, FunctionContext, ClosureInfo } from "./index.js";
import { allocLocal, allocTempLocal, releaseTempLocal, addUnionImports, isAnyValue, ensureAnyHelpers, addStringConstantGlobal, nativeStringType } from "./index.js";
import type { Instr, ValType } from "../ir/types.js";

/**
 * Emit a short string constant onto the stack (for toPrimitive hints).
 * Handles both externref-string mode and native-string (fast) mode.
 */
function emitStringConstant(ctx: CodegenContext, fctx: FunctionContext, value: string): void {
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
    // Fast mode: materialize as NativeString GC struct inline
    const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
    const strTypeIdx = ctx.nativeStrTypeIdx;
    fctx.body.push({ op: "i32.const", value: value.length });
    fctx.body.push({ op: "i32.const", value: 0 });
    for (let i = 0; i < value.length; i++) {
      fctx.body.push({ op: "i32.const", value: value.charCodeAt(i) });
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });
    fctx.body.push({ op: "struct.new", typeIdx: strTypeIdx });
    return;
  }
  // Normal mode: use importedStringConstants global
  addStringConstantGlobal(ctx, value);
  const globalIdx = ctx.stringGlobalMap.get(value);
  if (globalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: globalIdx });
  }
}

/** Coerce a value on the stack from one type to another */
export function coerceType(ctx: CodegenContext, fctx: FunctionContext, from: ValType, to: ValType): void {
  if (from.kind === to.kind) {
    // Same kind but check if ref typeIdx differs (e.g. ref $AnyValue vs ref $SomeStruct)
    if ((from.kind === "ref" || from.kind === "ref_null") &&
        (to.kind === "ref" || to.kind === "ref_null")) {
      const fromIdx = (from as { typeIdx: number }).typeIdx;
      const toIdx = (to as { typeIdx: number }).typeIdx;
      if (fromIdx === toIdx) return;
      // Boxing: non-any ref -> any ref
      if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
        ensureAnyHelpers(ctx);
        const funcIdx = ctx.funcMap.get("__any_box_ref");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return;
        }
      }
      // Unboxing: any ref -> non-any ref (extract refval and cast)
      if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
        ensureAnyHelpers(ctx);
        // Get the refval field (eqref), then ref.cast to target type
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
        fctx.body.push({ op: "ref.cast", typeIdx: toIdx });
        return;
      }
      // Different struct types, neither is AnyValue -- cannot safely cast
      // between unrelated Wasm GC struct types. The caller should ensure
      // the local type matches, or handle this via extern.convert_any boxing.
      return;
    }
    return;
  }
  // ref is a subtype of ref_null -- no coercion needed for same typeIdx
  if (from.kind === "ref" && to.kind === "ref_null") {
    // But check for any-value boxing (ref $X -> ref_null $AnyValue)
    if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_ref");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // ref $X is a subtype of ref_null $X for same typeIdx -- no coercion needed.
    // For different typeIdx, cannot safely cast between unrelated struct types.
    return;
  }
  if (from.kind === "ref_null" && to.kind === "ref") {
    // Unboxing: ref_null $AnyValue -> ref $X
    if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
      ensureAnyHelpers(ctx);
      const toIdx = (to as { typeIdx: number }).typeIdx;
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
      fctx.body.push({ op: "ref.cast", typeIdx: toIdx });
      return;
    }
    // ref_null $X -> ref $X: assert non-null at runtime (traps if null)
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    return;
  }

  // -- Boxing: primitive -> ref $AnyValue --
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
      // i64 -> AnyValue: convert to f64 first, then box as f64
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

  // -- Unboxing: ref $AnyValue -> primitive --
  if (isAnyValue(from, ctx)) {
    ensureAnyHelpers(ctx);
    if (to.kind === "i32") {
      const funcIdx = ctx.funcMap.get("__any_unbox_i32");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (to.kind === "f64") {
      const funcIdx = ctx.funcMap.get("__any_unbox_f64");
      if (funcIdx !== undefined) { fctx.body.push({ op: "call", funcIdx }); return; }
    }
    if (to.kind === "i64") {
      // AnyValue -> i64: unbox as f64 first, then truncate to i64
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

  // i64 -> f64 (Number(bigint))
  if (from.kind === "i64" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i64_s" });
    return;
  }
  // f64 -> i64 (BigInt(number))
  if (from.kind === "f64" && to.kind === "i64") {
    fctx.body.push({ op: "i64.trunc_sat_f64_s" });
    return;
  }
  // i32 -> i64
  if (from.kind === "i32" && to.kind === "i64") {
    fctx.body.push({ op: "i64.extend_i32_s" });
    return;
  }
  // i64 -> i32
  if (from.kind === "i64" && to.kind === "i32") {
    // Truncate: check if non-zero (truthiness for conditions)
    fctx.body.push({ op: "i64.const", value: 0n });
    fctx.body.push({ op: "i64.ne" });
    return;
  }
  // i32 -> f64
  if (from.kind === "i32" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  // f64 -> i32
  if (from.kind === "f64" && to.kind === "i32") {
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    return;
  }
  // externref -> i32 (unbox as number to preserve value, then truncate)
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
  // externref -> f64 (unbox number)
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
  // externref -> i64 (unbox number then truncate to i64)
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
  // externref -> ref/ref_null: convert externref back to anyref, then cast to target struct type.
  // Uses any.convert_extern + ref.cast (non-nullable) or ref.cast_null (nullable).
  if (from.kind === "externref" && (to.kind === "ref" || to.kind === "ref_null")) {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    if (to.kind === "ref_null") {
      fctx.body.push({ op: "ref.cast_null", typeIdx: toIdx } as unknown as Instr);
    } else {
      fctx.body.push({ op: "ref.cast", typeIdx: toIdx } as unknown as Instr);
    }
    return;
  }
  // f64 -> externref (box number)
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
  // i32 -> externref (box as number to preserve value)
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
  // i64 -> externref (box as number: convert i64 -> f64, then box)
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
  // ref/ref_null -> externref: check @@toPrimitive("string") first, then toString(), else extern.convert_any
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    for (const [name, idx] of ctx.structMap) {
      if (idx === typeIdx) {
        // Check for [Symbol.toPrimitive] method first
        const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
        if (toPrimFuncIdx !== undefined) {
          // Call ClassName_@@toPrimitive(self, "string")
          emitStringConstant(ctx, fctx, "string");
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
          // externref/ref return -> use extern.convert_any for ref types
          if (retKind === "ref" || retKind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          return;
        }
        const toStringFuncIdx = ctx.funcMap.get(`${name}_toString`);
        if (toStringFuncIdx !== undefined) {
          // Call ClassName_toString(self) -- self is already on stack
          fctx.body.push({ op: "call", funcIdx: toStringFuncIdx });
          return;
        }
        break;
      }
    }
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }
  // ref/ref_null -> eqref: no-op (GC struct refs are subtypes of eqref)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "eqref") {
    return;
  }
  // ref/ref_null -> anyref: no-op (GC struct refs are subtypes of anyref)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "anyref") {
    return;
  }
  // externref -> ref (non-nullable): convert to anyref then cast
  if (from.kind === "externref" && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: toIdx } as Instr);
    return;
  }
  // externref -> ref_null: convert to anyref, then use if/else to handle null and type mismatch
  if (from.kind === "externref" && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    // Store in a temp local, check for null or type mismatch
    const tmpLocal = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    // Use ref.test to check both null and type compatibility (ref.test returns 0 for null)
    fctx.body.push({ op: "ref.test", typeIdx: toIdx } as unknown as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: tmpLocal } as Instr,
        { op: "ref.cast", typeIdx: toIdx } as Instr,
      ],
      else: [{ op: "ref.null", typeIdx: toIdx } as unknown as Instr],
    });
    releaseTempLocal(fctx, tmpLocal);
    return;
  }
  // eqref/anyref -> ref: cast to target struct type (traps on null)
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "ref.cast", typeIdx: toIdx } as Instr);
    return;
  }
  // eqref/anyref -> ref_null: null-safe and type-safe cast
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    const tmpLocal = allocTempLocal(fctx, from);
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    // Use ref.test to check both null and type compatibility (ref.test returns 0 for null)
    fctx.body.push({ op: "ref.test", typeIdx: toIdx } as unknown as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: tmpLocal } as Instr,
        { op: "ref.cast", typeIdx: toIdx } as Instr,
      ],
      else: [{ op: "ref.null", typeIdx: toIdx } as unknown as Instr],
    });
    releaseTempLocal(fctx, tmpLocal);
    return;
  }

  // i32/f64 -> externref (fallback)
  if (to.kind === "externref") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // ref (struct) -> f64: JS ToNumber semantics -- check @@toPrimitive("number") first, then valueOf
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    for (const [name, idx] of ctx.structMap) {
      if (idx === typeIdx) {
        // Check for [Symbol.toPrimitive] method first -- takes precedence over valueOf
        const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
        if (toPrimFuncIdx !== undefined) {
          // Call ClassName_@@toPrimitive(self, "number")
          emitStringConstant(ctx, fctx, "number");
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
          // f64 return -> already correct type
          return;
        }
        const fields = ctx.structFields.get(name);
        if (!fields) { break; }
        const fieldIdx = fields.findIndex(f => f.name === "valueOf");
        if (fieldIdx < 0) {
          // No valueOf field -- check for a class method valueOf (ClassName_valueOf)
          const valueOfFuncIdx = ctx.funcMap.get(`${name}_valueOf`);
          if (valueOfFuncIdx !== undefined) {
            // Call ClassName_valueOf(self) -- self is already on stack
            fctx.body.push({ op: "call", funcIdx: valueOfFuncIdx });
            // Check return type -- if not f64, convert to f64
            const voFuncDefIdx = valueOfFuncIdx - ctx.numImportFuncs;
            const voFuncDef = voFuncDefIdx >= 0 ? ctx.mod.functions[voFuncDefIdx] : undefined;
            const funcType = voFuncDef ? ctx.mod.types[voFuncDef.typeIdx] : undefined;
            if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            } else if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "externref") {
              // valueOf returned externref (e.g. WrapperString_valueOf returns a string)
              // Convert externref -> f64 via __unbox_number or parseFloat
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
          // No valueOf -- ToNumber({}) = NaN per spec
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        const valueOfField = fields[fieldIdx];
        if (!valueOfField) {
          // Field index valid from findIndex but entry missing -- treat as NaN
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          return;
        }
        if (valueOfField.type.kind === "ref" || valueOfField.type.kind === "ref_null") {
          // valueOf is a closure ref -- call it via call_ref
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
            // call_ref signature: [closure_ref, funcref] -> results
            fctx.body.push({ op: "local.get", index: closureLocal });
            fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
            fctx.body.push({ op: "ref.as_non_null" });
            fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
            // If valueOf returns void/null, result is NaN; if f64, keep it
            if (!closureInfo.returnType || closureInfo.returnType.kind === "i32") {
              // void -> push NaN (the call produced nothing or an i32)
              if (closureInfo.returnType?.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
              } else {
                fctx.body.push({ op: "f64.const", value: NaN });
              }
            }
            // f64 return -> value is already on stack
            return;
          }
        }
        if (valueOfField.type.kind === "externref") {
          // valueOf is externref (can't call_ref) -- push NaN
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
            const buildDispatch = (dispatchIdx: number): Instr[] => {
              if (dispatchIdx >= callableClosureTypes.length) {
                return [{ op: "f64.const", value: NaN } as Instr];
              }
              const { closureTypeIdx, info } = callableClosureTypes[dispatchIdx]!;
              const closureLocal = allocLocal(fctx, `__vo_cl_${fctx.locals.length}`, { kind: "ref", typeIdx: closureTypeIdx });
              const thenInstrs: Instr[] = [
                { op: "local.get", index: eqLocal } as Instr,
                { op: "ref.cast", typeIdx: closureTypeIdx } as unknown as Instr,
                { op: "local.tee", index: closureLocal } as Instr,
                { op: "local.get", index: closureLocal } as Instr,
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
                { op: "ref.cast", typeIdx: info.funcTypeIdx } as unknown as Instr,
                { op: "ref.as_non_null" } as Instr,
                { op: "call_ref", typeIdx: info.funcTypeIdx } as unknown as Instr,
              ];
              if (info.returnType?.kind === "i32") {
                thenInstrs.push({ op: "f64.convert_i32_s" } as Instr);
              } else if (!info.returnType || info.returnType.kind !== "f64") {
                // void/null return -- call was for side effects; push NaN (ToNumber(undefined) = NaN)
                thenInstrs.push({ op: "f64.const", value: NaN } as Instr);
              }
              return [
                { op: "local.get", index: eqLocal } as Instr,
                { op: "ref.test", typeIdx: closureTypeIdx } as unknown as Instr,
                { op: "if", blockType: { kind: "val" as const, type: { kind: "f64" as const } }, then: thenInstrs, else: buildDispatch(dispatchIdx + 1) } as Instr,
              ];
            };
            for (const instr of buildDispatch(0)) {
              fctx.body.push(instr);
            }
            return;
          }
          // No closure types found -- check for a standalone ClassName_valueOf function (#433)
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

/** Push a default/zero value for the given type onto fctx.body. */
export function pushDefaultValue(fctx: FunctionContext, type: ValType): void {
  switch (type.kind) {
    case "f64":
      fctx.body.push({ op: "f64.const", value: 0 });
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
      fctx.body.push({ op: "ref.null.eq" } as unknown as Instr);
      break;
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: (type as any).typeIdx });
      break;
    case "ref":
      // ref.null produces (ref null N), but (ref N) is non-nullable.
      // Push ref.null then ref.as_non_null to satisfy Wasm validation.
      // This traps at runtime if actually executed, but parameter-padding
      // contexts typically don't reach non-null ref params with null values.
      // For if/else branches, callers should widen to ref_null first.
      fctx.body.push({ op: "ref.null", typeIdx: (type as any).typeIdx });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      break;
    default:
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
  }
}

/** Produce instructions that leave a default value on the stack for a given type. */
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
      return [{ op: "ref.null", typeIdx: (vt as { typeIdx: number }).typeIdx } as unknown as Instr];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: (vt as { typeIdx: number }).typeIdx } as unknown as Instr];
    case "eqref":
      return [{ op: "ref.null.eq" } as unknown as Instr];
    case "funcref":
      return [{ op: "ref.null.func" } as unknown as Instr];
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
  // f64 -> externref: box number
  if (from.kind === "f64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      return [{ op: "call", funcIdx } as Instr];
    }
  }
  // i32 -> externref: convert to f64 then box
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
  // i32 -> f64
  if (from.kind === "i32" && to.kind === "f64") {
    return [{ op: "f64.convert_i32_s" } as Instr];
  }
  // f64 -> i32
  if (from.kind === "f64" && to.kind === "i32") {
    return [{ op: "i32.trunc_sat_f64_s" } as Instr];
  }
  // externref -> f64: unbox number
  if (from.kind === "externref" && to.kind === "f64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      return [{ op: "call", funcIdx } as Instr];
    }
  }
  // ref_null -> ref: assert non-null
  if (from.kind === "ref_null" && to.kind === "ref") {
    return [{ op: "ref.as_non_null" } as Instr];
  }
  // ref/ref_null -> externref: extern.convert_any
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    return [{ op: "extern.convert_any" } as Instr];
  }
  return [];
}
