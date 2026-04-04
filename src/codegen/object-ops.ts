/**
 * Object operations: Object.defineProperty, Object.keys/values/entries,
 * hasOwnProperty / propertyIsEnumerable.
 *
 * Extracted from expressions.ts (#688 step 6).
 */
import ts from "typescript";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { resolveWasmType, addUnionImports, getOrRegisterTupleType, cacheStringLiterals } from "./index.js";
import { isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { compileStatement } from "./statements.js";
import { coerceType } from "./shared.js";
import { compileExpression, VOID_RESULT, getLine, getCol } from "./shared.js";
import type { InnerResult } from "./shared.js";
import { compileNativeStringLiteral } from "./string-ops.js";
import { emitThrowString, resolveStructName, ensureLateImport, flushLateImportShifts } from "./expressions.js";
import { emitGuardedRefCast } from "./type-coercion.js";

// ── Compile-time primitive type check for Object methods ─────────────

/**
 * Check if the first argument to Object.defineProperty / defineProperties
 * is statically known to be a non-object type (undefined, null, boolean,
 * number, string).  If so, emit `throw TypeError` and return true.
 *
 * Per ES spec (19.1.2.4 step 1): "If Type(O) is not Object, throw a TypeError."
 */
function emitNonObjectArgGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
  methodName: string,
): boolean {
  const tsType = ctx.checker.getTypeAtLocation(argExpr);
  const flags = tsType.flags;

  // Check for primitive types that are definitely not objects
  const NON_OBJECT_FLAGS =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BigIntLike;

  if (flags & NON_OBJECT_FLAGS) {
    // Compile the argument for side effects (it might have side effects)
    const argType = compileExpression(ctx, fctx, argExpr);
    if (argType) fctx.body.push({ op: "drop" });
    emitThrowString(ctx, fctx, `TypeError: ${methodName} called on non-object`);
    return true;
  }

  // Also check for literal expressions that are obviously non-object
  if (
    argExpr.kind === ts.SyntaxKind.UndefinedKeyword ||
    argExpr.kind === ts.SyntaxKind.NullKeyword ||
    argExpr.kind === ts.SyntaxKind.TrueKeyword ||
    argExpr.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(argExpr) ||
    (ts.isIdentifier(argExpr) && argExpr.text === "undefined")
  ) {
    emitThrowString(ctx, fctx, `TypeError: ${methodName} called on non-object`);
    return true;
  }

  return false;
}

// ── Null guard for object method arguments ────────────────────────────

/**
 * Emit a null check on the ref stored in `localIdx`.
 * If null, throws TypeError via the exception tag.
 */
function emitObjectArgNullGuard(ctx: CodegenContext, fctx: FunctionContext, localIdx: number): void {
  const message = "TypeError: Object method called on null or undefined";
  addStringConstantGlobal(ctx, message);
  const strIdx = ctx.stringGlobalMap.get(message)!;
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
    else: [],
  });
}

// ── Object.defineProperty flag helpers ────────────────────────────────

/**
 * Property descriptor flag encoding for the __pf_ side-table:
 *   bit 0: writable
 *   bit 1: enumerable
 *   bit 2: configurable
 *   bit 3: "defined" marker (always 1 when a descriptor has been stored)
 *   bit 4: is accessor property (get/set vs data)
 */
export const PROP_FLAG_WRITABLE = 1 << 0; // 1
export const PROP_FLAG_ENUMERABLE = 1 << 1; // 2
export const PROP_FLAG_CONFIGURABLE = 1 << 2; // 4
export const PROP_FLAG_DEFINED = 1 << 3; // 8
export const PROP_FLAG_ACCESSOR = 1 << 4; // 16

/**
 * Compute a compile-time flags integer from parsed descriptor booleans.
 * Unspecified flags default to false per the ES spec for Object.defineProperty.
 */
export function computeDescriptorFlags(
  writable: boolean | undefined,
  enumerable: boolean | undefined,
  configurable: boolean | undefined,
  isAccessor: boolean,
): number {
  let flags = PROP_FLAG_DEFINED; // always mark as defined
  if (writable) flags |= PROP_FLAG_WRITABLE;
  if (enumerable) flags |= PROP_FLAG_ENUMERABLE;
  if (configurable) flags |= PROP_FLAG_CONFIGURABLE;
  if (isAccessor) flags |= PROP_FLAG_ACCESSOR;
  return flags;
}

/**
 * Emit code to check existing property flags and throw TypeError if the
 * Object.defineProperty operation violates the spec. Also stores the new flags.
 *
 * Uses __extern_get/set with "__pf_<propName>" keys to store flags as boxed numbers.
 * Uses "__ne" key to check non-extensibility.
 *
 * @param objLocal - local index holding the externref object
 * @param propName - compile-time property name
 * @param newFlags - the flags integer for the new descriptor
 * @param hasValue - whether the new descriptor specifies a value
 */
export function emitDefinePropertyFlagCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  propName: string,
  newFlags: number,
  hasValue: boolean,
): void {
  const flagKey = `__pf_${propName}`;
  const neKey = "__ne";

  // Ensure __extern_get, __extern_set, __unbox_number, __box_number are available
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  if (!getIdx || !setIdx || !unboxIdx || !boxIdx) return;

  // Register the flag key and non-extensible key as string constants
  addStringConstantGlobal(ctx, flagKey);
  addStringConstantGlobal(ctx, neKey);
  const flagKeyGlobal = ctx.stringGlobalMap.get(flagKey)!;
  const neKeyGlobal = ctx.stringGlobalMap.get(neKey)!;

  // Helper to build a TypeError throw instruction sequence
  const typeErrorMessage = "TypeError: Cannot redefine property";
  addStringConstantGlobal(ctx, typeErrorMessage);
  const errMsgGlobal = ctx.stringGlobalMap.get(typeErrorMessage)!;
  const tagIdx = ensureExnTag(ctx);
  const throwInstrs: Instr[] = [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr];

  const neErrMessage = "TypeError: Cannot define property, object is not extensible";
  addStringConstantGlobal(ctx, neErrMessage);
  const neErrMsgGlobal = ctx.stringGlobalMap.get(neErrMessage)!;
  const neThrowInstrs: Instr[] = [
    { op: "global.get", index: neErrMsgGlobal } as Instr,
    { op: "throw", tagIdx } as Instr,
  ];

  // Allocate locals for existing flags
  const existingFlagsLocal = allocLocal(fctx, `__pf_existing_${fctx.locals.length}`, { kind: "f64" });
  const existingI32Local = allocLocal(fctx, `__pf_ei32_${fctx.locals.length}`, { kind: "i32" });

  // Read existing flags: __extern_get(obj, "__pf_<propName>") -> externref, unbox to f64
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: flagKeyGlobal } as Instr);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  fctx.body.push({ op: "call", funcIdx: unboxIdx }); // externref -> f64 (NaN if undefined)
  fctx.body.push({ op: "local.set", index: existingFlagsLocal });

  // Convert existing flags to i32 (NaN -> 0 via i32.trunc_sat_f64_s)
  fctx.body.push({ op: "local.get", index: existingFlagsLocal });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
  fctx.body.push({ op: "local.set", index: existingI32Local });

  // Build non-configurable violation checks (only emitted when property is defined AND non-configurable)
  const isAccessor = !!(newFlags & PROP_FLAG_ACCESSOR);
  const nonConfigChecks: Instr[] = [];

  // Check: new descriptor sets configurable to true -> always TypeError
  if (newFlags & PROP_FLAG_CONFIGURABLE) {
    nonConfigChecks.push(...throwInstrs);
  }

  // Check: new descriptor changes enumerable (runtime check against existing)
  const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
  nonConfigChecks.push(
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_ENUMERABLE } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.const", value: newEnumerable } as Instr,
    { op: "i32.ne" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] } as unknown as Instr,
  );

  // Check for data property restrictions
  if (!isAccessor) {
    const nonWritableChecks: Instr[] = [];
    if (newFlags & PROP_FLAG_WRITABLE || hasValue) {
      nonWritableChecks.push(...throwInstrs);
    }
    if (nonWritableChecks.length > 0) {
      // if (existing is data property)
      //   if (existing is non-writable)
      //     throw TypeError
      const isDataAndNonWritable: Instr[] = [
        { op: "local.get", index: existingI32Local } as Instr,
        { op: "i32.const", value: PROP_FLAG_WRITABLE } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: nonWritableChecks } as unknown as Instr,
      ];
      nonConfigChecks.push(
        { op: "local.get", index: existingI32Local } as Instr,
        { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: isDataAndNonWritable } as unknown as Instr,
      );
    }
  }

  // Check: cannot change from data to accessor or vice versa on non-configurable
  if (isAccessor) {
    nonConfigChecks.push(
      { op: "local.get", index: existingI32Local } as Instr,
      { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
      { op: "i32.and" } as Instr,
      { op: "i32.eqz" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] } as unknown as Instr,
    );
  } else if (hasValue || newFlags & PROP_FLAG_WRITABLE) {
    nonConfigChecks.push(
      { op: "local.get", index: existingI32Local } as Instr,
      { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
      { op: "i32.and" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] } as unknown as Instr,
    );
  }

  // Build the outer block structure:
  // block $defprop_check
  //   br_if (not defined) → end of block
  //   br_if (configurable) → end of block
  //   <nonConfigChecks>
  // end
  const blockBody: Instr[] = [
    // Check if property is defined
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_DEFINED } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.eqz" } as Instr,
    { op: "br_if", depth: 0 } as Instr,
    // Check if configurable
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_CONFIGURABLE } as Instr,
    { op: "i32.and" } as Instr,
    { op: "br_if", depth: 0 } as Instr,
    // Property is non-configurable — apply restrictions
    ...nonConfigChecks,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: blockBody,
  } as unknown as Instr);

  // Check: If property was NOT defined yet, check non-extensibility
  const neCheckBody: Instr[] = [
    { op: "local.get", index: objLocal } as Instr,
    { op: "global.get", index: neKeyGlobal } as Instr,
    { op: "call", funcIdx: getIdx } as Instr,
    { op: "call", funcIdx: unboxIdx } as Instr,
    { op: "i32.trunc_sat_f64_s" } as unknown as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [...neThrowInstrs] } as unknown as Instr,
  ];

  fctx.body.push(
    { op: "local.get", index: existingI32Local },
    { op: "i32.const", value: PROP_FLAG_DEFINED },
    { op: "i32.and" },
    { op: "i32.eqz" },
  );
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: neCheckBody,
  } as unknown as Instr);

  // Store the new flags: __extern_set(obj, "__pf_<propName>", box(newFlags))
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: flagKeyGlobal } as Instr);
  fctx.body.push({ op: "f64.const", value: newFlags });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  fctx.body.push({ op: "call", funcIdx: setIdx });
}

// ── Object.defineProperty ─────────────────────────────────────────────

/**
 * Compile Object.defineProperty(obj, prop, descriptor).
 *
 * If the descriptor is an object literal with a `value` property, we extract
 * the value and emit __extern_set(obj, prop, value).
 * If the descriptor has `get` and/or `set` properties, we compile them as
 * struct accessor methods (getter/setter functions).
 * Otherwise we compile all arguments for side effects and return the object unchanged.
 *
 * Returns obj (externref).
 */
