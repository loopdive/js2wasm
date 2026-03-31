/**
 * Property access and element access codegen.
 *
 * Extracted from expressions.ts to keep concerns separated.
 * Contains: compilePropertyAccess, compileElementAccess, null-guard helpers,
 * bounds-checked array access, and related utilities.
 */

import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import {
  allocLocal,
  allocTempLocal,
  releaseTempLocal,
  resolveWasmType,
  addUnionImports,
  addStringConstantGlobal,
  getArrTypeIdxFromVec,
  localGlobalIdx,
  getOrRegisterVecType,
  pushBody,
  popBody,
  ensureExnTag,
} from "./index.js";
import { isStringType, isExternalDeclaredClass, isIteratorResultType } from "../checker/type-mapper.js";
import type { Instr, ValType, FieldDef } from "../ir/types.js";
import { coercionInstrs, defaultValueInstrs } from "./type-coercion.js";
import { compileExpression, valTypesMatch, getLine, getCol, resolveThisStructName } from "./shared.js";
import {
  coerceType,
  compileStringLiteral,
  compileSuperPropertyAccess,
  compileSuperElementAccess,
  emitLazyProtoGet,
  resolveStructName,
  isGeneratorIteratorResultLike,
  getIteratorResultValueType,
  findExternInfoForMember,
  patchStructNewForAddedField,
  ensureLateImport,
  flushLateImportShifts,
  resolveComputedKeyExpression,
  getWellKnownSymbolId,
} from "./expressions.js";
import { emitBoundsCheckedArrayGet, emitClampIndex, emitClampNonNeg } from "./array-methods.js";

// ── Dummy struct helpers ────────────────────────────────────────────

/**
 * Emit instructions to create a dummy struct instance for a class.
 * Used when invoking static/prototype getters that require a `this` parameter
 * but we don't have a real instance available.
 */
function emitDummyStruct(ctx: CodegenContext, fctx: FunctionContext, className: string): boolean {
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return false;

  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      fctx.body.push({ op: "i32.const", value: tag });
    } else {
      switch (field.type.kind) {
        case "f64":
          fctx.body.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
        case "externref":
          fctx.body.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  return true;
}

/**
 * Emit a call to a getter function, passing a dummy struct instance as `this`.
 * Returns the getter's return type, or null on failure.
 */
function emitGetterCallWithDummy(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  getterName: string,
  funcIdx: number,
): ValType | null {
  if (!emitDummyStruct(ctx, fctx, className)) return null;
  fctx.body.push({ op: "call", funcIdx });
  // Determine return type from the getter's function type
  const localIdx = funcIdx - ctx.numImportFuncs;
  const funcDef = localIdx >= 0 ? ctx.mod.functions[localIdx] : undefined;
  if (funcDef) {
    const funcType = ctx.mod.types[funcDef.typeIdx];
    if (funcType?.kind === "func" && funcType.results.length > 0) {
      return funcType.results[0]!;
    }
  }
  return { kind: "externref" };
}

// ── Null guard helpers ───────────────────────────────────────────────

/**
 * Returns true when the expression is guaranteed to produce a non-null value,
 * allowing the caller to skip runtime null guards.
 *
 * Provably non-null cases:
 *  - `new Foo()`          — constructor always returns an object
 *  - `{ x: 1 }`          — object literals are never null
 *  - `[1, 2]`            — array literals are never null
 *  - `"str"` / template  — string literals are never null
 *  - Parenthesized wrapper around any of the above
 */
export function isProvablyNonNull(expr: ts.Expression): boolean {
  // Unwrap parentheses: (new Foo()).bar
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  switch (inner.kind) {
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
      return true;
    default:
      return false;
  }
}

export function typeErrorThrowInstrs(ctx: CodegenContext): Instr[] {
  const tagIdx = ensureExnTag(ctx);
  return [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr];
}

/**
 * Emit a null check on the ref currently on the stack. If null, throws
 * TypeError via the exception tag. If non-null, the ref remains on the stack.
 * The `refType` should be the nullable ref type of the value on the stack.
 *
 * Stack: [ref_null T] -> [ref_null T]  (non-null at runtime after this point)
 */
export function emitNullCheckThrow(ctx: CodegenContext, fctx: FunctionContext, refType: ValType): void {
  const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;

  const tmp = allocTempLocal(fctx, refType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  if (backupLocal !== undefined) {
    // A guarded cast backup exists: the null might be from a failed ref.cast
    // (wrong struct type), not from a genuinely null value.  Only throw
    // TypeError when the ORIGINAL pre-cast value was also null (#789).
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: backupLocal } as Instr,
        { op: "ref.is_null" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: typeErrorThrowInstrs(ctx),
          else: [], // wrong struct type — don't throw
        } as Instr,
      ],
      else: [],
    });
  } else {
    // No backup local — this is a direct null check on a genuine ref_null.
    // Throw TypeError so Wasm try-catch can intercept it (Wasm traps from
    // struct.get on null are NOT catchable by Wasm exception handling). (#789)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: typeErrorThrowInstrs(ctx),
      else: [],
    });
  }

  fctx.body.push({ op: "local.get", index: tmp });
  releaseTempLocal(fctx, tmp);
}

/**
 * Find all struct types (other than excludeTypeIdx) that have a field named
 * propName.  Returns an array of {structTypeIdx, fieldIdx, fieldType} for
 * each matching struct type.  Used for multi-struct dispatch when the primary
 * ref.test fails (the object may be a valid GC struct of a different type).
 * When excludeTypeIdx is -1, no type is excluded (useful for the externref path
 * where there is no primary struct type).
 */
export function findAlternateStructsForField(
  ctx: CodegenContext,
  propName: string,
  excludeTypeIdx: number,
): { structTypeIdx: number; fieldIdx: number; fieldType: ValType }[] {
  const result: { structTypeIdx: number; fieldIdx: number; fieldType: ValType }[] = [];
  for (const [typeName, fields] of ctx.structFields) {
    const sIdx = ctx.structMap.get(typeName);
    if (sIdx === undefined || sIdx === excludeTypeIdx) continue;
    const fIdx = fields.findIndex((f) => f.name === propName);
    if (fIdx !== -1) {
      result.push({ structTypeIdx: sIdx, fieldIdx: fIdx, fieldType: fields[fIdx]!.type });
    }
  }
  return result;
}

