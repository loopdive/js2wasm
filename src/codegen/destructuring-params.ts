/**
 * Function parameter destructuring — object and array binding patterns.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { shiftLateImportIndices } from "./expressions/late-imports.js";
import { addUnionImports, ensureStructForType, resolveWasmType } from "./index.js";
import { addImport, addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  emitBoundsCheckedArrayGet,
  emitDefaultValueCheck,
  emitNestedBindingDefault,
  ensureBindingLocals,
  ensureLateImport,
  flushLateImportShifts,
  valTypesMatch,
} from "./shared.js";

function boxToExternref(ctx: CodegenContext, elemKey: string): Instr[] {
  if (elemKey === "externref") {
    // Already externref, just pass through
    return [];
  }
  if (elemKey === "f64") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      return [{ op: "call", funcIdx: boxIdx } as Instr];
    }
    // Fallback: drop and push null
    return [{ op: "drop" } as Instr, { op: "ref.null.extern" }];
  }
  if (elemKey === "i32") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      return [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxIdx } as Instr];
    }
    return [{ op: "drop" } as Instr, { op: "ref.null.extern" }];
  }
  // For ref types: extern.convert_any
  return [{ op: "extern.convert_any" } as Instr];
}

export function buildDestructureNullThrow(ctx: CodegenContext): Instr[] {
  const msg = "TypeError: Cannot destructure 'null' or 'undefined'";
  addStringConstantGlobal(ctx, msg);
  const strIdx = ctx.stringGlobalMap.get(msg)!;
  const tagIdx = ensureExnTag(ctx);
  return [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr];
}

/**
 * Destructure a function parameter (externref) using __extern_get for property access.
 * This handles primitives, objects, and any externref value safely — no struct cast needed.
 * Used as fallback when the value is not the expected struct type (#852).
 */