export function compileObjectDefineProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const propArg = expr.arguments[1]!;
  const descArg = expr.arguments[2]!;

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is not an object
  if (emitNonObjectArgGuard(ctx, fctx, objArg, "Object.defineProperty")) {
    // After the throw, emit unreachable and return externref to satisfy callers
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "externref" };
  }

  // Check if descriptor is an object literal with a `value`, `get`, or `set` property
  let valueExpr: ts.Expression | undefined;
  let getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  let setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
        valueExpr = prop.initializer;
      }
      // get: function() { ... } or get: () => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        getNode = prop.initializer;
      }
      // get() { ... } (method shorthand)
      if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "get") {
        getNode = prop;
      }
      // set: function(v) { ... } or set: (v) => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        setNode = prop.initializer;
      }
      // set(v) { ... } (method shorthand)
      if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "set") {
        setNode = prop;
      }
    }
  }

  // ── Parse descriptor flags (configurable, writable, enumerable) ──────
  // Defaults per spec: all false when using Object.defineProperty
  let descWritable: boolean | undefined;
  let descEnumerable: boolean | undefined;
  let descConfigurable: boolean | undefined;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const name = prop.name.text;
        if (name === "writable" || name === "enumerable" || name === "configurable") {
          // Resolve boolean literal value
          let boolVal: boolean | undefined;
          if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) boolVal = true;
          else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) boolVal = false;
          if (name === "writable") descWritable = boolVal;
          else if (name === "enumerable") descEnumerable = boolVal;
          else if (name === "configurable") descConfigurable = boolVal;
        }
      }
    }
  }

  // Resolve the property name at compile time (string literal)
  let propName: string | undefined;
  if (ts.isStringLiteral(propArg)) {
    propName = propArg.text;
  }

  // Check if obj is a struct type with the given field
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  let structName =
    resolveStructName(ctx, objTsType) ||
    (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);

  // Fallback 1: resolve struct name from the local variable's Wasm type.
  // This handles cases where the TS type is `any` but the local holds a struct ref.
  if (!structName && ts.isIdentifier(objArg)) {
    const localIdx = fctx.localMap.get(objArg.text);
    if (localIdx !== undefined) {
      const localType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
      if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
        structName = ctx.typeIdxToStructName.get(localType.typeIdx);
      }
    }
  }

  // Fallback 2: resolve struct name from the variable's declaration initializer.
  // For `const obj: any = { x: 0 }`, the TS type is `any` and the local is
  // externref, but the initializer is an object literal whose fields match a struct.
  if (!structName && ts.isIdentifier(objArg)) {
    const sym = ctx.checker.getSymbolAtLocation(objArg);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const initType = ctx.checker.getTypeAtLocation(decl.initializer);
      structName = resolveStructName(ctx, initType);
      // If resolveStructName failed (ts.Type identity mismatch), try to match
      // by struct field names against the object literal properties.
      if (!structName && ts.isObjectLiteralExpression(decl.initializer)) {
        const litProps = decl.initializer.properties
          .filter((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
          .map((p) => (p.name as ts.Identifier).text)
          .sort();
        if (litProps.length > 0) {
          for (const [sName, sFields] of ctx.structFields) {
            const fieldNames = sFields.map((f) => f.name).sort();
            if (fieldNames.length === litProps.length && fieldNames.every((n, i) => n === litProps[i])) {
              structName = sName;
              break;
            }
          }
        }
      }
    }
  }

  const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  const fieldIdx = fields && propName ? fields.findIndex((f) => f.name === propName) : -1;
  const useStruct = structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr;

  // ── Getter/setter path ──────────────────────────────────────────────
  // Object.defineProperty(obj, "prop", { get() {...}, set(v) {...} })
  // Compile as struct accessor methods, analogous to object literal getters/setters.
  if ((getNode || setNode) && !valueExpr && structName && structTypeIdx !== undefined && propName) {
    // Compile obj and save to local
    const objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;
    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    const accessorKey = `${structName}_${propName}`;
    ctx.classAccessorSet.add(accessorKey);

    // Helper to get body statements from a getter/setter node
    const getBodyStatements = (
      node:
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration
        | ts.FunctionExpression
        | ts.ArrowFunction,
    ): ts.Statement[] => {
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        // Arrow with expression body: wrap as return statement
        return [];
      }
      const body = ts.isArrowFunction(node) ? (node.body as ts.Block) : node.body;
      return body ? [...body.statements] : [];
    };

    // Helper to get parameters from a node
    const getParams = (
      node: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    ): readonly ts.ParameterDeclaration[] => {
      return node.parameters;
    };

    // Compile getter
    if (getNode) {
      const getterName = `${structName}_get_${propName}`;
      if (!ctx.funcMap.has(getterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const getterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];

        // Determine return type from the getter function signature
        const sig = ctx.checker.getSignatureFromDeclaration(getNode);
        let getterResults: ValType[] = [];
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (!isVoidType(retType)) {
            getterResults = [resolveWasmType(ctx, retType)];
          }
        }

        const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
        const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.funcMap.set(getterName, getterFuncIdx);

        const getterFunc: WasmFunction = {
          name: getterName,
          typeIdx: getterTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        ctx.mod.functions.push(getterFunc);

        // Compile getter body
        const getterFctx: FunctionContext = {
          name: getterName,
          params: [{ name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } }],
          locals: [],
          localMap: new Map(),
          returnType: getterResults.length > 0 ? getterResults[0]! : null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        getterFctx.localMap.set("this", 0);

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = getterFctx;

        if (ts.isArrowFunction(getNode) && !ts.isBlock(getNode.body)) {
          // Arrow with expression body: compile as return expression
          const retType = compileExpression(
            ctx,
            getterFctx,
            getNode.body as ts.Expression,
            getterFctx.returnType ?? undefined,
          );
          if (retType && getterFctx.returnType && retType.kind !== getterFctx.returnType.kind) {
            coerceType(ctx, getterFctx, retType, getterFctx.returnType);
          }
        } else {
          const stmts = getBodyStatements(getNode);
          for (const stmt of stmts) {
            compileStatement(ctx, getterFctx, stmt);
          }
        }

        // Ensure valid return for non-void getters
        if (getterFctx.returnType) {
          const lastInstr = getterFctx.body[getterFctx.body.length - 1];
          if (!lastInstr || lastInstr.op !== "return") {
            if (getterFctx.returnType.kind === "f64") {
              getterFctx.body.push({ op: "f64.const", value: 0 });
            } else if (getterFctx.returnType.kind === "i32") {
              getterFctx.body.push({ op: "i32.const", value: 0 });
            } else if (getterFctx.returnType.kind === "externref") {
              getterFctx.body.push({ op: "ref.null.extern" });
            } else if (getterFctx.returnType.kind === "ref" || getterFctx.returnType.kind === "ref_null") {
              getterFctx.body.push({ op: "ref.null", typeIdx: getterFctx.returnType.typeIdx });
            }
          }
        }
        cacheStringLiterals(ctx, getterFctx);
        getterFunc.locals = getterFctx.locals;
        getterFunc.body = getterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Compile setter
    if (setNode) {
      const setterName = `${structName}_set_${propName}`;
      if (!ctx.funcMap.has(setterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const setterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];
        const allNodeParams = getParams(setNode);
        // Filter out the TS `this` parameter (explicit this type annotation)
        const nodeParams = allNodeParams.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
        for (const param of nodeParams) {
          const paramType = ctx.checker.getTypeAtLocation(param);
          setterParams.push(resolveWasmType(ctx, paramType));
        }

        const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
        const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.funcMap.set(setterName, setterFuncIdx);

        const setterFunc: WasmFunction = {
          name: setterName,
          typeIdx: setterTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        ctx.mod.functions.push(setterFunc);

        // Compile setter body
        const setterFctxParams: { name: string; type: ValType }[] = [
          { name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } },
        ];
        for (let pi = 0; pi < nodeParams.length; pi++) {
          const param = nodeParams[pi]!;
          const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
          const paramType = ctx.checker.getTypeAtLocation(param);
          setterFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
        }

        const setterFctx: FunctionContext = {
          name: setterName,
          params: setterFctxParams,
          locals: [],
          localMap: new Map(),
          returnType: null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        for (let i = 0; i < setterFctxParams.length; i++) {
          setterFctx.localMap.set(setterFctxParams[i]!.name, i);
        }

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = setterFctx;

        if (ts.isArrowFunction(setNode) && !ts.isBlock(setNode.body)) {
          // Arrow with expression body: compile for side effects
          const retType = compileExpression(ctx, setterFctx, setNode.body as ts.Expression);
          if (retType) setterFctx.body.push({ op: "drop" });
        } else {
          const stmts = getBodyStatements(setNode as ts.MethodDeclaration);
          for (const stmt of stmts) {
            compileStatement(ctx, setterFctx, stmt);
          }
        }

        cacheStringLiterals(ctx, setterFctx);
        setterFunc.locals = setterFctx.locals;
        setterFunc.body = setterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  }

  if (valueExpr && useStruct) {
    // Struct path: Object.defineProperty(obj, "prop", { value: v }) → struct.set

    // Compile obj and save to local
    let objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;

    // If obj is externref but we know it's a struct (e.g. `const obj: any = { x: 0 }`),
    // cast from externref to the struct ref type via any.convert_extern + guarded ref.cast.
    if (objType.kind === "externref" && structTypeIdx !== undefined) {
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      // Guard: ref.test before ref.cast to avoid illegal cast traps
      const tmpAny = allocTempLocal(fctx, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "local.tee", index: tmpAny });
      fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: structTypeIdx } as ValType },
        then: [{ op: "local.get", index: tmpAny } as Instr, { op: "ref.cast_null", typeIdx: structTypeIdx } as Instr],
        else: [{ op: "ref.null", typeIdx: structTypeIdx }],
      } as Instr);
      releaseTempLocal(fctx, tmpAny);
      objType = { kind: "ref_null", typeIdx: structTypeIdx };
    }

    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    // ── Compile-time flag checking for struct path ──
    // Save existing flags BEFORE updating (needed for value comparison below)
    let priorExistingFlags: number | undefined;
    if (propName) {
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const isAccessor = !!(getNode || setNode);
        const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
        const key = `${varName}:${propName}`;
        priorExistingFlags = ctx.definedPropertyFlags.get(key);

        // Check non-extensibility
        if (ctx.nonExtensibleVars.has(varName) && !ctx.definedPropertyFlags.has(key)) {
          emitThrowString(ctx, fctx, "TypeError: Cannot define property, object is not extensible");
        }

        // Check existing flags
        const existingFlags = ctx.definedPropertyFlags.get(key);
        if (existingFlags !== undefined) {
          const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
          if (!isExistingConfigurable) {
            // Non-configurable: check for violations
            if (newFlags & PROP_FLAG_CONFIGURABLE) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
            const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
            if (existingEnumerable !== newEnumerable) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            // Data property writable checks
            if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
              if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                if (newFlags & PROP_FLAG_WRITABLE) {
                  // Cannot change writable from false to true on non-configurable
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
              }
            }
            // Cannot change data<->accessor on non-configurable
            if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
          }
        }

        // Record the new flags
        ctx.definedPropertyFlags.set(key, newFlags);

        // Update shapePropFlags so getOwnPropertyDescriptor sees updated attributes
        if (structTypeIdx !== undefined && fields) {
          const userFieldsList = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const userIdx = userFieldsList.findIndex((e) => e.field.name === propName);
          if (userIdx >= 0) {
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            if (flagsArr && userIdx < flagsArr.length) {
              flagsArr[userIdx] = newFlags & 0x07; // Only store WEC bits
            }
          }
        }
      }
    }

    // Compile remaining descriptor properties for side effects (before value)
    for (const prop of (descArg as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }

    // Check if this property is non-writable non-configurable (needs runtime value comparison)
    // Uses priorExistingFlags captured BEFORE the current call updated the map
    const needsValueCompare =
      priorExistingFlags !== undefined &&
      !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
      !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
      !(priorExistingFlags & PROP_FLAG_ACCESSOR);

    // Emit struct.set: push obj, then value, then struct.set
    const fieldType = fields![fieldIdx]!.type;

    if (needsValueCompare) {
      // Save old value for comparison
      const oldValLocal = allocLocal(fctx, `__defprop_oldval_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx!, fieldIdx });
      fctx.body.push({ op: "local.set", index: oldValLocal });

      // Compile new value into temp local
      const newValLocal = allocLocal(fctx, `__defprop_newval_${fctx.locals.length}`, fieldType);
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "local.set", index: newValLocal });

      // Compare old and new values. If different, throw TypeError.
      // Use SameValue semantics (for f64: need to handle NaN === NaN, +0 !== -0)
      const tagIdx = ensureExnTag(ctx);
      const errMsg = "TypeError: Cannot redefine property";
      addStringConstantGlobal(ctx, errMsg);
      const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;

      if (fieldType.kind === "f64") {
        // f64 comparison: values not equal → throw
        // Note: f64.ne treats NaN != NaN (not SameValue), but sufficient for typical test262 cases
        const compareBody: Instr[] = [
          { op: "global.get", index: errMsgGlobal } as Instr,
          { op: "throw", tagIdx } as Instr,
        ];
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        } as unknown as Instr);
      } else if (fieldType.kind === "i32") {
        const compareBody: Instr[] = [
          { op: "global.get", index: errMsgGlobal } as Instr,
          { op: "throw", tagIdx } as Instr,
        ];
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "i32.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        } as unknown as Instr);
      }
      // For externref/ref types, skip value comparison (would need reference equality)

      // Do the struct.set with the new value
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newValLocal });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    } else {
      fctx.body.push({ op: "local.get", index: objLocal });
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        // Drop the obj ref we just pushed
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  } else if (valueExpr) {
    // Externref path: Object.defineProperty(obj, prop, { value: v }) → __defineProperty_value
    return emitExternDefinePropertyValue(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      valueExpr,
      descWritable,
      descEnumerable,
      descConfigurable,
    );
  } else {
    // No value property or descriptor is not an object literal:
    // For externref objects, delegate to __defineProperty_value with no-value flag
    return emitExternDefinePropertyNoValue(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      descWritable,
      descEnumerable,
      descConfigurable,
      getNode,
      setNode,
    );
  }
}

// ── __defineProperty_value runtime flag encoding ──────────────────────
//   bit 0: writable          bit 3: writable specified
//   bit 1: enumerable        bit 4: enumerable specified
//   bit 2: configurable      bit 5: configurable specified
//   bit 6: is accessor       bit 7: has value

function computeRuntimeFlags(
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  hasValue: boolean,
): number {
  let flags = 0;
  if (descWritable !== undefined) {
    flags |= 1 << 3; // writable specified
    if (descWritable) flags |= 1;
  }
  if (descEnumerable !== undefined) {
    flags |= 1 << 4; // enumerable specified
    if (descEnumerable) flags |= 1 << 1;
  }
  if (descConfigurable !== undefined) {
    flags |= 1 << 5; // configurable specified
    if (descConfigurable) flags |= 1 << 2;
  }
  if (hasValue) flags |= 1 << 7;
  return flags;
}

/**
 * Emit __defineProperty_value(obj, prop, value, flags) for the externref value path.
 */
function emitExternDefinePropertyValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  valueExpr: ts.Expression,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
): ValType | null {
  // Compile obj and coerce to externref
  const objType = compileExpression(ctx, fctx, objArg, { kind: "externref" });
  if (!objType) return null;
  if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }
  const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is null/undefined (standalone mode)
  emitObjectArgNullGuard(ctx, fctx, objLocal);

  // Compile prop key as externref
  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  if (!propType) {
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };
  }
  if (propType.kind !== "externref") {
    coerceType(ctx, fctx, propType, { kind: "externref" });
  }
  const propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: propLocal });

  // Compile value as externref
  const valType = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
  if (!valType) {
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };
  }
  if (valType.kind !== "externref") {
    coerceType(ctx, fctx, valType, { kind: "externref" });
  }
  const valLocal = allocLocal(fctx, `__defprop_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Compile remaining descriptor properties for side effects
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      // Skip flag properties (writable, enumerable, configurable) — handled via flags param
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        (prop.name.text === "writable" || prop.name.text === "enumerable" || prop.name.text === "configurable")
      )
        continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }
  }

  // Compute runtime flags
  const runtimeFlags = computeRuntimeFlags(descWritable, descEnumerable, descConfigurable, true);

  // Push args: obj, key, val, flags and call __defineProperty_value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: propLocal });
  fctx.body.push({ op: "local.get", index: valLocal });
  fctx.body.push({ op: "f64.const", value: runtimeFlags });

  const funcIdx = ensureLateImport(
    ctx,
    "__defineProperty_value",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }

  // __defineProperty_value returns obj, so we're done
  return { kind: "externref" };
}