export function emitNullGuardedStructGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objType: ValType,
  fieldType: ValType,
  typeIdx: number,
  fieldIdx: number,
  propName?: string,
  throwOnNull: boolean = false,
): void {
  // For result type in the if block, normalize ref to ref_null so the null branch is valid
  const resultType: ValType =
    fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx } : fieldType;

  // When propName is provided, the object may be a valid GC struct of a
  // DIFFERENT type (after emitGuardedRefCast returned ref.null for a type
  // mismatch).  We need multi-struct dispatch: try the primary struct type
  // first, then try alternative struct types that have the same field name.
  // We operate on anyref so we can re-test the same value against multiple
  // struct types without losing it.
  if (propName) {
    // Widen the ref_null $T to anyref so we can multi-dispatch
    const tmpAny = allocLocal(fctx, `__ng_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: tmpAny });
    const resultLocal = allocLocal(fctx, `__ng_res_${fctx.locals.length}`, resultType);

    // Find alternative struct types with the same field name
    const alternates = findAlternateStructsForField(ctx, propName, typeIdx);

    // Build the fallback chain: try alternates on a given anyref, then default
    const buildFallback = (srcLocal: number, altIdx: number): Instr[] => {
      if (altIdx < alternates.length) {
        const alt = alternates[altIdx]!;
        const altCoerce = coercionInstrs(ctx, alt.fieldType, resultType, fctx);
        return [
          { op: "local.get", index: srcLocal } as Instr,
          { op: "ref.test", typeIdx: alt.structTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: srcLocal } as Instr,
              { op: "ref.cast", typeIdx: alt.structTypeIdx } as Instr,
              { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx } as Instr,
              ...altCoerce,
              { op: "local.set", index: resultLocal } as Instr,
            ],
            else: buildFallback(srcLocal, altIdx + 1),
          } as Instr,
        ];
      }
      // No more alternates — return default value
      return [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal } as Instr];
    };

    // Check if emitGuardedRefCast saved a pre-cast backup (#792).
    // When the guarded cast failed (wrong struct type), the value on
    // the stack is ref.null but the backup anyref still holds the
    // original value which may match an alternate struct type.
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;

    // Null check: if the value is genuinely null, throw TypeError (#728)
    // But if the backup is available and non-null, use it for multi-struct dispatch
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then:
        backupLocal !== undefined
          ? [
              // Value is null — could be wrong struct type or genuinely null.
              // Check the backup anyref to distinguish.
              { op: "local.get", index: backupLocal } as Instr,
              { op: "ref.is_null" } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                // Backup is also null → genuinely null, throw TypeError
                then: typeErrorThrowInstrs(ctx),
                // Backup is non-null → wrong struct type, try primary + alternates on backup
                else: [
                  { op: "local.get", index: backupLocal } as Instr,
                  { op: "ref.test", typeIdx } as Instr,
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: backupLocal } as Instr,
                      { op: "ref.cast", typeIdx } as Instr,
                      { op: "struct.get", typeIdx, fieldIdx } as Instr,
                      { op: "local.set", index: resultLocal } as Instr,
                    ],
                    else: buildFallback(backupLocal, 0),
                  } as Instr,
                ],
              } as Instr,
            ]
          : typeErrorThrowInstrs(ctx),
      else: [],
    });

    // Non-null path: try primary struct type on the original value
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.test", typeIdx });

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: tmpAny } as Instr,
        { op: "ref.cast", typeIdx } as Instr,
        { op: "struct.get", typeIdx, fieldIdx } as Instr,
        { op: "local.set", index: resultLocal } as Instr,
      ],
      else: buildFallback(tmpAny, 0),
    });
    fctx.body.push({ op: "local.get", index: resultLocal });
    return;
  }

  const tmp = allocLocal(fctx, `__ng_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  // When throwOnNull is true, throw TypeError for null/undefined property access (#728).
  // When false (ref cells), return a default value for uninitialized captures.
  const nullBranch = throwOnNull ? typeErrorThrowInstrs(ctx) : defaultValueInstrs(resultType);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: nullBranch,
    else: [{ op: "local.get", index: tmp } as Instr, { op: "struct.get", typeIdx, fieldIdx } as Instr],
  });
}

/**
 * Emit a struct.get from an externref value. The externref on the stack is
 * converted to anyref via any.convert_extern, then null-safely cast to the
 * target struct type. If the value is the expected struct type, use struct.get.
 * If the value is non-null but wrong type, fall back to __extern_get (dynamic
 * property access) when propName is provided. If the value is null, return a
 * default value.
 *
 * Stack: [externref] -> [fieldType]
 */
export function emitExternrefToStructGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  structTypeIdx: number,
  fieldIdx: number,
  propName?: string,
  throwOnNull: boolean = false,
): void {
  // For result type, normalize ref to ref_null so the null branch is valid
  const resultType: ValType =
    fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: (fieldType as any).typeIdx } : fieldType;

  // Convert externref -> anyref for struct type testing
  fctx.body.push({ op: "any.convert_extern" } as Instr);

  // Use multi-struct dispatch: try the primary struct type, then any
  // alternative struct types that have the same field name.  This handles
  // the case where the runtime object is a valid GC struct but of a
  // different type than expected (e.g., {x:1,y:2} compiled as $__anon_0
  // but accessed as $Point).  WasmGC structs are opaque to JS, so
  // __extern_get cannot read their fields — we must use struct.get.
  const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.tee", index: tmpAny });
  const resultLocal = allocTempLocal(fctx, resultType);

  // Null check FIRST: if the externref-converted-to-anyref is null, throw TypeError (#728)
  // This catches property access on null/undefined before attempting struct dispatch.
  if (throwOnNull) {
    fctx.body.push({ op: "local.get", index: tmpAny });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: typeErrorThrowInstrs(ctx),
      else: [],
    });
  }

  // Build the __extern_get fallback: convert anyref back to externref and call
  // __extern_get(obj, key) for genuine JS objects that aren't GC structs.
  // This prevents silent wrong results (default 0/null) when a valid externref
  // object doesn't match any known struct type.
  let externGetFallback: Instr[] | undefined;
  if (propName) {
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx !== undefined) {
      externGetFallback = [];
      // Convert anyref back to externref for __extern_get
      externGetFallback.push({ op: "local.get", index: tmpAny } as Instr);
      externGetFallback.push({ op: "extern.convert_any" } as Instr);
      // Push property name string
      addStringConstantGlobal(ctx, propName);
      const strGlobalIdx = ctx.stringGlobalMap.get(propName);
      if (strGlobalIdx !== undefined) {
        externGetFallback.push({ op: "global.get", index: strGlobalIdx } as Instr);
      } else {
        externGetFallback.push({ op: "ref.null.extern" } as Instr);
      }
      externGetFallback.push({ op: "call", funcIdx: getIdx } as Instr);
      // Coerce externref result to the expected result type
      if (resultType.kind === "f64") {
        const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
        }
      } else if (resultType.kind === "i32") {
        const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
          externGetFallback.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
        }
      }
      // For ref/ref_null result types, the externref from __extern_get needs
      // to be converted to anyref and then cast to the expected struct type.
      // If the cast fails (wrong type from JS), fall back to a default value.
      if (resultType.kind === "ref_null") {
        // The __extern_get returns externref; convert to anyref, try ref.cast_null
        const tmpExtResult = allocTempLocal(fctx, { kind: "anyref" });
        externGetFallback.push({ op: "any.convert_extern" } as Instr);
        externGetFallback.push({ op: "local.tee", index: tmpExtResult } as Instr);
        externGetFallback.push({ op: "ref.test", typeIdx: (resultType as any).typeIdx } as Instr);
        externGetFallback.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: tmpExtResult } as Instr,
            { op: "ref.cast", typeIdx: (resultType as any).typeIdx } as Instr,
            { op: "local.set", index: resultLocal } as Instr,
          ],
          else: [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal } as Instr],
        } as Instr);
        releaseTempLocal(fctx, tmpExtResult);
      } else {
        externGetFallback.push({ op: "local.set", index: resultLocal } as Instr);
      }
    }
  }

  fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

  // Find alternative struct types with the same field name
  const alternates = propName ? findAlternateStructsForField(ctx, propName, structTypeIdx) : [];

  // Build the fallback chain: try alternates, then __extern_get or default
  const buildFallbackChain = (altIdx: number): Instr[] => {
    if (altIdx < alternates.length) {
      const alt = alternates[altIdx]!;
      const altCoerce = coercionInstrs(ctx, alt.fieldType, resultType, fctx);
      return [
        { op: "local.get", index: tmpAny } as Instr,
        { op: "ref.test", typeIdx: alt.structTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: tmpAny } as Instr,
            { op: "ref.cast", typeIdx: alt.structTypeIdx } as Instr,
            { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx } as Instr,
            ...altCoerce,
            { op: "local.set", index: resultLocal } as Instr,
          ],
          else: buildFallbackChain(altIdx + 1),
        } as Instr,
      ];
    }
    // No more struct alternates — use __extern_get for JS objects, or default value
    if (externGetFallback) {
      return externGetFallback;
    }
    return [...defaultValueInstrs(resultType), { op: "local.set", index: resultLocal } as Instr];
  };

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: tmpAny } as Instr,
      { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
      { op: "local.set", index: resultLocal } as Instr,
    ],
    else: buildFallbackChain(0),
  });

  fctx.body.push({ op: "local.get", index: resultLocal });
  releaseTempLocal(fctx, tmpAny);
  releaseTempLocal(fctx, resultLocal);
}