export function destructureParamObjectExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ObjectBindingPattern,
): void {
  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return;

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;

    const propNameNode = element.propertyName ?? element.name;
    let propNameText: string | undefined;
    if (ts.isIdentifier(propNameNode)) {
      propNameText = propNameNode.text;
    } else if (ts.isStringLiteral(propNameNode)) {
      propNameText = propNameNode.text;
    } else if (ts.isNumericLiteral(propNameNode)) {
      propNameText = propNameNode.text;
    }
    if (!propNameText) continue;

    addStringConstantGlobal(ctx, propNameText);
    const strGlobalIdx = ctx.stringGlobalMap.get(propNameText);
    if (strGlobalIdx === undefined) continue;

    getIdx = ctx.funcMap.get("__extern_get");
    if (getIdx === undefined) continue;

    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "global.get", index: strGlobalIdx });
    fctx.body.push({ op: "call", funcIdx: getIdx });

    const elemType: ValType = { kind: "externref" };

    if (ts.isIdentifier(element.name)) {
      const localName = element.name.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      const localType = getLocalType(fctx, localIdx);

      if (element.initializer) {
        const tmpElem = allocLocal(fctx, `__ext_dparam_dflt_${fctx.locals.length}`, elemType);
        fctx.body.push({ op: "local.tee", index: tmpElem });

        const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
        if (undefIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          getIdx = ctx.funcMap.get("__extern_get");
        }

        // Per JS spec, destructuring defaults apply ONLY when the value is `undefined`,
        // not when it is `null`. JS null maps to ref.null.extern (ref.is_null=1) and JS
        // undefined maps to a non-null externref wrapping undefined. We must use
        // __extern_is_undefined exclusively; using ref.is_null would wrongly trigger
        // defaults for null values (#1021).
        if (undefIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: undefIdx });
        } else {
          // Fallback: if the import couldn't be registered, use ref.is_null (imprecise —
          // treats null as undefined). Previously this was the default behavior.
          fctx.body.push({ op: "ref.is_null" } as Instr);
        }

        const savedBody = fctx.body;
        const thenInstrs: Instr[] = [];
        fctx.body = thenInstrs;
        compileExpression(ctx, fctx, element.initializer, localType ?? elemType);
        fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
        fctx.body = savedBody;

        const elseCoerce: Instr[] = [];
        if (localType && !valTypesMatch(elemType, localType)) {
          const savedBody2 = fctx.body;
          fctx.body = elseCoerce;
          coerceType(ctx, fctx, elemType, localType);
          fctx.body = savedBody2;
        }

        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: thenInstrs,
          else: [
            { op: "local.get", index: tmpElem } as Instr,
            ...elseCoerce,
            { op: "local.set", index: localIdx! } as Instr,
          ],
        });
      } else {
        if (localType && !valTypesMatch(elemType, localType)) {
          coerceType(ctx, fctx, elemType, localType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      const nestedLocal = allocLocal(fctx, `__ext_dparam_nested_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: nestedLocal });
      ensureBindingLocals(ctx, fctx, element.name);
      if (ts.isObjectBindingPattern(element.name)) {
        destructureParamObjectExternref(ctx, fctx, nestedLocal, element.name);
      } else {
        destructureParamArray(ctx, fctx, nestedLocal, element.name, elemType);
      }
    }
  }
}

/**
 * Emit a null/undefined check for an externref destructuring parameter.
 * Checks both ref.is_null (Wasm null) and __extern_is_undefined (JS undefined).
 * Throws TypeError if either is true.
 */
export function emitExternrefDestructureGuard(ctx: CodegenContext, fctx: FunctionContext, paramIdx: number): void {
  // Check ref.is_null first (handles null)
  fctx.body.push({ op: "local.get", index: paramIdx });
  fctx.body.push({ op: "ref.is_null" } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx), else: [] });

  // Also check JS undefined via __extern_is_undefined import
  const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  if (undefIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "call", funcIdx: undefIdx });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx), else: [] });
  }
}

/**
 * Destructure a function parameter that is an ObjectBindingPattern.
 * The parameter value (a struct ref) is at param index `paramIdx`.
 * We extract each bound field into a new local.
 */
export function destructureParamObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ObjectBindingPattern,
  paramType: ValType,
): void {
  if (paramType.kind !== "ref" && paramType.kind !== "ref_null") {
    // externref parameters: convert to struct ref before destructuring (#647)
    if (paramType.kind === "externref") {
      // Per JS spec: destructuring null/undefined must throw TypeError
      emitExternrefDestructureGuard(ctx, fctx, paramIdx);

      // Pre-allocate all binding locals so they exist regardless of path taken
      ensureBindingLocals(ctx, fctx, pattern);

      // If empty pattern ({}) — nothing to destructure after null guard (#852)
      if (pattern.elements.length === 0) return;

      const tsType = ctx.checker.getTypeAtLocation(pattern);
      let structTypeIdx: number | undefined;
      if (tsType) {
        ensureStructForType(ctx, tsType);
        const typeName = ctx.anonTypeMap.get(tsType) ?? tsType.getSymbol()?.name ?? tsType.aliasSymbol?.name;
        structTypeIdx = typeName ? ctx.structMap.get(typeName) : undefined;
      }

      if (structTypeIdx !== undefined) {
        // Use ref.test to check if the value is the expected struct (safe for primitives) (#852)
        const anyTmp = allocLocal(fctx, `__dparam_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "any.convert_extern" } as Instr);
        fctx.body.push({ op: "local.set", index: anyTmp });

        fctx.body.push({ op: "local.get", index: anyTmp });
        fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

        // Then branch: cast succeeds — use struct-based destructuring (fast path)
        const convertedType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
        const tmpLocal = allocLocal(fctx, `__dparam_cvt_${fctx.locals.length}`, convertedType);
        const thenInstrs: Instr[] = [];
        const savedBody = fctx.body;
        fctx.body = thenInstrs;
        fctx.body.push({ op: "local.get", index: anyTmp });
        fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
        fctx.body.push({ op: "local.set", index: tmpLocal });
        destructureParamObject(ctx, fctx, tmpLocal, pattern, convertedType);
        fctx.body = savedBody;

        // Else branch: cast would fail (primitive/different struct) — use __extern_get (#852)
        const elseInstrs: Instr[] = [];
        fctx.body = elseInstrs;
        destructureParamObjectExternref(ctx, fctx, paramIdx, pattern);
        fctx.body = savedBody;

        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs, else: elseInstrs });
      } else {
        // No struct type found — use __extern_get for all properties (#852)
        destructureParamObjectExternref(ctx, fctx, paramIdx, pattern);
      }
      return;
    }
    // Cannot destructure a non-ref type — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  const structTypeIdx = (paramType as { typeIdx: number }).typeIdx;

  // Find struct name and fields
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  if (!fields) {
    // Cannot find struct info — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  // Pre-allocate all binding locals so they exist even when param is null
  ensureBindingLocals(ctx, fctx, pattern);

  // Null guard: wrap destructuring in if-not-null for ref params.
  // Always treat as nullable — callers may pass mismatched values that
  // compile to ref.null even when the declared type is non-nullable ref (#852).
  const isNullable = paramType.kind === "ref_null" || paramType.kind === "ref";
  const savedBody = fctx.body;
  const destructInstrs: Instr[] = [];
  if (isNullable) {
    fctx.body = destructInstrs;
  }

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    const propName = (element.propertyName ?? element.name) as ts.Identifier;
    if (!ts.isIdentifier(element.name)) {
      // Nested pattern — recurse
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        const fieldIdx = fields.findIndex((f) => f.name === propName.text);
        if (fieldIdx === -1) continue;
        const fieldType = fields[fieldIdx]!.type;
        const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpLocal });
        // Handle default initializer for nested object destructuring (#794)
        if (element.initializer) {
          (ctx as any)._arrayLiteralForceVec = true;
          try {
            emitNestedBindingDefault(ctx, fctx, tmpLocal, fieldType, element.initializer);
          } finally {
            (ctx as any)._arrayLiteralForceVec = false;
          }
        }
        if (ts.isObjectBindingPattern(element.name)) {
          destructureParamObject(ctx, fctx, tmpLocal, element.name, fieldType);
        } else {
          destructureParamArray(ctx, fctx, tmpLocal, element.name, fieldType);
        }
      }
      continue;
    }
    const localName = element.name.text;
    const fieldIdx = fields.findIndex((f) => f.name === propName.text);
    if (fieldIdx === -1) {
      // Field not in struct — already pre-allocated by ensureBindingLocals
      continue;
    }
    const fieldType = fields[fieldIdx]!.type;
    // Only allocate if not already pre-allocated by ensureBindingLocals
    if (!fctx.localMap.has(localName)) {
      allocLocal(fctx, localName, fieldType);
    }
    const localIdx = fctx.localMap.get(localName)!;
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    // Handle default value: `function f({ x = defaultVal }: ...) {}`
    // When the struct field holds the "undefined" sentinel (NaN for f64,
    // ref.null for refs), evaluate the initializer instead. (#823)
    if (element.initializer) {
      emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
    } else {
      // Coerce struct field type to local's declared type if they differ (#658)
      const objLocalType = getLocalType(fctx, localIdx);
      if (objLocalType && !valTypesMatch(fieldType, objLocalType)) {
        coerceType(ctx, fctx, fieldType, objLocalType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // Close null guard — throw TypeError when null (JS spec: destructuring null/undefined is TypeError)
  if (isNullable) {
    fctx.body = savedBody;
    if (destructInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildDestructureNullThrow(ctx),
        else: destructInstrs,
      });
    }
  }
}