/**
 * Emit __defineProperty_value(obj, prop, null, flags) for descriptors without a value property.
 * For externref objects, this delegates to the JS host which can handle flag-only descriptors.
 * For struct-typed objects, this is a no-op (struct fields are always writable).
 */
function emitExternDefinePropertyNoValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined,
  setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined,
): ValType | null {
  // Compile obj
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.set", index: objLocal });

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is null/undefined (standalone mode)
  if (objType.kind === "externref" || objType.kind === "ref_null") {
    emitObjectArgNullGuard(ctx, fctx, objLocal);
  }

  // Compile prop and save as externref (needed for __defineProperty_value call)
  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  let propLocal: number | undefined;
  if (propType) {
    if (propType.kind !== "externref") {
      coerceType(ctx, fctx, propType, { kind: "externref" });
    }
    propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: propLocal });
  }

  // Compile descriptor for side effects
  const descType = compileExpression(ctx, fctx, descArg);
  if (descType) fctx.body.push({ op: "drop" });

  // For externref objects (or non-struct GC types like arrays), call __defineProperty_value
  // with no value (flags without bit 7). This ensures runtime validation of property descriptors.
  // We check if the object is a known struct type — if not, delegate to runtime (#856).
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const _structName =
    resolveStructName(ctx, objTsType) ||
    (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);
  const _propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;
  const _structTypeIdx = _structName ? ctx.structMap.get(_structName) : undefined;
  const _fields = _structName ? ctx.structFields.get(_structName) : undefined;
  const _fieldIdx = _fields && _propName ? _fields.findIndex((f) => f.name === _propName) : -1;
  const isKnownStructField = _structTypeIdx !== undefined && _fields !== undefined && _fieldIdx >= 0;
  if (!isKnownStructField && propLocal !== undefined) {
    const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;

    // Compile-time tracking
    if (propName && ts.isObjectLiteralExpression(descArg)) {
      const isAccessor = !!(getNode || setNode);
      const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const key = `${varName}:${propName}`;
        ctx.definedPropertyFlags.set(key, newFlags);
      }
    }

    const runtimeFlags = computeRuntimeFlags(descWritable, descEnumerable, descConfigurable, false);

    fctx.body.push({ op: "local.get", index: objLocal });
    if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.get", index: propLocal });
    fctx.body.push({ op: "ref.null.extern" }); // null value
    fctx.body.push({ op: "f64.const", value: runtimeFlags });

    const funcIdx = ensureLateImport(
      ctx,
      "__defineProperty_value",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // For struct-typed objects, flag-only descriptors are a no-op at runtime
  // (struct fields don't support property attributes)
  const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;
  if (propName && ts.isObjectLiteralExpression(descArg)) {
    const isAccessor = !!(getNode || setNode);
    const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
    const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
    if (varName) {
      const key = `${varName}:${propName}`;
      if (ctx.nonExtensibleVars.has(varName) && !ctx.definedPropertyFlags.has(key)) {
        emitThrowString(ctx, fctx, "TypeError: Cannot define property, object is not extensible");
      }
      const existingFlags = ctx.definedPropertyFlags.get(key);
      if (existingFlags !== undefined) {
        const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
        if (!isExistingConfigurable) {
          if (newFlags & PROP_FLAG_CONFIGURABLE) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
          if ((existingFlags & PROP_FLAG_ENUMERABLE) !== (newFlags & PROP_FLAG_ENUMERABLE)) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
          // Data property writable checks (#856)
          if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
            if (!(existingFlags & PROP_FLAG_WRITABLE)) {
              if (newFlags & PROP_FLAG_WRITABLE) {
                // Cannot change writable from false to true on non-configurable
                emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
              }
            }
          }
          // Cannot change data<->accessor on non-configurable
          if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
          if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
        }
      }
      ctx.definedPropertyFlags.set(key, newFlags);
    }
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return objType;
}

