// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
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
import { buildVecFromExternref, getVecInfo } from "./type-coercion.js";

/**
 * Bounds-checked array.get that returns JS `undefined` (via __get_undefined)
 * for out-of-bounds indices on externref arrays, instead of ref.null.extern.
 * This is critical for destructuring defaults: per ES spec, accessing an array
 * index beyond its length produces `undefined` (which triggers defaults), NOT
 * `null` (which does not).  (#1016a)
 *
 * Stack: [arrayref, i32 index]  →  [externref element or __get_undefined()]
 * Falls through to regular emitBoundsCheckedArrayGet for non-externref types.
 */
function emitBoundsCheckedArrayGetUndef(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
): void {
  if (elementType.kind !== "externref" && elementType.kind !== "ref_extern") {
    emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType);
    return;
  }
  const getUndefIdx = ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
  if (getUndefIdx === undefined) {
    // standalone mode — can't get JS undefined, fall back to regular path
    emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType);
    return;
  }
  flushLateImportShifts(ctx, fctx);

  // Save index and array ref to locals
  const idxLocal = allocLocal(fctx, `__undef_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__undef_arr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: idxLocal }); // save index
  fctx.body.push({ op: "local.set", index: arrLocal }); // save array ref

  // Condition: (unsigned)idx < array.len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: arrLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "local.get", index: idxLocal } as Instr,
      { op: "array.get", typeIdx: arrTypeIdx } as Instr,
    ],
    else: [{ op: "call", funcIdx: getUndefIdx } as Instr],
  });
}

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

export function buildDestructureNullThrow(ctx: CodegenContext, fctx?: FunctionContext): Instr[] {
  const msg = "Cannot destructure 'null' or 'undefined'";
  addStringConstantGlobal(ctx, msg);
  const strIdx = ctx.stringGlobalMap.get(msg)!;
  // Prefer host import so caller sees a genuine JS TypeError (constructor-matching
  // tests such as `({constructor}) => constructor === TypeError` pass). Fall back
  // to wasm throw+tag when a FunctionContext isn't available for late-import flush.
  const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
  if (throwIdx !== undefined && fctx) {
    flushLateImportShifts(ctx, fctx);
    const funcIdx = ctx.funcMap.get("__throw_type_error")!;
    return [
      { op: "global.get", index: strIdx } as Instr,
      { op: "call", funcIdx } as Instr,
      { op: "unreachable" } as Instr,
    ];
  }
  const tagIdx = ensureExnTag(ctx);
  return [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr];
}

/**
 * Returns true when `expr` is a literal `null` or `undefined` — which per spec
 * must throw TypeError when used as the source value for a destructuring pattern
 * (RequireObjectCoercible / GetIterator).
 *
 * Used by parameter default-emission to statically reject `({pat} = null)` and
 * `({pat} = undefined)` even when paramType is numeric (loses null/undef info).
 */
export function isNullOrUndefinedLiteral(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  if (expr.kind === ts.SyntaxKind.VoidExpression) {
    const v = expr as ts.VoidExpression;
    return ts.isNumericLiteral(v.expression);
  }
  return false;
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

  const excludedKeys: string[] = [];
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
    const pn = element.propertyName ?? element.name;
    if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
    else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
    else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
  }

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;

    if (element.dotDotDotToken) {
      if (!ts.isIdentifier(element.name)) continue;
      const restName = element.name.text;
      let restIdx = fctx.localMap.get(restName);
      if (restIdx === undefined) {
        restIdx = allocLocal(fctx, restName, { kind: "externref" });
      }
      let restObjIdx = ctx.funcMap.get("__extern_rest_object");
      if (restObjIdx === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const restObjType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        restObjIdx = ctx.funcMap.get("__extern_rest_object");
        getIdx = ctx.funcMap.get("__extern_get");
      }
      if (restObjIdx === undefined) continue;
      const excludedStr = excludedKeys.join(",");
      addStringConstantGlobal(ctx, excludedStr);
      const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
      if (excludedStrIdx === undefined) continue;
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "global.get", index: excludedStrIdx });
      fctx.body.push({ op: "call", funcIdx: restObjIdx });
      fctx.body.push({ op: "local.set", index: restIdx });
      continue;
    }

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
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx, fctx), else: [] });

  // Also check JS undefined via __extern_is_undefined import
  const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  if (undefIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "call", funcIdx: undefIdx });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx, fctx), else: [] });
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
      // Patterns with a rest element (`{...x}`) cannot use the struct-ref fast
      // path — struct.get only exposes known fields, but spec-compliant rest
      // must enumerate every own property (including getters, accessors).
      // Always route through __extern_rest_object for rest patterns.
      const hasRestElement = pattern.elements.some((e) => ts.isBindingElement(e) && !!e.dotDotDotToken);
      if (hasRestElement) structTypeIdx = undefined;

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

  // Close null guard — throw TypeError when null (JS spec: destructuring null/undefined is TypeError).
  // Skip for empty `{}` patterns (#225): the guard should only fire when there are
  // actual property accesses that would trap.
  if (isNullable && pattern.elements.length > 0) {
    fctx.body = savedBody;
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildDestructureNullThrow(ctx, fctx),
      else: destructInstrs,
    });
  } else if (isNullable) {
    fctx.body = savedBody;
    fctx.body.push(...destructInstrs);
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

      // Tuple-struct fast path (#862): if the externref wraps a known Wasm-native
      // tuple struct (fields named _0, _1, …), destructure directly via
      // struct.get instead of routing through __array_from_iter / boxing — which
      // would convert typed numeric fields to externref and then silently back
      // to NaN when assigned to f64 locals (PR #255 regression pattern).
      //
      // The sentinel `__dparam_done` is set to 1 if the fast path fires; the
      // existing externref logic below is gated on it being 0.
      const dstrDoneLocal = allocLocal(fctx, `__dparam_done_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "local.set", index: dstrDoneLocal });

      for (let ti = 0; ti < ctx.mod.types.length; ti++) {
        const def = ctx.mod.types[ti];
        if (!def || def.kind !== "struct") continue;
        if (def.fields.length === 0) continue;
        // Tuple struct detection: fields must be named _0, _1, _2, ...
        let isTuple = true;
        for (let fi = 0; fi < def.fields.length; fi++) {
          if (def.fields[fi]!.name !== `_${fi}`) {
            isTuple = false;
            break;
          }
        }
        if (!isTuple) continue;
        // Only match when the tuple has at least as many fields as the pattern
        // consumes — fewer fields can't fulfill the binding element count.
        if (def.fields.length < pattern.elements.length) continue;

        const tupType: ValType = { kind: "ref_null", typeIdx: ti };
        const tupleLocal = allocLocal(fctx, `__dparam_tup_${ti}_${fctx.locals.length}`, tupType);

        // Build the fast-path body by swapping fctx.body so a recursive
        // destructureParamArray call emits into the conditional branch instead
        // of the outer function.
        const savedBody = fctx.body;
        const fastPathInstrs: Instr[] = [];
        fctx.body = fastPathInstrs;
        fctx.body.push({ op: "local.get", index: anyTmp } as Instr);
        fctx.body.push({ op: "ref.cast", typeIdx: ti });
        fctx.body.push({ op: "local.set", index: tupleLocal });
        destructureParamArray(ctx, fctx, tupleLocal, pattern, tupType);
        fctx.body.push({ op: "i32.const", value: 1 } as Instr);
        fctx.body.push({ op: "local.set", index: dstrDoneLocal });
        fctx.body = savedBody;

        // Gate on dstrDone == 0 so later tuple-struct checks (and the main
        // externref logic below) don't re-run once one match has succeeded.
        const testInstrs: Instr[] = [
          { op: "local.get", index: anyTmp } as Instr,
          { op: "ref.test", typeIdx: ti } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: fastPathInstrs,
            else: [],
          } as Instr,
        ];

        fctx.body.push({ op: "local.get", index: dstrDoneLocal } as Instr);
        fctx.body.push({ op: "i32.eqz" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: testInstrs,
          else: [],
        } as Instr);
      }

      // Gate the existing externref→vec conversion + iter fallback logic on
      // dstrDone == 0. If the fast path already destructured, skip all of it.
      // We redirect fctx.body to a buffer; after the existing code finishes, we
      // wrap the buffer in `if dstrDone == 0 { ... }` and append to the real body.
      const externrefLegacyBody: Instr[] = [];
      const realBody = fctx.body;
      fctx.body = externrefLegacyBody;

      // Try direct cast to __vec_externref first (cheapest path)
      fctx.body.push({ op: "local.get", index: anyTmp });
      fctx.body.push({ op: "ref.test", typeIdx: extVecIdx });

      const directCastInstrs: Instr[] = [
        { op: "local.get", index: anyTmp } as Instr,
        { op: "ref.cast", typeIdx: extVecIdx },
        { op: "local.set", index: resultLocal } as Instr,
      ];

      // Pre-register fallback host imports BEFORE building convertInstrs, so that
      // any function index shifts from late imports are visible to boxToExternref
      // calls inside the vec-type conversion loop below. (#825)
      const fbLenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      const fbGetIdxFn = ensureLateImport(
        ctx,
        "__extern_get_idx",
        [{ kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      // __array_from_iter materializes iterables (generators, sets, custom @@iterator)
      // via Array.from so __extern_length / __extern_get_idx operate on a real array.
      // Throws from iterator .next() propagate (spec-compliant for throwing iterators, #1150).
      const fbIterFn = ensureLateImport(ctx, "__array_from_iter", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);

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
      // Materialize via Array.from first so iterator protocol runs (generators, custom
      // @@iterator); then walk with __extern_length + __extern_get_idx. (#825, #1150)
      if (fbLenFn !== undefined && fbGetIdxFn !== undefined && fbIterFn !== undefined) {
        const fbMatTmp = allocLocal(fctx, `__dparam_fb_mat_${fctx.locals.length}`, { kind: "externref" });
        const fbLenTmp = allocLocal(fctx, `__dparam_fb_len_${fctx.locals.length}`, { kind: "i32" });
        const fbArrTmp = allocLocal(fctx, `__dparam_fb_arr_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: extArrTypeIdx,
        });
        const fbIdxTmp = allocLocal(fctx, `__dparam_fb_idx_${fctx.locals.length}`, { kind: "i32" });

        const fallbackInstrs: Instr[] = [
          // materialized = __array_from_iter(param) — throws from iterator .next() propagate
          { op: "local.get", index: paramIdx } as Instr,
          { op: "call", funcIdx: fbIterFn } as Instr,
          { op: "local.set", index: fbMatTmp } as Instr,
          // len = i32(__extern_length(materialized))
          { op: "local.get", index: fbMatTmp } as Instr,
          { op: "call", funcIdx: fbLenFn } as Instr,
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
                  // arr[idx] = __extern_get_idx(materialized, f64(idx))
                  { op: "local.get", index: fbArrTmp } as Instr,
                  { op: "local.get", index: fbIdxTmp } as Instr,
                  { op: "local.get", index: fbMatTmp } as Instr,
                  { op: "local.get", index: fbIdxTmp } as Instr,
                  { op: "f64.convert_i32_s" } as Instr,
                  { op: "call", funcIdx: fbGetIdxFn } as Instr,
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

      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: directCastInstrs,
        else: convertInstrs,
      });

      // Fallback: if none of the known vec types matched, treat the externref
      // as a JS array/iterable and build a fresh __vec_externref from it via
      // __extern_length/__extern_get. Unblocks Wasm-to-Wasm rest-destructuring
      // after setExports — __make_iterable unconditionally converts vec structs
      // to JS arrays at the call boundary, which would otherwise trap here (#1135).
      const extVecInfo = getVecInfo(ctx, extVecIdx);
      if (extVecInfo) {
        const fallbackInstrs = buildVecFromExternref(ctx, fctx, paramIdx, extVecIdx, extVecInfo);
        fctx.body.push({ op: "local.get", index: resultLocal } as Instr);
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...fallbackInstrs, { op: "local.set", index: resultLocal } as Instr],
          else: [],
        } as Instr);
      }

      // Now destructure from the converted vec_externref.
      destructureParamArray(ctx, fctx, resultLocal, pattern, convertedType);

      // Close the #862 tuple-struct fast-path gate: wrap everything since the
      // dstrDone sentinel was initialised in `if dstrDone == 0 { ... }` and
      // splice back into the real body.
      fctx.body = realBody;
      fctx.body.push({ op: "local.get", index: dstrDoneLocal } as Instr);
      fctx.body.push({ op: "i32.eqz" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: externrefLegacyBody,
        else: [],
      } as Instr);
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
            then: nullDefaultInstrs.length > 0 ? nullDefaultInstrs : buildDestructureNullThrow(ctx, fctx),
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
    // Skip rest elements (dotDotDotToken) — those are handled below so the
    // rest vec is built before recursing into the nested pattern (e.g. [...[...x]]).
    if (
      ts.isBindingElement(element) &&
      !element.dotDotDotToken &&
      (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
    ) {
      const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemType); // #1016a
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
        // The freshly-created struct is a non-null vec matching the outer vec type.
        const nestedType: ValType = { kind: "ref", typeIdx: vecTypeIdx };
        const nestedTmpLocal = allocLocal(fctx, `__rest_nested_${fctx.locals.length}`, nestedType);
        fctx.body.push({ op: "local.set", index: nestedTmpLocal });
        destructureParamArray(ctx, fctx, nestedTmpLocal, element.name, nestedType);
      } else if (ts.isObjectBindingPattern(element.name)) {
        // Nested rest with object pattern: function([...{length}]) or [...{0:v}]
        // The rest array is array-like: destructure "length" from vec field 0
        // and numeric properties via vec's data array. destructureParamObject
        // on the vec type only knows "length" and "data" — numeric keys would
        // be skipped. Emit property access inline to cover both shapes.
        const nestedType: ValType = { kind: "ref", typeIdx: vecTypeIdx };
        const nestedTmpLocal = allocLocal(fctx, `__rest_nested_${fctx.locals.length}`, nestedType);
        fctx.body.push({ op: "local.set", index: nestedTmpLocal });
        ensureBindingLocals(ctx, fctx, element.name);
        for (const nested of element.name.elements) {
          if (!ts.isBindingElement(nested)) continue;
          if (nested.dotDotDotToken) continue;
          if (!ts.isIdentifier(nested.name)) continue;
          const propNode = nested.propertyName ?? nested.name;
          let key: string | undefined;
          if (ts.isIdentifier(propNode)) key = propNode.text;
          else if (ts.isStringLiteral(propNode)) key = propNode.text;
          else if (ts.isNumericLiteral(propNode)) key = propNode.text;
          if (key === undefined) continue;
          const localName = nested.name.text;
          const localIdx = fctx.localMap.get(localName);
          if (localIdx === undefined) continue;
          const localType = getLocalType(fctx, localIdx);
          if (!localType) continue;
          if (key === "length") {
            fctx.body.push({ op: "local.get", index: nestedTmpLocal });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            coerceType(ctx, fctx, { kind: "i32" }, localType);
            fctx.body.push({ op: "local.set", index: localIdx });
            continue;
          }
          const numKey = Number(key);
          if (Number.isInteger(numKey) && numKey >= 0 && String(numKey) === key) {
            const arrDef = ctx.mod.types[arrTypeIdx];
            const elemWasmType =
              arrDef && arrDef.kind === "array" ? arrDef.element : ({ kind: "externref" } as ValType);
            fctx.body.push({ op: "local.get", index: nestedTmpLocal });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
            fctx.body.push({ op: "i32.const", value: numKey });
            emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemWasmType);
            coerceType(ctx, fctx, elemWasmType, localType);
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        }
      } else {
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
    emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemType); // #1016a
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
  // Skip for empty `[]` patterns (#225).
  if (isNullable) {
    fctx.body = savedBody;
    if (destructInstrs.length > 0 && pattern.elements.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildDestructureNullThrow(ctx, fctx),
        else: destructInstrs,
      });
    } else if (destructInstrs.length > 0) {
      fctx.body.push(...destructInstrs);
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