/**
 * Destructure a function parameter that is an ArrayBindingPattern.
 * The parameter value (a vec struct ref) is at param index `paramIdx`.
 * We extract each element into a new local.
 */
export function destructureParamArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ArrayBindingPattern,
  paramType: ValType,
): void {
  if (paramType.kind !== "ref" && paramType.kind !== "ref_null") {
    // externref parameters: convert to vec struct before destructuring (#647)
    // The externref may wrap any vec type at runtime (e.g. __vec_f64 from [1,2,3]
    // or __vec_externref from untyped arrays). We convert to __vec_externref
    // since that's what the rest of the code expects for untyped patterns.
    if (paramType.kind === "externref") {
      // Per JS spec: destructuring null/undefined must throw TypeError
      emitExternrefDestructureGuard(ctx, fctx, paramIdx);

      const extVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      const extArrTypeIdx = getArrTypeIdxFromVec(ctx, extVecIdx);
      const convertedType: ValType = { kind: "ref_null", typeIdx: extVecIdx };
      const resultLocal = allocLocal(fctx, `__dparam_cvt_${fctx.locals.length}`, convertedType);

      // Convert externref -> anyref
      const anyTmp = allocLocal(fctx, `__dparam_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "local.set", index: anyTmp });

      // Try direct cast to __vec_externref first (cheapest path)
      fctx.body.push({ op: "local.get", index: anyTmp });
      fctx.body.push({ op: "ref.test", typeIdx: extVecIdx });

      const directCastInstrs: Instr[] = [
        { op: "local.get", index: anyTmp } as Instr,
        { op: "ref.cast", typeIdx: extVecIdx },
        { op: "local.set", index: resultLocal } as Instr,
      ];

      // Else: try each other known vec type and convert element-by-element
      const convertInstrs: Instr[] = [];
      for (const [key, vecIdx] of ctx.vecTypeMap) {
        if (vecIdx === extVecIdx) continue; // already handled
        const vecDef = ctx.mod.types[vecIdx];
        if (!vecDef || vecDef.kind !== "struct") continue;
        const dataField = vecDef.fields[1];
        if (!dataField || dataField.name !== "data") continue;
        const srcArrTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;

        const cvtTmp = allocLocal(fctx, `__dparam_src_${key}_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: vecIdx,
        });
        const lenTmp = allocLocal(fctx, `__dparam_len_${key}_${fctx.locals.length}`, { kind: "i32" });
        const dstArrTmp = allocLocal(fctx, `__dparam_darr_${key}_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: extArrTypeIdx,
        });
        const idxTmp = allocLocal(fctx, `__dparam_idx_${key}_${fctx.locals.length}`, { kind: "i32" });

        const thenInstrs: Instr[] = [
          // Cast and get length
          { op: "local.get", index: anyTmp } as Instr,
          { op: "ref.cast", typeIdx: vecIdx },
          { op: "local.set", index: cvtTmp } as Instr,
          { op: "local.get", index: cvtTmp } as Instr,
          { op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 } as Instr, // length
          { op: "local.set", index: lenTmp } as Instr,
          // Create new externref array
          { op: "local.get", index: lenTmp } as Instr,
          { op: "array.new_default", typeIdx: extArrTypeIdx },
          { op: "local.set", index: dstArrTmp } as Instr,
          // Loop: copy elements with boxing
          { op: "i32.const", value: 0 } as Instr,
          { op: "local.set", index: idxTmp } as Instr,
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if idx >= len, break
                  { op: "local.get", index: idxTmp } as Instr,
                  { op: "local.get", index: lenTmp } as Instr,
                  { op: "i32.ge_s" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  // dstArr[idx] = extern.convert_any(srcArr[idx])
                  { op: "local.get", index: dstArrTmp } as Instr,
                  { op: "local.get", index: idxTmp } as Instr,
                  { op: "local.get", index: cvtTmp } as Instr,
                  { op: "struct.get", typeIdx: vecIdx, fieldIdx: 1 } as Instr, // src data
                  { op: "local.get", index: idxTmp } as Instr,
                  { op: "array.get", typeIdx: srcArrTypeIdx } as Instr,
                  // Box primitive types before storing as externref
                  ...boxToExternref(ctx, key),
                  { op: "array.set", typeIdx: extArrTypeIdx } as Instr,
                  // idx++
                  { op: "local.get", index: idxTmp } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.set", index: idxTmp } as Instr,
                  { op: "br", depth: 0 } as Instr,
                ],
              } as Instr,
            ],
          } as Instr,
          // Create __vec_externref: struct.new(len, dstArr)
          { op: "local.get", index: lenTmp } as Instr,
          { op: "local.get", index: dstArrTmp } as Instr,
          { op: "struct.new", typeIdx: extVecIdx },
          { op: "local.set", index: resultLocal } as Instr,
        ];

        convertInstrs.push({ op: "local.get", index: anyTmp } as Instr);
        convertInstrs.push({ op: "ref.test", typeIdx: vecIdx });
        convertInstrs.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs, else: [] } as Instr);
      }

      // Fallback: if no Wasm vec type matched, the externref is a plain JS array/iterable.
      // Use __extern_length + __extern_get_idx host imports to build a vec_externref. (#825)
      {
        const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        const getIdxFn = ensureLateImport(
          ctx,
          "__extern_get_idx",
          [{ kind: "externref" }, { kind: "f64" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);

        if (lenFn !== undefined && getIdxFn !== undefined) {
          const fbLenTmp = allocLocal(fctx, `__dparam_fb_len_${fctx.locals.length}`, { kind: "i32" });
          const fbArrTmp = allocLocal(fctx, `__dparam_fb_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: extArrTypeIdx,
          });
          const fbIdxTmp = allocLocal(fctx, `__dparam_fb_idx_${fctx.locals.length}`, { kind: "i32" });

          const fallbackInstrs: Instr[] = [
            // len = i32(__extern_length(param))
            { op: "local.get", index: paramIdx } as Instr,
            { op: "call", funcIdx: lenFn } as Instr,
            { op: "i32.trunc_sat_f64_s" } as unknown as Instr,
            { op: "local.set", index: fbLenTmp } as Instr,
            // arr = array.new_default(len)
            { op: "local.get", index: fbLenTmp } as Instr,
            { op: "array.new_default", typeIdx: extArrTypeIdx },
            { op: "local.set", index: fbArrTmp } as Instr,
            // idx = 0
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.set", index: fbIdxTmp } as Instr,
            // loop: copy elements
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    // if idx >= len, break
                    { op: "local.get", index: fbIdxTmp } as Instr,
                    { op: "local.get", index: fbLenTmp } as Instr,
                    { op: "i32.ge_s" } as Instr,
                    { op: "br_if", depth: 1 } as Instr,
                    // arr[idx] = __extern_get_idx(param, f64(idx))
                    { op: "local.get", index: fbArrTmp } as Instr,
                    { op: "local.get", index: fbIdxTmp } as Instr,
                    { op: "local.get", index: paramIdx } as Instr,
                    { op: "local.get", index: fbIdxTmp } as Instr,
                    { op: "f64.convert_i32_s" } as Instr,
                    { op: "call", funcIdx: getIdxFn } as Instr,
                    { op: "array.set", typeIdx: extArrTypeIdx } as Instr,
                    // idx++
                    { op: "local.get", index: fbIdxTmp } as Instr,
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "i32.add" } as Instr,
                    { op: "local.set", index: fbIdxTmp } as Instr,
                    { op: "br", depth: 0 } as Instr,
                  ],
                } as Instr,
              ],
            } as Instr,
            // Build vec_externref: struct.new(len, arr)
            { op: "local.get", index: fbLenTmp } as Instr,
            { op: "local.get", index: fbArrTmp } as Instr,
            { op: "struct.new", typeIdx: extVecIdx },
            { op: "local.set", index: resultLocal } as Instr,
          ];

          // Only run fallback if resultLocal is still null (no vec type matched)
          convertInstrs.push({ op: "local.get", index: resultLocal } as Instr);
          convertInstrs.push({ op: "ref.is_null" } as Instr);
          convertInstrs.push({
            op: "if",
            blockType: { kind: "empty" },
            then: fallbackInstrs,
            else: [],
          } as Instr);
        }
      }

      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: directCastInstrs,
        else: convertInstrs,
      });

      // Now destructure from the converted vec_externref
      destructureParamArray(ctx, fctx, resultLocal, pattern, convertedType);
      return;
    }
    // Cannot destructure a non-ref type — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier((element as ts.BindingElement).name)) {
        const name = ((element as ts.BindingElement).name as ts.Identifier).text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  const vecTypeIdx = (paramType as { typeIdx: number }).typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    // Not a vec array — check if it's a tuple struct (fields named _0, _1, ...)
    const tupleDef = ctx.mod.types[vecTypeIdx];
    if (tupleDef && tupleDef.kind === "struct" && tupleDef.fields.length > 0 && tupleDef.fields[0]!.name === "_0") {
      // Tuple struct destructuring: extract positional fields via struct.get
      // Always treat as nullable — callers may pass empty/mismatched arrays that
      // compile to ref.null even when the declared type is non-nullable ref (#852).
      const isNullable = paramType.kind === "ref_null" || paramType.kind === "ref";

      // Pre-allocate all binding locals
      ensureBindingLocals(ctx, fctx, pattern);

      const savedBody = fctx.body;
      const destructInstrs: Instr[] = [];
      if (isNullable) {
        fctx.body = destructInstrs;
      }

      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;
        if (i >= tupleDef.fields.length) break; // more bindings than tuple fields

        const fieldType = tupleDef.fields[i]!.type;

        // Handle nested binding patterns
        if (
          ts.isBindingElement(element) &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
        ) {
          const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: i });
          fctx.body.push({ op: "local.set", index: tmpLocal });
          // Handle default initializer for tuple destructuring (#794)
          if (element.initializer) {
            (ctx as any)._arrayLiteralForceVec = true;
            try {
              emitNestedBindingDefault(ctx, fctx, tmpLocal, fieldType, element.initializer);
            } finally {
              (ctx as any)._arrayLiteralForceVec = false;
            }
          }
          if (ts.isObjectBindingPattern(element.name)) {
            destructureParamObject(ctx, fctx, tmpLocal, element.name, fieldType);
          } else {
            destructureParamArray(ctx, fctx, tmpLocal, element.name, fieldType);
          }
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        if (!fctx.localMap.has(localName)) {
          allocLocal(fctx, localName, fieldType);
        }
        const localIdx = fctx.localMap.get(localName)!;
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: i });
        // Coerce struct field type to local's declared type if they differ (#658)
        const localType = getLocalType(fctx, localIdx);
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });

        // Handle element-level default initializer (e.g. [x = 23] in destructuring)
        if (ts.isBindingElement(element) && element.initializer) {
          const effType = localType || fieldType;
          emitNestedBindingDefault(ctx, fctx, localIdx, effType, element.initializer);
        }
      }

      // Close null guard — throw TypeError when null (JS spec)
      if (isNullable) {
        fctx.body = savedBody;
        if (destructInstrs.length > 0) {
          // When param is null (e.g. empty array cast failed), apply element defaults
          const nullDefaultInstrs: Instr[] = [];
          for (const element of pattern.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (!ts.isBindingElement(element) || !element.initializer) continue;
            if (!ts.isIdentifier(element.name)) continue;
            const localName = element.name.text;
            const localIdx = fctx.localMap.get(localName);
            if (localIdx === undefined) continue;
            const localType = getLocalType(fctx, localIdx);
            if (!localType) continue;
            // Compile the default value into the null-path
            const prevBody = fctx.body;
            fctx.body = nullDefaultInstrs;
            compileExpression(ctx, fctx, element.initializer, localType);
            fctx.body.push({ op: "local.set", index: localIdx });
            fctx.body = prevBody;
          }
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: nullDefaultInstrs.length > 0 ? nullDefaultInstrs : buildDestructureNullThrow(ctx),
            else: destructInstrs,
          });
        }
      }
      return;
    }

    // Not an array and not a tuple — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier((element as ts.BindingElement).name)) {
        const name = ((element as ts.BindingElement).name as ts.Identifier).text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          allocLocal(fctx, name, resolveWasmType(ctx, elemType));
        }
      }
    }
    return;
  }

  const elemType = arrDef.element;

  // Pre-allocate all binding locals so they exist even when param is null
  ensureBindingLocals(ctx, fctx, pattern);

  // Null guard: wrap destructuring in if-not-null for ref params.
  // Always treat as nullable — callers may pass empty/mismatched arrays that
  // compile to ref.null even when the declared type is non-nullable ref (#852).
  const isNullable = paramType.kind === "ref_null" || paramType.kind === "ref";
  const savedBody = fctx.body;
  const destructInstrs: Instr[] = [];
  if (isNullable) {
    fctx.body = destructInstrs;
  }

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Handle nested binding patterns
    if (
      ts.isBindingElement(element) &&
      (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
    ) {
      const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);
      fctx.body.push({ op: "local.set", index: tmpLocal });
      // Handle default initializer: [[x, y] = [4, 5]] — use default when element is null/undefined (#794)
      if (element.initializer) {
        (ctx as any)._arrayLiteralForceVec = true;
        try {
          emitNestedBindingDefault(ctx, fctx, tmpLocal, elemType, element.initializer);
        } finally {
          (ctx as any)._arrayLiteralForceVec = false;
        }
      }
      if (ts.isObjectBindingPattern(element.name)) {
        destructureParamObject(ctx, fctx, tmpLocal, element.name, elemType);
      } else {
        destructureParamArray(ctx, fctx, tmpLocal, element.name, elemType);
      }
      continue;
    }

    // Handle rest element: function([a, ...rest])
    if (element.dotDotDotToken) {
      // Compute rest length: max(0, param.length - i)
      const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
      // First compute len - i and store it
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // length
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "i32.sub" } as Instr);
      fctx.body.push({ op: "local.set", index: restLenLocal });
      // Clamp to 0 if negative: select(0, len-i, len-i < 0)
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "i32.lt_s" } as Instr);
      fctx.body.push({ op: "select" } as Instr);
      fctx.body.push({ op: "local.set", index: restLenLocal });

      // Create new data array: array.new_default(restLen)
      const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
      fctx.body.push({ op: "local.set", index: restArrLocal });

      // array.copy(restArr, 0, srcData, i, restLen)
      fctx.body.push({ op: "local.get", index: restArrLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // src data
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

      // Create new vec struct: struct.new(restLen, restArr)
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "local.get", index: restArrLocal });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx } as Instr);

      if (ts.isIdentifier(element.name)) {
        const restName = element.name.text;
        // Only allocate if not already pre-allocated by ensureBindingLocals
        if (!fctx.localMap.has(restName)) {
          allocLocal(fctx, restName, paramType);
        } else {
          // ensureBindingLocals may have pre-allocated with a different vec type
          // (e.g. vec_f64 from TS type inference) while the externref conversion
          // path produces vec_externref. Reallocate with the correct type (#971).
          const existingIdx = fctx.localMap.get(restName)!;
          const slotIdx = existingIdx - fctx.params.length;
          if (slotIdx >= 0) {
            const slot = fctx.locals[slotIdx];
            if (slot && !valTypesMatch(slot.type, paramType)) {
              allocLocal(fctx, restName, paramType);
            }
          }
        }
        const restLocal = fctx.localMap.get(restName)!;
        fctx.body.push({ op: "local.set", index: restLocal });
      } else if (ts.isArrayBindingPattern(element.name)) {
        // Nested rest with array pattern: function([...[a, b]])
        const nestedTmpLocal = allocLocal(fctx, `__rest_nested_${fctx.locals.length}`, paramType);
        fctx.body.push({ op: "local.set", index: nestedTmpLocal });
        destructureParamArray(ctx, fctx, nestedTmpLocal, element.name, paramType);
      } else {
        // Unsupported pattern — just drop the struct
        fctx.body.push({ op: "drop" });
      }
      continue;
    }

    if (!ts.isIdentifier(element.name)) continue;
    const localName = element.name.text;
    // Only allocate if not already pre-allocated by ensureBindingLocals
    if (!fctx.localMap.has(localName)) {
      allocLocal(fctx, localName, elemType);
    }
    const localIdx = fctx.localMap.get(localName)!;
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "i32.const", value: i });
    emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);
    // Handle default initializer: [x = 23] — use default when element is null/undefined
    if (element.initializer) {
      const dfltTmpLocal = allocLocal(fctx, `__dparam_dflt_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: dfltTmpLocal });
      emitNestedBindingDefault(ctx, fctx, dfltTmpLocal, elemType, element.initializer);
      fctx.body.push({ op: "local.get", index: dfltTmpLocal });
    }
    // Coerce array element type to local's declared type if they differ (#658)
    const vecLocalType = getLocalType(fctx, localIdx);
    if (vecLocalType && !valTypesMatch(elemType, vecLocalType)) {
      coerceType(ctx, fctx, elemType, vecLocalType);
    }
    fctx.body.push({ op: "local.set", index: localIdx });
  }

  // Close null guard — throw TypeError when null (JS spec)
  if (isNullable) {
    fctx.body = savedBody;
    if (destructInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildDestructureNullThrow(ctx),
        else: destructInstrs,
      });
    }
  }
}

/**
 * Cache string literal thunk calls in locals for the given function.
 *
 * After a function body has been compiled, this scans all instructions
 * (including nested blocks/loops/ifs) for `call` instructions that invoke
 * string literal thunks (__str_N).  For each unique thunk found it:
 *   1. Allocates an `externref` local to hold the cached value.
 *   2. Prepends `call $__str_N` + `local.set $cached` at function entry.
 *   3. Replaces every matching `call` in the body with `local.get $cached`.
 *
 * This avoids repeated import calls for the same string literal, which is
 * especially beneficial inside loops.
 */