// ── Object.defineProperties ───────────────────────────────────────────

/**
 * Compile Object.defineProperties(obj, descriptors).
 *
 * Static path: when descriptors is an object literal, iterate each property
 * and synthesize individual Object.defineProperty calls at compile time.
 *
 * Dynamic fallback: delegate to __defineProperties host import.
 */
export function compileObjectDefineProperties(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const descsArg = expr.arguments[1]!;

  // ES spec 19.1.2.3 step 1: throw TypeError if first arg is not an object
  if (emitNonObjectArgGuard(ctx, fctx, objArg, "Object.defineProperties")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "externref" };
  }

  // Static path: descriptors is an object literal — expand to individual defineProperty calls
  if (ts.isObjectLiteralExpression(descsArg)) {
    // Compile obj and save to local
    const objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;
    const objLocal = allocLocal(fctx, `__defprops_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });

    for (const prop of descsArg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : undefined;
      if (propName === undefined) continue;

      // Synthesize: Object.defineProperty(obj, propName, descriptor)
      const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier("Object"),
        "defineProperty",
      );
      const syntheticCall = ts.factory.createCallExpression(syntheticPropAccess, undefined, [
        ts.factory.createIdentifier(`__defprops_obj_placeholder_${objLocal}`),
        ts.factory.createStringLiteral(propName),
        prop.initializer,
      ]);
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;

      // Instead of recursing through compileCallExpression (which would need
      // the synthetic identifier to resolve), directly call compileObjectDefineProperty
      // with the obj already on stack via local.get.

      // Build a mini call that reuses our saved obj local:
      // We need to compile the descriptor value per property.
      // The simplest approach: push obj local, then delegate to the externref
      // defineProperty path for each property.
      const descExpr = prop.initializer;

      // Parse the individual descriptor
      let valueExpr: ts.Expression | undefined;
      let descWritable: boolean | undefined;
      let descEnumerable: boolean | undefined;
      let descConfigurable: boolean | undefined;

      if (ts.isObjectLiteralExpression(descExpr)) {
        for (const dp of descExpr.properties) {
          if (ts.isPropertyAssignment(dp) && ts.isIdentifier(dp.name)) {
            if (dp.name.text === "value") valueExpr = dp.initializer;
            if (dp.name.text === "writable") {
              if (dp.initializer.kind === ts.SyntaxKind.TrueKeyword) descWritable = true;
              else if (dp.initializer.kind === ts.SyntaxKind.FalseKeyword) descWritable = false;
            }
            if (dp.name.text === "enumerable") {
              if (dp.initializer.kind === ts.SyntaxKind.TrueKeyword) descEnumerable = true;
              else if (dp.initializer.kind === ts.SyntaxKind.FalseKeyword) descEnumerable = false;
            }
            if (dp.name.text === "configurable") {
              if (dp.initializer.kind === ts.SyntaxKind.TrueKeyword) descConfigurable = true;
              else if (dp.initializer.kind === ts.SyntaxKind.FalseKeyword) descConfigurable = false;
            }
          }
        }
      }

      // Try struct path: if obj is a known struct and propName matches a field
      const objTsType = ctx.checker.getTypeAtLocation(objArg);
      const structName =
        resolveStructName(ctx, objTsType) ||
        (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);
      const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
      const fields = structName ? ctx.structFields.get(structName) : undefined;
      const fieldIdx = fields && propName ? fields.findIndex((f) => f.name === propName) : -1;

      if (structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr) {
        // Struct path: emit struct.set directly
        const fieldType = fields[fieldIdx]!.type;

        // ── Compile-time flag checking for struct path (#856) ──
        let priorExistingFlags: number | undefined;
        if (ts.isIdentifier(objArg)) {
          const isAccessor = false;
          const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
          const key = `${objArg.text}:${propName}`;
          priorExistingFlags = ctx.definedPropertyFlags.get(key);

          const existingFlags = ctx.definedPropertyFlags.get(key);
          if (existingFlags !== undefined) {
            const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
            if (!isExistingConfigurable) {
              // Non-configurable: check for violations
              if (newFlags & PROP_FLAG_CONFIGURABLE) {
                emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
              }
              const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
              const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
              if (existingEnumerable !== newEnumerable) {
                emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
              }
              // Data property writable checks
              if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
                if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                  if (newFlags & PROP_FLAG_WRITABLE) {
                    emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                  }
                }
              }
              // Cannot change data<->accessor on non-configurable
              if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
                emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
              }
              if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
                emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
              }
            }
          }
        }

        // Check if this property is non-writable non-configurable (needs runtime value comparison)
        const needsValueCompare =
          priorExistingFlags !== undefined &&
          !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
          !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
          !(priorExistingFlags & PROP_FLAG_ACCESSOR);

        fctx.body.push({ op: "local.get", index: objLocal });

        // Cast if needed — guard with ref.test to avoid illegal cast traps (#778)
        let needsGuard = false;
        if (objType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          needsGuard = true;
        } else if (
          (objType.kind === "ref_null" || objType.kind === "ref") &&
          "typeIdx" in objType &&
          objType.typeIdx !== structTypeIdx
        ) {
          needsGuard = true;
        }

        if (needsValueCompare) {
          // Non-writable non-configurable: compare old and new values
          if (needsGuard) {
            // Save as anyref for guarded access
            const defpTmp = allocLocal(fctx, `__defp_tmp_${fctx.locals.length}`, { kind: "anyref" });
            fctx.body.push({ op: "local.set", index: defpTmp } as Instr);

            // Save old value
            const oldValLocal = allocLocal(fctx, `__defps_oldval_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.get", index: defpTmp } as Instr);
            fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
            if (fieldType.kind === "f64") {
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } as ValType },
                then: [
                  { op: "local.get", index: defpTmp } as Instr,
                  { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
                ],
                else: [{ op: "f64.const", value: 0 } as Instr],
              } as Instr);
            } else if (fieldType.kind === "i32") {
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } as ValType },
                then: [
                  { op: "local.get", index: defpTmp } as Instr,
                  { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                  { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
                ],
                else: [{ op: "i32.const", value: 0 } as Instr],
              } as Instr);
            }
            fctx.body.push({ op: "local.set", index: oldValLocal } as Instr);

            // Compile new value
            const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
            if (valType) {
              const newValLocal = allocLocal(fctx, `__defps_newval_${fctx.locals.length}`, fieldType);
              if (valType.kind !== fieldType.kind) {
                coerceType(ctx, fctx, valType, fieldType);
              }
              fctx.body.push({ op: "local.set", index: newValLocal } as Instr);

              // Compare values — throw if different
              const tagIdx = ensureExnTag(ctx);
              const errMsg = "TypeError: Cannot redefine property";
              addStringConstantGlobal(ctx, errMsg);
              const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;
              if (fieldType.kind === "f64") {
                fctx.body.push({ op: "local.get", index: oldValLocal });
                fctx.body.push({ op: "local.get", index: newValLocal });
                fctx.body.push({ op: "f64.ne" });
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                } as unknown as Instr);
              } else if (fieldType.kind === "i32") {
                fctx.body.push({ op: "local.get", index: oldValLocal });
                fctx.body.push({ op: "local.get", index: newValLocal });
                fctx.body.push({ op: "i32.ne" });
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                } as unknown as Instr);
              }

              // Do the struct.set if values match
              fctx.body.push({ op: "local.get", index: defpTmp } as Instr);
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: defpTmp } as Instr,
                  { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                  { op: "local.get", index: newValLocal } as Instr,
                  { op: "struct.set", typeIdx: structTypeIdx, fieldIdx } as Instr,
                ],
                else: [],
              } as Instr);
            }
          } else {
            // Non-guarded: direct struct access
            const oldValLocal = allocLocal(fctx, `__defps_oldval_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
            fctx.body.push({ op: "local.set", index: oldValLocal });

            const newValLocal = allocLocal(fctx, `__defps_newval_${fctx.locals.length}`, fieldType);
            const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
            if (valType) {
              if (valType.kind !== fieldType.kind) {
                coerceType(ctx, fctx, valType, fieldType);
              }
              fctx.body.push({ op: "local.set", index: newValLocal });

              const tagIdx = ensureExnTag(ctx);
              const errMsg = "TypeError: Cannot redefine property";
              addStringConstantGlobal(ctx, errMsg);
              const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;
              if (fieldType.kind === "f64") {
                fctx.body.push({ op: "local.get", index: oldValLocal });
                fctx.body.push({ op: "local.get", index: newValLocal });
                fctx.body.push({ op: "f64.ne" });
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                } as unknown as Instr);
              } else if (fieldType.kind === "i32") {
                fctx.body.push({ op: "local.get", index: oldValLocal });
                fctx.body.push({ op: "local.get", index: newValLocal });
                fctx.body.push({ op: "i32.ne" });
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                } as unknown as Instr);
              }

              // Do the struct.set
              fctx.body.push({ op: "local.get", index: objLocal });
              fctx.body.push({ op: "local.get", index: newValLocal });
              fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
            } else {
              fctx.body.push({ op: "drop" });
            }
          }
        } else if (needsGuard) {
          // Save obj as anyref, compile value, then guard the struct.set
          const defpTmp = allocLocal(fctx, `__defp_tmp_${fctx.locals.length}`, { kind: "anyref" });
          fctx.body.push({ op: "local.set", index: defpTmp } as Instr);

          // Compile the value expression first (outside the guard)
          const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
          if (valType) {
            const valLocal = allocLocal(fctx, `__defp_val_${fctx.locals.length}`, fieldType);
            if (valType.kind !== fieldType.kind) {
              coerceType(ctx, fctx, valType, fieldType);
            }
            fctx.body.push({ op: "local.set", index: valLocal } as Instr);

            // Now guard the struct.set with ref.test
            fctx.body.push({ op: "local.get", index: defpTmp } as Instr);
            fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: defpTmp } as Instr,
                { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                { op: "local.get", index: valLocal } as Instr,
                { op: "struct.set", typeIdx: structTypeIdx, fieldIdx } as Instr,
              ],
              else: [],
            } as Instr);
          }
        } else {
          const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
          if (valType) {
            if (valType.kind !== fieldType.kind) {
              coerceType(ctx, fctx, valType, fieldType);
            }
            fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          } else {
            // No value produced — drop the obj ref
            fctx.body.push({ op: "drop" });
          }
        }

        // Update compile-time flags
        if (ts.isIdentifier(objArg)) {
          const isAccessor = false;
          const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
          const key = `${objArg.text}:${propName}`;
          ctx.definedPropertyFlags.set(key, newFlags);
        }

        // Update shapePropFlags
        const userFields = fields
          .map((f, idx) => ({ field: f, fieldIdx: idx }))
          .filter((e) => !e.field.name.startsWith("__"));
        const userFieldIdx = userFields.findIndex((e) => e.fieldIdx === fieldIdx);
        if (userFieldIdx >= 0) {
          const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
          if (flagsArr && userFieldIdx < flagsArr.length) {
            const isAccessor = false;
            const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
            flagsArr[userFieldIdx] = newFlags & 0x07; // Only store WEC bits
          }
        }

        continue; // Next property
      }

      // Externref fallback: call __defineProperty_value for this property
      if (objType.kind !== "externref") {
        // Coerce obj to externref for the host call
        fctx.body.push({ op: "local.get", index: objLocal });
        coerceType(ctx, fctx, objType, { kind: "externref" });
      } else {
        fctx.body.push({ op: "local.get", index: objLocal });
      }
      const objExtLocal = allocLocal(fctx, `__defprops_ext_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: objExtLocal });

      // Push prop name as string
      fctx.body.push({ op: "local.get", index: objExtLocal });
      compileExpression(ctx, fctx, ts.factory.createStringLiteral(propName), { kind: "externref" });

      // Compile value or push null
      if (valueExpr) {
        const vt = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
        if (vt && vt.kind !== "externref") {
          coerceType(ctx, fctx, vt, { kind: "externref" });
        } else if (!vt) {
          fctx.body.push({ op: "ref.null.extern" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Runtime flags
      const runtimeFlags = computeRuntimeFlags(descWritable, descEnumerable, descConfigurable, !!valueExpr);
      fctx.body.push({ op: "f64.const", value: runtimeFlags });

      const funcIdx = ensureLateImport(
        ctx,
        "__defineProperty_value",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "drop" }); // drop returned obj (we use our local)
      }

      // Update compile-time flags for externref path
      if (ts.isIdentifier(objArg)) {
        const isAccessor = false;
        const newFlags = computeDescriptorFlags(descWritable, descEnumerable, descConfigurable, isAccessor);
        const key = `${objArg.text}:${propName}`;
        ctx.definedPropertyFlags.set(key, newFlags);
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  }

  // Dynamic fallback: delegate to __defineProperties host import
  const objType = compileExpression(ctx, fctx, objArg, { kind: "externref" });
  if (!objType) return null;
  if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }
  const descsType = compileExpression(ctx, fctx, descsArg, { kind: "externref" });
  if (!descsType) {
    return { kind: "externref" };
  }
  if (descsType.kind !== "externref") {
    coerceType(ctx, fctx, descsType, { kind: "externref" });
  }

  const funcIdx = ensureLateImport(
    ctx,
    "__defineProperties",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }
  return { kind: "externref" };
}