// ── Optional property access ─────────────────────────────────────────

export function compileOptionalPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  // Compile the receiver
  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  const tmp = allocLocal(fctx, `__opt_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  // Determine result type from the TS type of the property being accessed
  const tsPropType = ctx.checker.getTypeAtLocation(expr);
  let resultType: ValType = resolveWasmType(ctx, tsPropType);
  // For ref types, use externref as the block type to avoid null-subtyping issues
  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    resultType = { kind: "externref" };
  }

  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);

  // then branch (null path): push the appropriate null/zero default
  let thenInstrs: Instr[];
  if (resultType.kind === "f64") {
    thenInstrs = [{ op: "f64.const", value: 0 }];
  } else if (resultType.kind === "i32") {
    thenInstrs = [{ op: "i32.const", value: 0 }];
  } else {
    thenInstrs = [{ op: "ref.null.extern" }];
  }

  // else branch (non-null path): get the property from the temp
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmp });
  // Compile the property access part without the receiver
  const tsObjType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = expr.name.text;
  let elseResultType: ValType | null = null;
  if (isExternalDeclaredClass(tsObjType, ctx.checker)) {
    compileExternPropertyGetFromStack(ctx, fctx, tsObjType, propName);
    elseResultType = { kind: "externref" };
  } else if (isStringType(tsObjType) && propName === "length") {
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
    } else {
      const funcIdx = ctx.funcMap.get("length");
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
    }
    elseResultType = { kind: "i32" };
  } else {
    // General struct field access: look up the struct type and field index
    const structName = resolveStructName(ctx, tsObjType);
    if (structName) {
      const structTypeIdx = ctx.structMap.get(structName);
      const fields = ctx.structFields.get(structName);
      if (structTypeIdx !== undefined && fields) {
        // Check for accessor first
        const accessorKey = `${structName}_${propName}`;
        const getterName = `${structName}_get_${propName}`;
        const getterIdx = ctx.funcMap.get(getterName);
        if (ctx.classAccessorSet.has(accessorKey) && getterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: getterIdx });
          // Determine getter return type
          const funcDef = ctx.mod.functions[getterIdx - ctx.numImportFuncs];
          if (funcDef) {
            const typeDef = ctx.mod.types[funcDef.typeIdx];
            if (typeDef && typeDef.kind === "func" && typeDef.results.length > 0) {
              elseResultType = typeDef.results[0]!;
            }
          }
        } else {
          const fieldIdx = fields.findIndex((f: any) => f.name === propName);
          if (fieldIdx >= 0) {
            // Cast to the concrete struct type if needed, using ref.test guard to avoid illegal cast traps
            if (objType.kind !== "ref" || (objType as any).typeIdx !== structTypeIdx) {
              // Use ref.test to guard against illegal casts at runtime
              const castTmp = allocLocal(fctx, `__optcast_tmp_${fctx.locals.length}`, objType);
              fctx.body.push({ op: "local.tee", index: castTmp });
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: fields[fieldIdx]!.type },
                then: [
                  { op: "local.get", index: castTmp },
                  { op: "ref.cast", typeIdx: structTypeIdx },
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
                ],
                else: [
                  // Type mismatch at runtime — emit a safe default (sNaN sentinel for f64 #866)
                  ...((fields[fieldIdx]!.type.kind === "f64"
                    ? [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }]
                    : fields[fieldIdx]!.type.kind === "i32"
                      ? [{ op: "i32.const", value: 0 }]
                      : [{ op: "ref.null.extern" }]) as Instr[]),
                ],
              });
            } else {
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
            }
            elseResultType = fields[fieldIdx]!.type;
          }
        }
      }
    }
  }

  // Coerce else branch result to match the block result type
  if (elseResultType && !valTypesMatch(elseResultType, resultType)) {
    coerceType(ctx, fctx, elseResultType, resultType);
  }
  const elseInstrs = fctx.body;

  popBody(fctx, savedBody);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultType;
}

/** Helper: compile extern property get when receiver is already on stack */
export function compileExternPropertyGetFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objType: ts.Type,
  propName: string,
): void {
  const className = objType.getSymbol()?.name;
  if (!className) return;
  // Walk inheritance chain to find the property
  let current: string | undefined = className;
  while (current) {
    const info = ctx.externClasses.get(current);
    if (info?.properties.has(propName)) {
      const importName = `${info.importPrefix}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      return;
    }
    current = (ctx as any).externClassParent?.get(current);
  }
}

// ── Property access ──────────────────────────────────────────────────