// ── Object.keys / Object.values ───────────────────────────────────────

/**
 * Compile Object.keys(obj) or Object.values(obj) by expanding struct fields
 * at compile time. Object.keys returns a string[] of field names,
 * Object.values returns an array of the field values.
 */
export function compileObjectKeysOrValues(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  const arg = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(arg);

  // Resolve struct name from the argument type
  const structName = resolveStructName(ctx, argType);
  if (!structName) {
    // Check if the type is an empty object literal (not any/unknown) — if so,
    // compile away to an empty array since there's nothing to enumerate.
    const isAnyOrUnknown = (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const tsProps = argType.getProperties?.();
    if (!isAnyOrUnknown && tsProps && tsProps.length === 0) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
      const elemKind = "externref";
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) return null;
      fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 });
      const tmpData = allocLocal(fctx, `__obj_${method}_empty_data_${fctx.locals.length}`, {
        kind: "ref",
        typeIdx: arrTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: tmpData });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: tmpData });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // Non-struct argument (any, externref, etc.) — delegate to host import
    // which calls the real JS Object.keys/values/entries at runtime.
    // The host import uses __struct_field_names + __sget_* for WasmGC structs.
    // Returns externref (a JS array) which the coercion layer converts to a
    // WasmGC vec when stored in a typed variable (e.g., const keys = ...).
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    // Coerce to externref if needed
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const importName = `__object_${method}`;
    const funcIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    // Fallback: drop arg, push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return { kind: "externref" };
  }

  const structTypeIdx = ctx.structMap.get(structName);
  const fields = ctx.structFields.get(structName);
  if (structTypeIdx === undefined || !fields) {
    ctx.errors.push({
      message: `Object.${method}(): unknown struct "${structName}"`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Filter out internal fields like __tag
  const userFields = fields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => !e.field.name.startsWith("__"));

  if (method === "keys") {
    // Build a string[] array from the field names
    // Each field name is already registered as a string literal thunk
    const elemKind = "externref";
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      ctx.errors.push({
        message: `Object.keys(): cannot resolve array type for string[]`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Push each field name string onto the stack
    for (const entry of userFields) {
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // Object.keys returns externref strings, convert from native
        fctx.body.push({ op: "extern.convert_any" });
      } else {
        const globalIdx = ctx.stringGlobalMap.get(entry.field.name);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
        } else {
          const importName = ctx.stringLiteralMap.get(entry.field.name);
          if (importName) {
            const funcIdx = ctx.funcMap.get(importName);
            if (funcIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx });
            }
          }
        }
      }
    }

    // Create the backing array with array.new_fixed
    const count = userFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
    const tmpData = allocLocal(fctx, `__obj_keys_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  if (method === "entries") {
    // Build [string, T][] by resolving the TS return type to get the correct
    // tuple struct and vec types that match what resolveWasmType produces.
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    const objLocal = allocLocal(fctx, `__obj_entries_src_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: structTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    // Resolve the return type from the TS signature to get proper tuple/vec types
    const sig = ctx.checker.getResolvedSignature(expr);
    const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
    const resolvedRet = retType ? resolveWasmType(ctx, retType) : undefined;

    // The return type should be ref_null to a vec struct (Array<[string, T]>)
    // Extract the vec type index and from it the array type index and entry tuple type
    let outerVecTypeIdx: number;
    let outerArrTypeIdx: number;
    let entryTupleTypeIdx: number;

    if (resolvedRet && (resolvedRet.kind === "ref" || resolvedRet.kind === "ref_null") && "typeIdx" in resolvedRet) {
      outerVecTypeIdx = resolvedRet.typeIdx;
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
      // The array element type is a ref to the tuple struct
      // Get it from the vec's array type definition
      const arrTypeDef = ctx.mod.types[outerArrTypeIdx];
      if (
        arrTypeDef &&
        arrTypeDef.kind === "array" &&
        (arrTypeDef as any).element &&
        ((arrTypeDef as any).element.kind === "ref" || (arrTypeDef as any).element.kind === "ref_null")
      ) {
        entryTupleTypeIdx = (arrTypeDef as any).element.typeIdx;
      } else {
        // Fallback: create a tuple with [externref, externref]
        entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      }
    } else {
      // Fallback: create externref-based types
      entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      const entryElemKind = `ref_${entryTupleTypeIdx}`;
      outerVecTypeIdx = getOrRegisterVecType(ctx, entryElemKind, { kind: "ref", typeIdx: entryTupleTypeIdx });
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
    }

    if (outerArrTypeIdx < 0) {
      ctx.errors.push({
        message: `Object.entries(): cannot resolve outer array type`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Get the tuple struct fields to know the value type
    const tupleTypeDef = ctx.mod.types[entryTupleTypeIdx];
    const tupleFields = tupleTypeDef && tupleTypeDef.kind === "struct" ? (tupleTypeDef as any).fields : undefined;
    // Field 0 is the key (string), field 1 is the value
    const valueFieldType: ValType | undefined = tupleFields?.[1]?.type;

    // Ensure union boxing imports are registered (needed for boxing primitives)
    addUnionImports(ctx);

    // For each field, create a tuple struct [key, value]
    for (const entry of userFields) {
      // Push key string (field 0 of tuple)
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // If tuple expects externref for the key, convert
        if (tupleFields && tupleFields[0]?.type?.kind === "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      } else {
        const globalIdx = ctx.stringGlobalMap.get(entry.field.name);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
        } else {
          const importName = ctx.stringLiteralMap.get(entry.field.name);
          if (importName) {
            const funcIdx = ctx.funcMap.get(importName);
            if (funcIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx });
            }
          }
        }
      }

      // Push value (field 1 of tuple)
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

      // Coerce the struct field value to match the tuple's value field type
      const fieldKind = entry.field.type.kind;
      const targetKind = valueFieldType?.kind ?? "externref";

      if (targetKind === "externref") {
        // Box primitives to externref
        if (fieldKind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "ref" || fieldKind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      }
      // If target is f64 and field is f64, no conversion needed
      // If target is i32 and field is i32, no conversion needed

      // Create tuple struct
      fctx.body.push({ op: "struct.new", typeIdx: entryTupleTypeIdx });
    }

    // Create outer array from the entry tuples on the stack
    const count = userFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: outerArrTypeIdx, length: count });
    const outerData = allocLocal(fctx, `__obj_entries_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: outerArrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: outerData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: outerData });
    fctx.body.push({ op: "struct.new", typeIdx: outerVecTypeIdx });
    return { kind: "ref_null", typeIdx: outerVecTypeIdx };
  }

  // method === "values"
  // Compile the argument expression, store in a local, then struct.get each field
  const argResult = compileExpression(ctx, fctx, arg);
  if (!argResult) return null;
  const objLocal = allocLocal(fctx, `__obj_vals_src_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: objLocal });
  emitObjectArgNullGuard(ctx, fctx, objLocal);

  // Always use externref elements for Object.values() since the TS return type is any[]
  const elemKind = "externref";
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({
      message: `Object.values(): cannot resolve array type for values[]`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Ensure union boxing imports are registered (needed for boxing primitives)
  addUnionImports(ctx);

  // Push each field value onto the stack, boxing primitives to externref
  for (const entry of userFields) {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });
    // Box primitive values to externref
    if (entry.field.type.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
    } else if (entry.field.type.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
    } else if (entry.field.type.kind === "ref" || entry.field.type.kind === "ref_null") {
      // Convert GC ref types (nested structs, etc.) to externref
      fctx.body.push({ op: "extern.convert_any" });
    }
    // externref fields (strings, etc.) don't need boxing
  }

  // Create the backing array with array.new_fixed
  const count = userFields.length;
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
  const tmpData = allocLocal(fctx, `__obj_vals_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: count });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile obj.hasOwnProperty(key) / obj.propertyIsEnumerable(key).
 * For WasmGC structs all own fields are enumerable, so both methods behave
 * identically: return true iff `key` names an own field of the struct type.
 *
 * Static resolution (string literal arg): constant fold to i32.const 0/1.
 * Dynamic resolution: runtime string comparison against known field names.
 */
export function compilePropertyIntrospection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  expr: ts.CallExpression,
): InnerResult {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const receiverWasm = resolveWasmType(ctx, receiverType);

  // For externref/any receivers (e.g. Object.create result), delegate to runtime
  // since we can't statically know their properties
  if (receiverWasm.kind === "externref") {
    const isHOP = propAccess.name.text === "hasOwnProperty";
    const importName = isHOP ? "__hasOwnProperty" : "__propertyIsEnumerable";
    const hopIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (hopIdx !== undefined) {
      // Push receiver
      compileExpression(ctx, fctx, propAccess.expression);
      // Push key argument (or null if missing)
      if (expr.arguments[0]) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]);
        if (argType && argType.kind !== "externref") {
          coerceType(ctx, fctx, argType, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: hopIdx });
      return { kind: "i32" };
    }
  }

  // Build a set of private member names (without '#') from the TS type.
  // Private fields (#x) are stored in the struct with the '#' stripped, but
  // should never be reported as own properties via hasOwnProperty("x").
  const privateNames = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    if (prop.name.startsWith("#")) {
      privateNames.add(prop.name.slice(1));
    }
  }

  // Collect struct field names from the Wasm struct definition, excluding:
  // - Internal fields (e.g. __tag) that are compiler-generated
  // - Fields that correspond to private members (#-prefixed in TS source)
  let structFieldNames: string[] | null = null;
  if (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null") {
    const structDef = ctx.mod.types[(receiverWasm as { typeIdx: number }).typeIdx];
    if (structDef?.kind === "struct") {
      structFieldNames = structDef.fields
        .map((f) => f.name)
        .filter((n): n is string => n !== undefined && !n.startsWith("__") && !privateNames.has(n));
    }
  }

  // Detect if receiver is a prototype object (e.g. C.prototype) vs an instance
  // vs a class constructor.  Each has different "own" property semantics:
  //   - Prototype:   methods + accessors are own; instance fields are NOT
  //   - Instance:    instance fields are own; methods are NOT (they're on prototype)
  //   - Constructor: static members are own; instance members are NOT
  const isPrototypeReceiver =
    ts.isPropertyAccessExpression(propAccess.expression) && propAccess.expression.name.text === "prototype";

  // A constructor type (typeof C) has construct signatures; an instance does not.
  const isConstructorReceiver = !isPrototypeReceiver && receiverType.getConstructSignatures().length > 0;

  // For prototype/constructor receivers, the struct definition represents the
  // instance layout — its fields are NOT own properties of the prototype or
  // constructor object.  Clear structFieldNames so only tsProps drives the result.
  if (isPrototypeReceiver || isConstructorReceiver) {
    structFieldNames = null;
  }

  // Collect own properties from the TypeScript type system.
  // Filtering depends on what kind of object the receiver is.
  const tsProps = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    // Skip private identifiers — they start with '#' and can't be matched by string keys
    if (prop.name.startsWith("#")) continue;

    const decls = prop.getDeclarations();
    const isMethod =
      decls && decls.length > 0 && decls.every((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
    const isAccessor =
      decls && decls.length > 0 && decls.every((d) => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d));

    if (isPrototypeReceiver) {
      // On C.prototype: only methods and accessors are own properties.
      // Instance data fields are NOT on the prototype (set in constructor).
      if (!isMethod && !isAccessor) continue;
    } else if (isConstructorReceiver) {
      // On the constructor (typeof C): only static members are own.
      if (decls && decls.length > 0) {
        const hasStatic = decls.some((d) =>
          ts.canHaveModifiers(d)
            ? (ts.getModifiers(d as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
            : false,
        );
        if (!hasStatic) continue;
      }
    } else {
      // On an instance: skip methods and accessors — they live on the prototype.
      if (isMethod || isAccessor) continue;
    }

    tsProps.add(prop.name);
  }

  // Add synthetic own properties for callable types (functions/constructors).
  // ES spec: all functions have own "length" and "name" properties.
  // Non-arrow functions also have "prototype" as an own property.
  const callSigs = receiverType.getCallSignatures();
  const constructSigs = receiverType.getConstructSignatures();
  if (callSigs.length > 0 || constructSigs.length > 0) {
    tsProps.add("length");
    tsProps.add("name");
    // Constructors and non-arrow functions have "prototype"
    if (constructSigs.length > 0) {
      tsProps.add("prototype");
    }
    // Check if receiver is a class — classes always have "prototype"
    const symbol = receiverType.getSymbol();
    if (symbol && symbol.flags & ts.SymbolFlags.Class) {
      tsProps.add("prototype");
    }
  }

  // Get the first argument (the property name to check)
  const arg = expr.arguments[0];
  if (!arg) {
    // No argument — hasOwnProperty() with no args returns false in JS
    // Compile receiver for side effects
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Try to resolve the key at compile time
  let staticKey: string | null = null;
  if (ts.isStringLiteral(arg)) {
    staticKey = arg.text;
  } else if (ts.isNumericLiteral(arg)) {
    staticKey = arg.text;
  } else {
    // Check if TS can resolve the type to a string literal
    const argTsType = ctx.checker.getTypeAtLocation(arg);
    if (argTsType.isStringLiteral()) {
      staticKey = argTsType.value;
    }
  }

  if (staticKey !== null) {
    // Static resolution: check if the key is a known own property
    const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
    const hasInTs = tsProps.has(staticKey);
    const has = hasInStruct || hasInTs;

    // For propertyIsEnumerable, all struct/TS-visible own properties are enumerable
    // (non-enumerable properties are only created via Object.defineProperty with
    // enumerable:false, which uses the __pf_ side-table — we can't check that
    // statically, so for static keys known to be own, return true for both methods)

    // Compile receiver and argument for side effects, then drop
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }
    const argResultType = compileExpression(ctx, fctx, arg);
    if (argResultType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
    return { kind: "i32" };
  }

  // Dynamic key: runtime string comparison against known field names
  const allFieldNames = new Set<string>();
  if (structFieldNames) {
    for (const f of structFieldNames) allFieldNames.add(f);
  }
  for (const p of tsProps) allFieldNames.add(p);

  if (allFieldNames.size > 0) {
    // Ensure all field name strings are registered as globals
    for (const fieldName of allFieldNames) {
      if (!ctx.stringGlobalMap.has(fieldName)) {
        addStringConstantGlobal(ctx, fieldName);
      }
    }

    // Compile receiver for side effects, drop it
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }

    // Compile the key argument
    const keyType = compileExpression(ctx, fctx, arg);
    if (keyType) {
      const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
      const jsStrEquals = ctx.mod.imports.findIndex((imp) => imp.module === "wasm:js-string" && imp.name === "equals");
      const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
      if (eqFunc !== undefined && eqFunc >= 0) {
        const keyLocal = allocLocal(fctx, `__hop_key_${fctx.locals.length}`, keyType);
        fctx.body.push({ op: "local.set", index: keyLocal });
        // Start with false (0)
        fctx.body.push({ op: "i32.const", value: 0 });
        for (const fieldName of allFieldNames) {
          const strGlobal = ctx.stringGlobalMap.get(fieldName);
          if (strGlobal !== undefined) {
            fctx.body.push({ op: "local.get", index: keyLocal });
            fctx.body.push({ op: "global.get", index: strGlobal });
            fctx.body.push({ op: "call", funcIdx: eqFunc });
            fctx.body.push({ op: "i32.or" });
          }
        }
        return { kind: "i32" };
      }
    }
  }

  // Fallback: compile both sides for side effects, return false
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType) {
    fctx.body.push({ op: "drop" });
  }
  const argResultType = compileExpression(ctx, fctx, arg);
  if (argResultType) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32" };
}