export function compilePropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  // Optional chaining: obj?.prop
  if (expr.questionDotToken) {
    return compileOptionalPropertyAccess(ctx, fctx, expr);
  }

  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const propName = ts.isPrivateIdentifier(expr.name) ? "__priv_" + expr.name.text.slice(1) : expr.name.text;

  // Handle super.prop — access parent class property/getter on current `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperPropertyAccess(ctx, fctx, expr, propName);
  }

  // Handle import.meta.url and other import.meta properties
  if (
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expr.expression.name.text === "meta"
  ) {
    if (propName === "url") {
      return compileStringLiteral(ctx, fctx, "module.wasm");
    }
    // For any other import.meta property, return undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Check for enum member access: EnumName.Member
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const enumKey = `${objName}.${propName}`;
    const enumVal = ctx.enumValues.get(enumKey);
    if (enumVal !== undefined) {
      fctx.body.push({ op: "f64.const", value: enumVal });
      return { kind: "f64" };
    }
    // Check for string enum member access
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) {
      return compileStringLiteral(ctx, fctx, enumStrVal);
    }
  }

  // Check for static property access: ClassName.staticProp
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    if (ctx.classSet.has(objName)) {
      const fullName = `${objName}_${propName}`;
      const globalIdx = ctx.staticProps.get(fullName);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        return globalDef?.type ?? { kind: "f64" };
      }
      // ClassName.prototype — return a singleton prototype global (externref)
      // so that Object.getPrototypeOf(instance) === ClassName.prototype holds.
      if (propName === "prototype") {
        if (emitLazyProtoGet(ctx, fctx, objName)) {
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.constructor — return the constructor function reference
      if (propName === "constructor") {
        const ctorName = `${objName}_constructor`;
        const funcIdx = ctx.funcMap.get(ctorName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.func", funcIdx });
          fctx.body.push({ op: "extern.convert_any" });
          return { kind: "externref" };
        }
        // Fallback: return null externref
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // ClassName.staticMethod — return function reference as externref (#820)
      // This handles the case where a static method is accessed as a value
      // (e.g., `var ref = C.method`) rather than called directly.
      // Note: funcref is NOT a subtype of anyref in the Wasm GC type system,
      // so we cannot use extern.convert_any to convert ref.func to externref.
      // Instead, we return null externref as a placeholder — the method reference
      // is not callable through externref dispatch, but this prevents null deref
      // traps from the generic property access fallthrough path.
      if (ctx.staticMethodSet.has(fullName) || ctx.classMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
      // ClassName.accessor — invoke static getter (#848)
      const accessorKey = `${objName}_${propName}`;
      if (ctx.classAccessorSet.has(accessorKey)) {
        const getterName = `${objName}_get_${propName}`;
        const funcIdx = ctx.funcMap.get(getterName);
        if (funcIdx !== undefined) {
          const retType = emitGetterCallWithDummy(ctx, fctx, objName, getterName, funcIdx);
          return retType ?? { kind: "externref" };
        }
      }
    }
  }

  // Handle Math.<method>.length — static function arity
  if (
    propName === "length" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Math"
  ) {
    const mathMethodArity: Record<string, number> = {
      abs: 1,
      ceil: 1,
      floor: 1,
      round: 1,
      trunc: 1,
      sign: 1,
      sqrt: 1,
      cbrt: 1,
      clz32: 1,
      fround: 1,
      exp: 1,
      expm1: 1,
      log: 1,
      log2: 1,
      log10: 1,
      log1p: 1,
      sin: 1,
      cos: 1,
      tan: 1,
      asin: 1,
      acos: 1,
      atan: 1,
      sinh: 1,
      cosh: 1,
      tanh: 1,
      asinh: 1,
      acosh: 1,
      atanh: 1,
      min: 2,
      max: 2,
      pow: 2,
      atan2: 2,
      imul: 2,
      hypot: 2,
      random: 0,
    };
    const method = expr.expression.name.text;
    if (method in mathMethodArity) {
      fctx.body.push({ op: "f64.const", value: mathMethodArity[method]! });
      return { kind: "f64" };
    }
  }

  // Handle Function.length — return the number of formal parameters
  if (propName === "length") {
    const callSigs = objType.getCallSignatures?.();
    const constructSigs2 = objType.getConstructSignatures?.();
    const lengthSigs =
      callSigs && callSigs.length > 0 ? callSigs : constructSigs2 && constructSigs2.length > 0 ? constructSigs2 : null;
    if (lengthSigs && lengthSigs.length > 0) {
      // Use the first call/construct signature's parameter count (excluding rest params)
      const sig = lengthSigs[0]!;
      const paramCount = sig.parameters.filter((p: any) => {
        const decl = p.valueDeclaration;
        return !decl || !ts.isParameter(decl) || !decl.dotDotDotToken;
      }).length;
      fctx.body.push({ op: "f64.const", value: paramCount });
      return { kind: "f64" };
    }
  }

  // Handle Function.name — return the function name as a string
  if (propName === "name") {
    const callSigs = objType.getCallSignatures?.();
    const constructSigs = objType.getConstructSignatures?.();
    if ((callSigs && callSigs.length > 0) || (constructSigs && constructSigs.length > 0)) {
      // Resolve the function name from the type symbol or the expression
      let funcName = objType.getSymbol()?.name ?? "";
      // __type, __function, __class, __object are anonymous type names from TS checker
      if (funcName === "__type" || funcName === "__function" || funcName === "__class" || funcName === "__object")
        funcName = "";
      // If the symbol name is empty (anonymous function), infer from context:
      if (funcName === "") {
        if (ts.isIdentifier(expr.expression)) {
          // Direct variable access: f.name => infer "f"
          funcName = expr.expression.text;
        } else if (ts.isPropertyAccessExpression(expr.expression)) {
          // Property access: obj.method.name => infer "method"
          funcName = expr.expression.name.text;
        } else if (
          ts.isElementAccessExpression(expr.expression) &&
          ts.isStringLiteral(expr.expression.argumentExpression)
        ) {
          // Element access: obj["method"].name => infer "method"
          funcName = expr.expression.argumentExpression.text;
        }
      }
      // Ensure the string constant is registered before compiling
      addStringConstantGlobal(ctx, funcName);
      return compileStringLiteral(ctx, fctx, funcName);
    }
  }

  // Handle array.length (vec struct: field 0 is the logical length)
  if (propName === "length") {
    // Shape-inferred array-like: obj.length → struct.get vec field 0
    if (ts.isIdentifier(expr.expression)) {
      const shapeInfo = ctx.shapeMap.get(expr.expression.text);
      if (shapeInfo) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "struct.get", typeIdx: shapeInfo.vecTypeIdx, fieldIdx: 0 });
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    // Check the actual local type (may differ from TS type, e.g. arguments vec struct)
    if (ts.isIdentifier(expr.expression)) {
      const localIdx = fctx.localMap.get(expr.expression.text);
      if (localIdx !== undefined) {
        const localType =
          localIdx < fctx.params.length
            ? fctx.params[localIdx]!.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
        if (localType?.kind === "externref") {
          const funcIdx = ctx.funcMap.get("__extern_length");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: localIdx });
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "f64" };
          }
        }
        // Vec struct ref local (e.g. `arguments` object) — struct.get field 0 (length)
        if ((localType?.kind === "ref" || localType?.kind === "ref_null") && localType.typeIdx !== undefined) {
          const vecTypeIdx = (localType as { typeIdx: number }).typeIdx;
          const typeDef = ctx.mod.types[vecTypeIdx];
          if (
            typeDef?.kind === "struct" &&
            typeDef.fields[0]?.name === "length" &&
            typeDef.fields[1]?.name === "data"
          ) {
            fctx.body.push({ op: "local.get", index: localIdx });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
            return ctx.fast ? { kind: "i32" } : { kind: "f64" };
          }
        }
      }
    }
    const objWasmType = resolveWasmType(ctx, objType);
    if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
      const vecTypeIdx = (objWasmType as { typeIdx: number }).typeIdx;
      const typeDef = ctx.mod.types[vecTypeIdx];
      if (typeDef?.kind === "struct" && typeDef.fields[1]?.name === "data") {
        const exprResult = compileExpression(ctx, fctx, expr.expression);
        // Guard: the TS type might not match the runtime struct type.
        // If the compiled expression returned a different ref type, use ref.test
        // to verify before struct.get, falling back to __extern_length or 0.
        if (
          exprResult &&
          (exprResult.kind === "ref" || exprResult.kind === "ref_null") &&
          (exprResult as any).typeIdx !== vecTypeIdx
        ) {
          const lenTmp = allocLocal(fctx, `__len_tmp_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.set", index: lenTmp });
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
          const lenResult = ctx.fast ? { kind: "i32" as const } : { kind: "f64" as const };
          fctx.body.push({
            op: "if",
            blockType: { kind: "val" as const, type: lenResult },
            then: [
              { op: "local.get", index: lenTmp } as Instr,
              { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
              { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
              ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
            ],
            else: [{ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr],
          });
          return lenResult;
        }
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // get length from vec
        if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
    }
    // Fallback: compile the expression and check the actual wasm return type
    // This handles cases like strings.raw.length where TS doesn't know the type
    {
      const savedLen = fctx.body.length;
      const exprType = compileExpression(ctx, fctx, expr.expression);
      if (
        exprType &&
        (exprType.kind === "ref" || exprType.kind === "ref_null") &&
        (exprType as { typeIdx: number }).typeIdx !== undefined
      ) {
        const vecTypeIdx = (exprType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[vecTypeIdx];
        if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
          return ctx.fast ? { kind: "i32" } : { kind: "f64" };
        }
      }
      // Undo the compiled expression if it didn't match
      fctx.body.length = savedLen;
    }
  }

  // Handle .raw on tagged template strings arrays (template vec struct)
  // The strings parameter is typed as a base vec, but at runtime it's a
  // template vec (subtype with an extra raw field). We ref.cast to the
  // template vec type and then struct.get field 2.
  if (propName === "raw" && ctx.templateVecTypeIdx >= 0) {
    const templateVecTypeIdx = ctx.templateVecTypeIdx;
    // Check if the object is a vec-like type (base vec or template vec)
    let isVecLike = false;
    if (ts.isIdentifier(expr.expression)) {
      const localIdx = fctx.localMap.get(expr.expression.text);
      if (localIdx !== undefined) {
        const localType =
          localIdx < fctx.params.length
            ? fctx.params[localIdx]!.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
        if ((localType?.kind === "ref" || localType?.kind === "ref_null") && localType.typeIdx !== undefined) {
          const typeIdx = (localType as { typeIdx: number }).typeIdx;
          const typeDef = ctx.mod.types[typeIdx];
          if (
            typeDef?.kind === "struct" &&
            typeDef.fields[0]?.name === "length" &&
            typeDef.fields[1]?.name === "data"
          ) {
            isVecLike = true;
          }
        }
      }
    }
    if (!isVecLike) {
      const objWasmType = resolveWasmType(ctx, objType);
      if (objWasmType.kind === "ref" || objWasmType.kind === "ref_null") {
        const typeIdx = (objWasmType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef?.kind === "struct" && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data") {
          isVecLike = true;
        }
      }
    }
    if (isVecLike) {
      // Compile the object expression, cast to template vec, and get raw field
      // Guard with ref.test to avoid illegal cast trap if the runtime type
      // is a base vec (not a template vec with the extra raw field).
      compileExpression(ctx, fctx, expr.expression);
      const baseVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      const rawTmp = allocLocal(fctx, `__raw_tmp_${fctx.locals.length}`, { kind: "ref_null", typeIdx: baseVecTypeIdx });
      const rawObj = allocLocal(fctx, `__raw_obj_${fctx.locals.length}`, { kind: "anyref" });
      fctx.body.push({ op: "local.set", index: rawObj });
      fctx.body.push({ op: "local.get", index: rawObj });
      fctx.body.push({ op: "ref.test", typeIdx: templateVecTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: rawObj } as Instr,
          { op: "ref.cast", typeIdx: templateVecTypeIdx } as Instr,
          { op: "struct.get", typeIdx: templateVecTypeIdx, fieldIdx: 2 } as Instr,
          { op: "local.set", index: rawTmp } as Instr,
        ],
        else: [
          // Not a template vec — return null (no raw field available)
          { op: "ref.null", typeIdx: baseVecTypeIdx } as Instr,
          { op: "local.set", index: rawTmp } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: rawTmp });
      return { kind: "ref_null", typeIdx: baseVecTypeIdx };
    }
  }

  // Handle Math constants
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Math") {
    const mathConstants: Record<string, number> = {
      PI: Math.PI,
      E: Math.E,
      LN2: Math.LN2,
      LN10: Math.LN10,
      SQRT2: Math.SQRT2,
      SQRT1_2: Math.SQRT1_2,
      LOG2E: Math.LOG2E,
      LOG10E: Math.LOG10E,
    };
    if (propName in mathConstants) {
      fctx.body.push({ op: "f64.const", value: mathConstants[propName]! });
      return { kind: "f64" };
    }
  }

  // Handle Number constants
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Number") {
    const numberConstants: Record<string, number> = {
      EPSILON: Number.EPSILON,
      MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
      MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
      MAX_VALUE: Number.MAX_VALUE,
      MIN_VALUE: Number.MIN_VALUE,
      POSITIVE_INFINITY: Infinity,
      NEGATIVE_INFINITY: -Infinity,
      NaN: NaN,
    };
    if (propName in numberConstants) {
      fctx.body.push({ op: "f64.const", value: numberConstants[propName]! });
      return { kind: "f64" };
    }
  }

  // Handle Symbol.iterator, Symbol.hasInstance, etc. → constant i32
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Symbol") {
    const symId = getWellKnownSymbolId(propName);
    if (symId !== undefined) {
      fctx.body.push({ op: "i32.const", value: symId });
      return { kind: "i32" };
    }
  }

  // Handle string.length
  if (isStringType(objType) && propName === "length") {
    compileExpression(ctx, fctx, expr.expression);
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      // len is field 0 of $AnyString — works for both FlatString and ConsString
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
      return { kind: "i32" };
    }
    const funcIdx = ctx.funcMap.get("length");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }

  // Handle IteratorResult property access: .value and .done
  if (isIteratorResultType(objType) || isGeneratorIteratorResultLike(ctx, objType, propName)) {
    if (propName === "value") {
      compileExpression(ctx, fctx, expr.expression);
      // Check the expected value type from the IteratorResult<T>
      const valueType = getIteratorResultValueType(ctx, objType);
      if (valueType && valueType.kind === "f64") {
        const funcIdx = ctx.funcMap.get("__gen_result_value_f64");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "f64" };
        }
      }
      const funcIdx = ctx.funcMap.get("__gen_result_value");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (propName === "done") {
      compileExpression(ctx, fctx, expr.expression);
      const funcIdx = ctx.funcMap.get("__gen_result_done");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
    }
  }

  // Handle externref property access
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    const externResult = compileExternPropertyGet(ctx, fctx, expr, objType, propName);
    if (externResult !== null) return externResult;
    // Fall through to dynamic fallback if import is missing
  }

  // Handle getter accessor on user-defined classes
  let typeName = resolveStructName(ctx, objType);
  // Fallback: check widened variable struct map for empty objects with later-assigned props
  if (!typeName && ts.isIdentifier(expr.expression)) {
    typeName = ctx.widenedVarStructMap.get(expr.expression.text);
  }
  // Fallback for `this.prop` in function constructors
  if (!typeName && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    typeName = resolveThisStructName(ctx, fctx);
  }
  if (typeName) {
    const accessorKey = `${typeName}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${typeName}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, expr.expression);
        fctx.body.push({ op: "call", funcIdx });
        // Use actual Wasm return type of the getter function — TS checker
        // may report 'any' (externref) for Object.defineProperty accessors
        // while the getter actually returns f64/i32/ref.
        const getterLocalIdx = funcIdx - ctx.numImportFuncs;
        const getterDef = getterLocalIdx >= 0 ? ctx.mod.functions[getterLocalIdx] : undefined;
        if (getterDef) {
          const getterType = ctx.mod.types[getterDef.typeIdx];
          if (getterType?.kind === "func" && getterType.results.length > 0) {
            return getterType.results[0]!;
          }
        }
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }

    // Handle instance method accessed as value (not call): obj.method (#820)
    // Returns null externref to prevent null deref traps from the fallthrough path.
    if (ctx.classSet.has(typeName)) {
      const methodFullName = `${typeName}_${propName}`;
      if (ctx.classMethodSet.has(methodFullName) || ctx.staticMethodSet.has(methodFullName)) {
        const funcIdx = ctx.funcMap.get(methodFullName);
        if (funcIdx !== undefined) {
          // Compile and drop the object expression (for side effects)
          const objResult = compileExpression(ctx, fctx, expr.expression);
          if (objResult) {
            fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }

    // Handle .constructor on class instances — return constructor function ref
    if (propName === "constructor" && ctx.classSet.has(typeName)) {
      // Compile and drop the object expression (for side effects)
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      const ctorName = `${typeName}_constructor`;
      const funcIdx = ctx.funcMap.get(ctorName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "ref.func", funcIdx });
        fctx.body.push({ op: "extern.convert_any" });
        return { kind: "externref" };
      }
      // No named constructor found — return null externref
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle .prototype on class instances — return prototype singleton
    if (propName === "prototype" && ctx.classSet.has(typeName)) {
      // Compile and drop the object expression
      const objResult = compileExpression(ctx, fctx, expr.expression);
      if (objResult) {
        fctx.body.push({ op: "drop" });
      }
      if (emitLazyProtoGet(ctx, fctx, typeName)) {
        return { kind: "externref" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle struct field access (named or anonymous)
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const objResult = compileExpression(ctx, fctx, expr.expression);
        const fieldType = fields[fieldIdx]!.type;
        // Null-guard: if the object ref could be null (ref_null), prevent trap
        // Skip null guard when expression is provably non-null (#800)
        const exprNonNull = isProvablyNonNull(expr.expression);
        if (objResult && objResult.kind === "ref_null") {
          // Always use multi-struct dispatch (even when provably non-null) to avoid
          // illegal cast traps when runtime struct type differs from compile-time type (#778).
          emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else if (objResult && objResult.kind === "externref") {
          // The expression returned externref but we need a struct ref for struct.get.
          // Cast externref → anyref → (ref null $StructType), with __extern_get fallback.
          emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, propName, true /* throwOnNull */);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else if (objResult && objResult.kind === "ref") {
          // Always use multi-struct dispatch to avoid illegal cast traps (#778).
          // Even for provably-non-null, runtime struct type may differ from compile-time type.
          const nullableObj: ValType = { kind: "ref_null", typeIdx: (objResult as any).typeIdx ?? structTypeIdx };
          emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName);
          if (fieldType.kind === "ref") {
            return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
          }
          return fieldType;
        } else {
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx,
          });
        }
        return fieldType;
      }

      // ── Prototype chain walk (#799b) ──────────────────────────────
      // Field not found on this struct at compile time. Walk the __proto__
      // chain: get the __proto__ externref field, and if non-null, use
      // __extern_get(proto, propName) to look up the property dynamically.
      const protoFieldIdx = fields.findIndex((f) => f.name === "__proto__");
      if (protoFieldIdx !== -1) {
        const protoAccessType = ctx.checker.getTypeAtLocation(expr);
        const protoResultWasm = resolveWasmType(ctx, protoAccessType);
        const effectiveResult: ValType =
          protoResultWasm.kind === "f64" || protoResultWasm.kind === "i32" ? protoResultWasm : { kind: "externref" };

        const getIdx = ensureLateImport(
          ctx,
          "__extern_get",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        let unboxIdx: number | undefined;
        if (effectiveResult.kind === "f64" || effectiveResult.kind === "i32") {
          unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
        }
        flushLateImportShifts(ctx, fctx);

        if (getIdx !== undefined) {
          const objResult = compileExpression(ctx, fctx, expr.expression);

          // Store in anyref for null-check + struct type dispatch
          const objLocal = allocLocal(fctx, `__pobj_${fctx.locals.length}`, { kind: "anyref" });
          // If the expression returned externref, convert to anyref first
          if (objResult && objResult.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
          }
          fctx.body.push({ op: "local.set", index: objLocal });

          const protoLocal = allocLocal(fctx, `__proto_${fctx.locals.length}`, { kind: "externref" });

          // Null check the object
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // Null object → null proto
              { op: "ref.null.extern" } as Instr,
              { op: "local.set", index: protoLocal } as Instr,
            ],
            else: [
              // Try to cast to expected struct type and get __proto__
              { op: "local.get", index: objLocal } as Instr,
              { op: "ref.test", typeIdx: structTypeIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: objLocal } as Instr,
                  { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: protoFieldIdx } as Instr,
                  { op: "local.set", index: protoLocal } as Instr,
                ],
                else: [
                  // Wrong struct type — try alternate structs that have __proto__
                  { op: "ref.null.extern" } as Instr,
                  { op: "local.set", index: protoLocal } as Instr,
                ],
              } as Instr,
            ],
          });

          // If proto is non-null, call __extern_get(proto, propName)
          addStringConstantGlobal(ctx, propName);
          const strGlobalIdx = ctx.stringGlobalMap.get(propName);

          fctx.body.push({ op: "local.get", index: protoLocal });
          fctx.body.push({ op: "ref.is_null" });
          const protoDefaultInstrs = defaultValueInstrs(effectiveResult);
          fctx.body.push({
            op: "if",
            blockType: { kind: "val" as const, type: effectiveResult },
            then: protoDefaultInstrs,
            else: [
              { op: "local.get", index: protoLocal } as Instr,
              ...(strGlobalIdx !== undefined
                ? [{ op: "global.get", index: strGlobalIdx } as Instr]
                : [{ op: "ref.null.extern" } as Instr]),
              { op: "call", funcIdx: getIdx } as Instr,
              ...(effectiveResult.kind === "f64" && unboxIdx !== undefined
                ? [{ op: "call", funcIdx: unboxIdx } as Instr]
                : effectiveResult.kind === "i32" && unboxIdx !== undefined
                  ? [{ op: "call", funcIdx: unboxIdx } as Instr, { op: "i32.trunc_sat_f64_s" } as unknown as Instr]
                  : []),
            ],
          });

          return effectiveResult;
        }
      }
    }
  }

  // Dynamic property access fallback: instead of erroring, emit a default value.
  // This handles cases where TypeScript cannot resolve the property statically
  // (e.g., properties on Object, {}, undefined, or dynamically-typed values).
  // Determine the expected result type from the TS checker at the access site.
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const accessWasm = resolveWasmType(ctx, accessType);

  // For struct types with the property, try to compile the object and do struct.get
  // but NEVER for class struct types — their fields are fixed at collection time
  if (typeName && !ctx.classSet.has(typeName)) {
    // typeName was already resolved above but field was not found;
    // try auto-registering the property from the TS type
    const props = objType.getProperties?.();
    if (props) {
      const tsProp = props.find((p) => p.name === propName);
      if (tsProp) {
        const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, expr);
        const propWasmType = resolveWasmType(ctx, propTsType);
        // Try to add the field to the struct dynamically
        const structTypeIdx = ctx.structMap.get(typeName);
        const fields = ctx.structFields.get(typeName);
        if (structTypeIdx !== undefined && fields) {
          const typeDef = ctx.mod.types[structTypeIdx];
          if (typeDef?.kind === "struct") {
            // Add the missing field (widen ref to ref_null for default initialization)
            const fieldType =
              propWasmType.kind === "ref"
                ? { kind: "ref_null" as const, typeIdx: (propWasmType as { typeIdx: number }).typeIdx }
                : propWasmType;
            const newField: FieldDef = { name: propName, type: fieldType, mutable: true };
            fields.push(newField);
            // fields === typeDef.fields (same array ref from structFields map)
            patchStructNewForAddedField(ctx, fctx, structTypeIdx, propWasmType);
            const fieldIdx = fields.length - 1;
            if (fieldIdx !== -1) {
              const fieldType = fields[fieldIdx]!.type;
              const objResult = compileExpression(ctx, fctx, expr.expression);
              const exprNonNull2 = isProvablyNonNull(expr.expression);
              if (objResult && objResult.kind === "ref_null") {
                // Always use multi-struct dispatch to avoid illegal cast traps (#778)
                emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName);
                if (fieldType.kind === "ref") {
                  return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
                }
                return fieldType;
              } else if (objResult && objResult.kind === "externref") {
                emitExternrefToStructGet(
                  ctx,
                  fctx,
                  fieldType,
                  structTypeIdx,
                  fieldIdx,
                  propName,
                  true /* throwOnNull */,
                );
              } else if (objResult && objResult.kind === "ref") {
                // Always use multi-struct dispatch to avoid illegal cast traps (#778)
                const nullableObj: ValType = { kind: "ref_null", typeIdx: (objResult as any).typeIdx ?? structTypeIdx };
                emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName);
                if (fieldType.kind === "ref") {
                  return { kind: "ref_null", typeIdx: (fieldType as any).typeIdx };
                }
              } else {
                fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
              }
              return fieldType;
            }
          }
        }
      }
    }
  } // close if (typeName && !ctx.classSet.has(typeName))

  // For externref objects (e.g. results of host calls like RegExp.exec()),
  // use __extern_get(obj, key) to dynamically read the property at runtime.
  {
    const objWasmType = resolveWasmType(ctx, objType);
    const isExternObj =
      objWasmType.kind === "externref" ||
      (ts.isIdentifier(expr.expression) &&
        (() => {
          const localIdx = fctx.localMap.get(expr.expression.text);
          if (localIdx === undefined) return false;
          const localType =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]!.type
              : fctx.locals[localIdx - fctx.params.length]?.type;
          return localType?.kind === "externref";
        })());
    if (isExternObj) {
      const getIdx = ensureLateImport(
        ctx,
        "__extern_get",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      let unboxIdx: number | undefined;
      if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
        unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      }
      flushLateImportShifts(ctx, fctx);
      if (getIdx !== undefined) {
        const objExprType = compileExpression(ctx, fctx, expr.expression);
        // If the expression produced a ref/ref_null (struct), convert to externref
        // so that __extern_get (which expects externref) can be used.
        if (objExprType && (objExprType.kind === "ref" || objExprType.kind === "ref_null")) {
          fctx.body.push({ op: "extern.convert_any" });
        }
        // If the expression produced f64, box it to externref
        if (objExprType && objExprType.kind === "f64") {
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // If the expression produced i32, convert to externref via f64 + box
        if (objExprType && objExprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // Null check: throw TypeError for property access on null/undefined
        const objTmp = allocLocal(fctx, `__nullchk_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: objTmp });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: typeErrorThrowInstrs(ctx),
          else: [],
        });
        // Multi-struct dispatch: the externref may actually be a WasmGC struct
        // (converted via extern.convert_any).  JS __extern_get cannot read GC
        // struct fields, so try struct.get first for all struct types that
        // have a field matching propName.  Only fall back to __extern_get for
        // genuine host-provided externref objects.
        const structCandidates = findAlternateStructsForField(ctx, propName, -1);
        if (structCandidates.length > 0) {
          // Convert externref -> anyref for struct type testing
          const tmpAnyExt = allocLocal(fctx, `__sd_any_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          fctx.body.push({ op: "local.set", index: tmpAnyExt });

          const resultWasm =
            accessWasm.kind === "f64" || accessWasm.kind === "i32" ? accessWasm : { kind: "externref" as const };
          const resultLocal = allocLocal(fctx, `__sd_res_${fctx.locals.length}`, resultWasm);

          // Build the __extern_get fallback instructions
          const externGetFallback: Instr[] = [{ op: "local.get", index: objTmp } as Instr];
          addStringConstantGlobal(ctx, propName);
          const strGlobalIdxExt = ctx.stringGlobalMap.get(propName);
          if (strGlobalIdxExt !== undefined) {
            externGetFallback.push({ op: "global.get", index: strGlobalIdxExt } as Instr);
          } else {
            externGetFallback.push({ op: "ref.null.extern" } as Instr);
          }
          externGetFallback.push({ op: "call", funcIdx: getIdx } as Instr);
          if (resultWasm.kind === "f64" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
          } else if (resultWasm.kind === "i32" && unboxIdx !== undefined) {
            externGetFallback.push({ op: "call", funcIdx: unboxIdx } as Instr);
            externGetFallback.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
          }
          externGetFallback.push({ op: "local.set", index: resultLocal } as Instr);

          // Build nested if/else chain for struct candidates
          const buildStructDispatch = (idx: number): Instr[] => {
            if (idx >= structCandidates.length) {
              return externGetFallback;
            }
            const cand = structCandidates[idx]!;
            const getFieldInstrs: Instr[] = [
              { op: "local.get", index: tmpAnyExt } as Instr,
              { op: "ref.cast", typeIdx: cand.structTypeIdx } as Instr,
              { op: "struct.get", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx } as Instr,
            ];
            const coerce = coercionInstrs(ctx, cand.fieldType, resultWasm, fctx);
            getFieldInstrs.push(...coerce);
            getFieldInstrs.push({ op: "local.set", index: resultLocal } as Instr);

            return [
              { op: "local.get", index: tmpAnyExt } as Instr,
              { op: "ref.test", typeIdx: cand.structTypeIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: getFieldInstrs,
                else: buildStructDispatch(idx + 1),
              } as Instr,
            ];
          };

          fctx.body.push(...buildStructDispatch(0));
          fctx.body.push({ op: "local.get", index: resultLocal });
          if (accessWasm.kind === "f64") {
            return { kind: "f64" };
          }
          if (accessWasm.kind === "i32") {
            return { kind: "i32" };
          }
          return { kind: "externref" };
        }

        // No struct candidates — use __extern_get directly
        fctx.body.push({ op: "local.get", index: objTmp });
        addStringConstantGlobal(ctx, propName);
        compileStringLiteral(ctx, fctx, propName);
        fctx.body.push({ op: "call", funcIdx: getIdx });
        if (accessWasm.kind === "f64") {
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
          return { kind: "f64" };
        }
        if (accessWasm.kind === "i32") {
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
          fctx.body.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
          return { kind: "i32" };
        }
        return { kind: "externref" };
      }
    }
  }

  // Fallback: emit default values for unresolvable property accesses.
  if (accessWasm.kind === "f64" || accessWasm.kind === "i32") {
    fctx.body.push({ op: accessWasm.kind === "f64" ? "f64.const" : "i32.const", value: 0 });
    return accessWasm;
  }
  if (accessWasm.kind === "externref") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (accessWasm.kind === "ref" || accessWasm.kind === "ref_null") {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Last resort: emit null externref as safe default instead of trapping.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

function compileExternPropertyGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  objType: ts.Type,
  propName: string,
): ValType | null {
  const className = objType.getSymbol()?.name;
  if (!className) return null;

  // Walk inheritance chain to find the class that declares the property
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) return null;

  const importName = `${propOwner.importPrefix}_get_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    // Import not found — return null silently to let the caller's fallback handle it.
    // Do NOT compile the object expression here to avoid dangling stack values.
    return null;
  }

  // Push the object and call the getter
  compileExpression(ctx, fctx, expr.expression);
  fctx.body.push({ op: "call", funcIdx });

  const propInfo = propOwner.properties.get(propName);
  return propInfo?.type ?? { kind: "externref" };
}

// ── Bounds-checked array access ──────────────────────────────────────

/**
 * Emit a bounds-checked array.get.  Stack must contain [arrayref, i32 index].
 * If the index is out of bounds (< 0 or >= array.len), a default value for the
 * element type is produced instead of trapping.
 */
export function emitBoundsGuardedArraySet(
  fctx: FunctionContext,
  vecLocal: number,
  vecTypeIdx: number,
  idxLocal: number,
  valLocal: number,
  arrTypeIdx: number,
): void {
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" as const },
    then: [
      { op: "local.get", index: vecLocal } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.get", index: idxLocal } as Instr,
      { op: "local.get", index: valLocal } as Instr,
      { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    ],
    else: [],
  } as Instr);
}

/**
 * Check if an element access expression matches a safe bounds-check-eliminated
 * pattern from a for-loop (e.g., arr[i] inside `for (...; i < arr.length; ...)`).
 */
export function isSafeBoundsEliminated(fctx: FunctionContext, expr: ts.ElementAccessExpression): boolean {
  if (!fctx.safeIndexedArrays || fctx.safeIndexedArrays.size === 0) return false;
  // Both the array and the index must be simple identifiers
  if (!ts.isIdentifier(expr.expression) || !ts.isIdentifier(expr.argumentExpression)) return false;
  const arrayVar = expr.expression.text;
  const indexVar = expr.argumentExpression.text;
  return fctx.safeIndexedArrays.has(arrayVar + ":" + indexVar);
}

// ── Element access ───────────────────────────────────────────────────

export function compileElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  // Handle super[expr] — access parent class property via computed key on `this`
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return compileSuperElementAccess(ctx, fctx, expr);
  }

  // Handle ClassName[key] for static accessors and static properties (#848)
  // Must intercept before compiling the object expression, since the class
  // identifier doesn't compile to a useful runtime value for struct access.
  if (ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    if (ctx.classSet.has(objName)) {
      const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      if (key !== undefined) {
        // Check static accessor first
        const accessorKey = `${objName}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const getterName = `${objName}_get_${key}`;
          const funcIdx = ctx.funcMap.get(getterName);
          if (funcIdx !== undefined) {
            const retType = emitGetterCallWithDummy(ctx, fctx, objName, getterName, funcIdx);
            return retType ?? { kind: "externref" };
          }
        }
        // Check static property global
        const fullName = `${objName}_${key}`;
        const globalIdx = ctx.staticProps.get(fullName);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          return globalDef?.type ?? { kind: "f64" };
        }
        // Check static method — return externref placeholder
        if (ctx.staticMethodSet.has(fullName) || ctx.classMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
        }
      }
    }
  }

  // Handle ClassName.prototype[key] for instance accessors (#848)
  // C.prototype[key] should invoke the instance getter with a dummy this.
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.name.text === "prototype"
  ) {
    const className = expr.expression.expression.text;
    if (ctx.classSet.has(className)) {
      const key = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      if (key !== undefined) {
        const accessorKey = `${className}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey) && !ctx.staticAccessorSet.has(accessorKey)) {
          const getterName = `${className}_get_${key}`;
          const funcIdx = ctx.funcMap.get(getterName);
          if (funcIdx !== undefined) {
            const retType = emitGetterCallWithDummy(ctx, fctx, className, getterName, funcIdx);
            return retType ?? { kind: "externref" };
          }
        }
      }
    }
  }

  const objType = compileExpression(ctx, fctx, expr.expression);
  if (!objType) return null;

  // Null-guard for ref_null: throw TypeError on null, narrow to ref after check
  // In JS, null[x] and undefined[x] throw TypeError
  if (objType.kind === "ref_null") {
    if (!isProvablyNonNull(expr.expression)) {
      // Emit null check that throws TypeError (#775)
      emitNullCheckThrow(ctx, fctx, objType);
    }
    // After the null check (or provably non-null), the value is guaranteed non-null
    const nonNullObjType: ValType = { kind: "ref", typeIdx: (objType as any).typeIdx };
    return compileElementAccessBody(ctx, fctx, expr, nonNullObjType);
  }

  // Null-guard for externref: null[x] and undefined[x] throw TypeError (#775)
  if (objType.kind === "externref") {
    if (!isProvablyNonNull(expr.expression)) {
      emitNullCheckThrow(ctx, fctx, objType);
    }
  }

  return compileElementAccessBody(ctx, fctx, expr, objType);
}

/** Inner element access logic — assumes objType is on the stack and non-null */
export function compileElementAccessBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
  objType: ValType,
): ValType | null {
  // Externref element access: obj[key] → host import __extern_get(obj, externref) → externref
  if (objType.kind === "externref") {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    // Lazily register __extern_get if not already registered
    let funcIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    return null;
  }

  if (objType.kind !== "ref" && objType.kind !== "ref_null") {
    // Primitive types (f64, i32): box to externref and use __extern_get
    if (objType.kind === "f64") {
      // Box f64 to externref via __box_number
      let boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (objType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      let boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else {
      ctx.errors.push({
        message: "Element access on non-array value",
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    // Compile key as externref and call __extern_get
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
    let funcIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    return null;
  }

  const typeIdx = (objType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle tuple struct — element access with literal index → struct.get
  if (typeDef?.kind === "struct") {
    const isVecStructAccess =
      typeDef.fields[0]?.name === "length" &&
      typeDef.fields[1]?.name === "data" &&
      (typeDef.fields.length === 2 || (typeDef.fields.length === 3 && typeDef.fields[2]?.name === "raw"));

    if (!isVecStructAccess) {
      // Check if this is a tuple struct (registered in tupleTypeMap)
      const isTuple = Array.from(ctx.tupleTypeMap.values()).includes(typeIdx);
      if (isTuple) {
        // Tuple element access requires a literal numeric index
        if (!ts.isNumericLiteral(expr.argumentExpression)) {
          ctx.errors.push({
            message: "Tuple element access requires a numeric literal index",
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }
        const fieldIdx = Number(expr.argumentExpression.text);
        if (fieldIdx < 0 || fieldIdx >= typeDef.fields.length) {
          ctx.errors.push({
            message: `Tuple index ${fieldIdx} out of bounds (tuple has ${typeDef.fields.length} elements)`,
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
        return typeDef.fields[fieldIdx]!.type;
      }
      // String/numeric literal index on a plain struct → resolve to struct.get by field name
      let fieldName: string | undefined;
      if (ts.isStringLiteral(expr.argumentExpression)) {
        fieldName = expr.argumentExpression.text;
      } else if (ts.isNumericLiteral(expr.argumentExpression)) {
        fieldName = expr.argumentExpression.text;
      } else if (ts.isIdentifier(expr.argumentExpression)) {
        // Const variable reference: const key = "x"; obj[key]
        const sym = ctx.checker.getSymbolAtLocation(expr.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, expr.argumentExpression);
      }
      if (fieldName !== undefined) {
        // Check for getter accessor first
        const objTsType = ctx.checker.getTypeAtLocation(expr.expression);
        const sName = resolveStructName(ctx, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const getterName = `${sName}_get_${fieldName}`;
            const funcIdx = ctx.funcMap.get(getterName);
            if (funcIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx });
              // Use actual Wasm return type of the getter
              const elGetterLocalIdx = funcIdx - ctx.numImportFuncs;
              const elGetterDef = elGetterLocalIdx >= 0 ? ctx.mod.functions[elGetterLocalIdx] : undefined;
              if (elGetterDef) {
                const elGetterType = ctx.mod.types[elGetterDef.typeIdx];
                if (elGetterType?.kind === "func" && elGetterType.results.length > 0) {
                  return elGetterType.results[0]!;
                }
              }
              const propType = ctx.checker.getTypeAtLocation(expr);
              return resolveWasmType(ctx, propType);
            }
          }
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          return typeDef.fields[fieldIdx]!.type;
        }
      }
      // Non-vec, non-tuple struct: fallback to externref conversion + __extern_get
      // Convert struct ref (already on stack) to externref
      fctx.body.push({ op: "extern.convert_any" });
      // Compile the key as externref
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "externref" });
      // Call __extern_get(externref, externref) → externref
      {
        let funcIdx = ensureLateImport(
          ctx,
          "__extern_get",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
      return null;
    }

    // Handle vec struct (array wrapped in {length, data})
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({ message: "Element access: vec data is not array", line: 0, column: 0 });
      return null;
    }
    // Unwrap: struct.get data field, then index into backing array
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
    if (ctx.fast) {
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    if (isSafeBoundsEliminated(fctx, expr)) {
      // Bounds check elided: loop guard guarantees index < array.length
      fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    } else {
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef.element);
    }
    return arrDef.element;
  }

  if (!typeDef || typeDef.kind !== "array") {
    ctx.errors.push({
      message: "Element access on non-array type",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Compile index and convert to i32
  if (ctx.fast) {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, expr.argumentExpression, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }

  if (isSafeBoundsEliminated(fctx, expr)) {
    // Bounds check elided: loop guard guarantees index < array.length
    fctx.body.push({ op: "array.get", typeIdx } as Instr);
  } else {
    emitBoundsCheckedArrayGet(fctx, typeIdx, typeDef.element);
  }
  return typeDef.element;
}
