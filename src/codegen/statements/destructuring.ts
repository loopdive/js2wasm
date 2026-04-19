// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Destructuring declaration lowering.
 * Handles object destructuring, array destructuring, and string destructuring patterns.
 */
import ts from "typescript";
import type { Instr, ValType } from "../../ir/types.js";
import { reportError } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { shiftLateImportIndices } from "../expressions/late-imports.js";
import { ensureNativeStringHelpers, ensureStructForType, nativeStringType, resolveWasmType } from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { buildDestructureNullThrow } from "../destructuring-params.js";
import { addImport, addStringConstantGlobal, localGlobalIdx } from "../registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec } from "../registry/types.js";
import {
  coerceType,
  compileExpression,
  emitBoundsCheckedArrayGet,
  registerEmitDefaultValueCheck,
  registerEmitNestedBindingDefault,
  registerEnsureBindingLocals,
  valTypesMatch,
  VOID_RESULT,
} from "../shared.js";
import { collectInstrs } from "./shared.js";

export function ensureBindingLocals(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      // Always create a shadow local, even for module globals.
      // syncDestructuredLocalsToGlobals will copy the local to the global afterwards.
      // Without a local, nested binding pattern destructuring silently skips the
      // assignment because fctx.localMap.get(name) returns undefined (#794).
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      allocLocal(fctx, name, wasmType);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      ensureBindingLocals(ctx, fctx, element.name);
    }
  }
}

/**
 * After destructuring, sync any bound locals that have corresponding module
 * globals. Destructuring stores values into locals, but module-level variables
 * need to also be written via global.set so other functions can read them.
 */
export function syncDestructuredLocalsToGlobals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        const moduleGlobalIdx = ctx.moduleGlobals.get(name);
        const localIdx = fctx.localMap.get(name);
        if (moduleGlobalIdx !== undefined && localIdx !== undefined) {
          const localType = getLocalType(fctx, localIdx);
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
          const globalType = globalDef?.type;
          fctx.body.push({ op: "local.get", index: localIdx });
          // Coerce local type to global type if they differ
          if (localType && globalType && !valTypesMatch(localType, globalType)) {
            coerceType(ctx, fctx, localType, globalType);
          }
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        syncDestructuredLocalsToGlobals(ctx, fctx, element.name);
      }
    }
  }
}

/**
 * Wrap a set of destructuring instructions in a null guard.
 *
 * For `ref_null` source types the instructions are only executed when the
 * reference is non-null:
 *
 *   local.get $srcLocal
 *   ref.is_null
 *   if (then: [] else: <instrs>)
 *
 * For non-nullable refs the instructions are emitted directly.
 *
 * `emitFn` should populate `fctx.body` with the instructions to guard.
 * The helper temporarily swaps `fctx.body` so the caller's body is not
 * modified by `emitFn`.
 */
export function emitNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  srcLocal: number,
  isNullable: boolean,
  emitFn: () => void,
  srcKind?: ValType["kind"],
): void {
  const guardInstrs = collectInstrs(fctx, emitFn);
  // Per spec §14.3.3.1/§8.4.2: destructuring null/undefined must throw TypeError.
  // Skip guard for empty patterns (#225) — only fire when there are real property accesses.
  if (isNullable && guardInstrs.length > 0) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    // For externref sources we also need to catch JS undefined (non-null externref
    // wrapping the undefined value). Emit a unified boolean: ref.is_null || __extern_is_undefined
    if (srcKind === "externref") {
      const undefIdx = ensureExternIsUndefined(ctx, fctx);
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "call", funcIdx: undefIdx });
        fctx.body.push({ op: "i32.or" } as unknown as Instr);
      }
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: guardInstrs });
    } else {
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: guardInstrs });
    }
  } else {
    fctx.body.push(...guardInstrs);
  }
}

/**
 * Ensure __async_iterator import is available.
 * Returns the function index, or undefined if registration failed.
 * JS impl: (obj) => obj[Symbol.asyncIterator]?.() ?? obj[Symbol.iterator]()
 */
export function ensureAsyncIterator(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ctx.funcMap.get("__async_iterator");
  if (idx !== undefined) return idx;
  const importsBefore = ctx.numImportFuncs;
  const fnType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__async_iterator", { kind: "func", typeIdx: fnType });
  shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
  return ctx.funcMap.get("__async_iterator");
}

/**
 * Ensure __extern_is_undefined import is available.
 * Returns the function index, or undefined if registration failed.
 * JS impl: (v: unknown) => v === undefined ? 1 : 0
 */
export function ensureExternIsUndefined(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ctx.funcMap.get("__extern_is_undefined");
  if (idx !== undefined) return idx;
  const importsBefore = ctx.numImportFuncs;
  const fnType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__extern_is_undefined", { kind: "func", typeIdx: fnType });
  shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
  return ctx.funcMap.get("__extern_is_undefined");
}

/**
 * Emit a check for whether an externref value should trigger a default value.
 * Per JS spec, destructuring defaults apply when the value is `undefined`.
 * We check both ref.is_null (wasm null, e.g. uninitialized array slots) and
 * JS undefined (non-null externref wrapping the JS undefined value).
 *
 * Precondition: externref value on the stack and saved in tmpLocal.
 * Postcondition: i32 on the stack (1 = use default, 0 = has value).
 */
export function emitExternrefDefaultCheck(ctx: CodegenContext, fctx: FunctionContext, tmpLocal: number): void {
  const isUndefIdx = ensureExternIsUndefined(ctx, fctx);
  if (isUndefIdx !== undefined) {
    // JS destructuring defaults apply only when value === undefined, NOT for null.
    // In the WebAssembly JS API, JS null maps to ref.null extern, so ref.is_null
    // would incorrectly trigger defaults for null values. Only use __extern_is_undefined.
    // The stack already has the externref from local.tee — call directly.
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
  } else {
    // Fallback: just ref.is_null (imprecise — treats null as undefined)
    fctx.body.push({ op: "ref.is_null" } as Instr);
  }
}

/**
 * Emit a default-value check for a nested binding pattern in array destructuring.
 *
 * When an array element is a nested binding pattern with a default initializer
 * (e.g. `[{ x, y } = defaults]`), we need to check if the extracted value is
 * null/undefined and if so, compile the initializer and store it as the value
 * before the nested destructuring runs.
 */
export function emitNestedBindingDefault(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nestedLocal: number,
  valueType: ValType,
  initializer: ts.Expression,
): void {
  // For ref/ref_null types, check ref.is_null
  if (valueType.kind === "ref" || valueType.kind === "ref_null") {
    fctx.body.push({ op: "local.get", index: nestedLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    const defaultInstrs = collectInstrs(fctx, () => {
      const initType = compileExpression(ctx, fctx, initializer, valueType);
      if (initType && !valTypesMatch(initType, valueType)) {
        coerceType(ctx, fctx, initType, valueType);
      }
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultInstrs,
        else: [],
      });
    }
  } else if (valueType.kind === "externref") {
    fctx.body.push({ op: "local.get", index: nestedLocal });
    emitExternrefDefaultCheck(ctx, fctx, nestedLocal);
    const defaultInstrs = collectInstrs(fctx, () => {
      const initType = compileExpression(ctx, fctx, initializer, valueType);
      if (initType && initType.kind !== "externref") {
        if (initType.kind === "ref" || initType.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" } as Instr);
        } else if (initType.kind === "f64") {
          const bIdx = ctx.funcMap.get("__box_number");
          if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
        } else if (initType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          const bIdx = ctx.funcMap.get("__box_number");
          if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
        }
      }
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultInstrs,
        else: [],
      });
    }
  } else if (valueType.kind === "f64") {
    // Check for sNaN sentinel (0x7FF00000DEADC0DE) — NOT generic NaN.
    // This distinguishes missing/undefined from explicit NaN arguments (#866).
    fctx.body.push({ op: "local.get", index: nestedLocal });
    fctx.body.push({ op: "i64.reinterpret_f64" } as unknown as Instr);
    fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
    fctx.body.push({ op: "i64.eq" });
    const defaultInstrs = collectInstrs(fctx, () => {
      compileExpression(ctx, fctx, initializer, valueType);
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultInstrs,
        else: [],
      });
    }
  }
  // For i32 there's no reliable sentinel — skip default check
}

/**
 * Emit a default-value check for a destructured binding.
 *
 * The stack must contain the extracted field/element value.  For externref
 * types we check `ref.is_null || __extern_is_undefined` — JS destructuring
 * defaults apply when the value is `undefined`.  For f64 we check for NaN
 * (the "undefined" sentinel).  For i32 there is no reliable sentinel so we
 * just assign directly.
 *
 * @param fieldType - the Wasm type of the value currently on the stack
 * @param localIdx  - destination local for the bound variable
 * @param initializer - the TS default-value expression
 * @param targetType  - optional override for the type hint passed to compileExpression
 */
export function emitDefaultValueCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  localIdx: number,
  initializer: ts.Expression,
  targetType?: ValType,
): void {
  const hintType = targetType ?? fieldType;

  // Build the else branch (value is NOT undefined — use it as-is, with coercion)
  const buildElseBranch = (tmpField: number): Instr[] => {
    if (targetType && !valTypesMatch(fieldType, targetType)) {
      // Need coercion from fieldType to targetType before storing
      return collectInstrs(fctx, () => {
        fctx.body.push({ op: "local.get", index: tmpField } as Instr);
        coerceType(ctx, fctx, fieldType, targetType);
        fctx.body.push({ op: "local.set", index: localIdx } as Instr);
      });
    }
    return [{ op: "local.get", index: tmpField } as Instr, { op: "local.set", index: localIdx } as Instr];
  };

  if (fieldType.kind === "externref") {
    const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.tee", index: tmpField });
    emitExternrefDefaultCheck(ctx, fctx, tmpField);
    const thenInstrs = collectInstrs(fctx, () => {
      compileExpression(ctx, fctx, initializer, hintType);
      fctx.body.push({ op: "local.set", index: localIdx } as Instr);
    });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: buildElseBranch(tmpField),
    });
  } else if (fieldType.kind === "f64") {
    const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.tee", index: tmpField });
    // Check for sNaN sentinel (0x7FF00000DEADC0DE) — NOT generic NaN.
    // This distinguishes missing/undefined from explicit NaN arguments (#866).
    fctx.body.push({ op: "i64.reinterpret_f64" } as unknown as Instr);
    fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
    fctx.body.push({ op: "i64.eq" });
    const thenInstrs = collectInstrs(fctx, () => {
      compileExpression(ctx, fctx, initializer, hintType);
      fctx.body.push({ op: "local.set", index: localIdx } as Instr);
    });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: buildElseBranch(tmpField),
    });
  } else if (fieldType.kind === "ref_null" || fieldType.kind === "ref") {
    // Nullable ref types: check ref.is_null for default value
    const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.tee", index: tmpField });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    const thenInstrs = collectInstrs(fctx, () => {
      compileExpression(ctx, fctx, initializer, hintType);
      fctx.body.push({ op: "local.set", index: localIdx } as Instr);
    });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: buildElseBranch(tmpField),
    });
  } else {
    // i32 and other types — no reliable undefined sentinel, just assign
    if (targetType && !valTypesMatch(fieldType, targetType)) {
      coerceType(ctx, fctx, fieldType, targetType);
    }
    fctx.body.push({ op: "local.set", index: localIdx });
  }
}

export function compileObjectDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (!decl.initializer) return;

  const pattern = decl.name as ts.ObjectBindingPattern;

  // Save body length so we can rollback if struct lookup fails
  const bodyLenBefore = fctx.body.length;

  // Compile the initializer — result is a struct ref on the stack
  const resultType = compileExpression(ctx, fctx, decl.initializer);
  if (!resultType) return;

  // If the result is already externref (or a scalar), use the externref fallback directly
  if (resultType.kind === "externref") {
    compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, resultType);
    return;
  }
  if (resultType.kind === "f64" || resultType.kind === "i32") {
    // Box scalar to externref and use externref fallback
    if (resultType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
      return;
    }
    // No __box_number available — fall through to error
  }

  // Determine struct type — prefer the actual Wasm type from compileExpression
  // over the TS checker, because anonymous object literals may register different
  // ts.Type objects for the initializer vs the destructuring pattern, leading to
  // mismatched struct type indices.
  let structTypeIdx: number | undefined;
  let fields: { name: string; type: ValType; mutable: boolean }[] | undefined;
  let typeName: string | undefined;

  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    const actualTypeIdx = (resultType as { typeIdx: number }).typeIdx;
    // Look up the struct name by its type index
    typeName = ctx.typeIdxToStructName.get(actualTypeIdx);
    if (typeName !== undefined) {
      structTypeIdx = actualTypeIdx;
      fields = ctx.structFields.get(typeName);
    }
  }

  // Fallback to TS checker resolution if resultType didn't give us a struct
  if (structTypeIdx === undefined || !fields) {
    const initType = ctx.checker.getTypeAtLocation(decl.initializer);
    const symName = initType.symbol?.name;
    typeName =
      symName && symName !== "__type" && symName !== "__object" && ctx.structMap.has(symName)
        ? symName
        : (ctx.anonTypeMap.get(initType) ?? symName);

    // Auto-register anonymous object types (same as expression-level destructuring)
    if (
      (!typeName || typeName === "__type" || typeName === "__object") &&
      !ctx.anonTypeMap.has(initType) &&
      initType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, initType);
      typeName = ctx.anonTypeMap.get(initType) ?? typeName;
    }

    if (!typeName) {
      // Type is unknown — fall back to externref property access
      if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" } as Instr);
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        return;
      }
      fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
      ensureBindingLocals(ctx, fctx, pattern);
      reportError(ctx, decl, "Cannot destructure: unknown type");
      return;
    }

    structTypeIdx = ctx.structMap.get(typeName);
    fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) {
      // Known type name but no struct — fall back to externref
      if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" } as Instr);
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        return;
      }
      fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
      ensureBindingLocals(ctx, fctx, pattern);
      reportError(ctx, decl, `Cannot destructure: not a known struct type: ${typeName}`);
      return;
    }
  }

  // Save the struct ref into a temp local so we can access fields multiple times
  const tmpLocal = allocLocal(fctx, `__destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard: throw TypeError if source is null (#728)
  emitNullGuard(ctx, fctx, tmpLocal, resultType.kind === "ref_null", () => {
    // For each binding element, create a local and extract the field
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const propNameNode = element.propertyName ?? element.name;
      const propName = ts.isIdentifier(propNameNode)
        ? propNameNode
        : ts.isStringLiteral(propNameNode)
          ? propNameNode
          : ts.isNumericLiteral(propNameNode)
            ? propNameNode
            : undefined;
      // Try resolving computed property names at compile time
      let propNameResolvedText: string | undefined;
      if (!propName && ts.isComputedPropertyName(propNameNode)) {
        propNameResolvedText = resolveComputedKeyExpression(ctx, propNameNode.expression);
      }

      // Handle nested binding patterns: const { b: { c, d } } = obj
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        const nestedPropName =
          element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName : undefined;
        // Also try computed key for nested patterns
        let nestedPropText: string | undefined;
        if (!nestedPropName && element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
          nestedPropText = resolveComputedKeyExpression(ctx, element.propertyName.expression);
        }
        if (!nestedPropName && !nestedPropText) {
          ensureBindingLocals(ctx, fctx, element.name);
          continue;
        }
        const nFieldIdx = fields.findIndex((f) => f.name === (nestedPropName ? nestedPropName.text : nestedPropText));
        if (nFieldIdx === -1) {
          ensureBindingLocals(ctx, fctx, element.name);
          continue;
        }
        const nField = fields[nFieldIdx];
        if (!nField) {
          ensureBindingLocals(ctx, fctx, element.name);
          continue;
        }
        const nFieldType = nField.type;
        const nestedTmp = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, nFieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: nFieldIdx });
        fctx.body.push({ op: "local.set", index: nestedTmp });

        // Recursively destructure the nested value (with null guard for ref_null)
        if (ts.isObjectBindingPattern(element.name) && (nFieldType.kind === "ref" || nFieldType.kind === "ref_null")) {
          const nestedTypeIdx = (nFieldType as { typeIdx: number }).typeIdx;
          const nestedStructName = ctx.typeIdxToStructName.get(nestedTypeIdx);
          const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
          if (nestedFields) {
            emitNullGuard(ctx, fctx, nestedTmp, nFieldType.kind === "ref_null", () => {
              for (const ne of (element.name as ts.ObjectBindingPattern).elements) {
                if (!ts.isBindingElement(ne)) continue;
                if (!ts.isIdentifier(ne.name)) continue;
                const nePropNode = ne.propertyName ?? ne.name;
                const nePropText = ts.isIdentifier(nePropNode)
                  ? nePropNode.text
                  : ts.isStringLiteral(nePropNode)
                    ? nePropNode.text
                    : undefined;
                if (!nePropText) continue;
                const neLocalName = ne.name.text;
                const neFieldIdx = nestedFields.findIndex((f) => f.name === nePropText);
                if (neFieldIdx === -1) continue;
                const neField = nestedFields[neFieldIdx];
                if (!neField) continue;
                const neFieldType = neField.type;
                const neLocalIdx = allocLocal(fctx, neLocalName, neFieldType);
                fctx.body.push({ op: "local.get", index: nestedTmp });
                fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: neFieldIdx });
                fctx.body.push({ op: "local.set", index: neLocalIdx });
              }
            });
          } else {
            ensureBindingLocals(ctx, fctx, element.name);
          }
        } else if (
          ts.isArrayBindingPattern(element.name) &&
          (nFieldType.kind === "ref" || nFieldType.kind === "ref_null")
        ) {
          const nestedVecTypeIdx = (nFieldType as { typeIdx: number }).typeIdx;
          const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
          const nestedArrDef = ctx.mod.types[nestedArrTypeIdx];
          if (nestedArrDef && nestedArrDef.kind === "array") {
            const nestedElemType = nestedArrDef.element;
            emitNullGuard(ctx, fctx, nestedTmp, nFieldType.kind === "ref_null", () => {
              for (let j = 0; j < (element.name as ts.ArrayBindingPattern).elements.length; j++) {
                const ne = (element.name as ts.ArrayBindingPattern).elements[j]!;
                if (ts.isOmittedExpression(ne)) continue;
                if (!ts.isIdentifier((ne as ts.BindingElement).name)) continue;
                const neName = ((ne as ts.BindingElement).name as ts.Identifier).text;
                const neLocalIdx = allocLocal(fctx, neName, nestedElemType);
                fctx.body.push({ op: "local.get", index: nestedTmp });
                fctx.body.push({ op: "struct.get", typeIdx: nestedVecTypeIdx, fieldIdx: 1 });
                fctx.body.push({ op: "i32.const", value: j });
                emitBoundsCheckedArrayGet(fctx, nestedArrTypeIdx, nestedElemType);
                fctx.body.push({ op: "local.set", index: neLocalIdx });
              }
            });
          } else {
            ensureBindingLocals(ctx, fctx, element.name);
          }
        } else {
          ensureBindingLocals(ctx, fctx, element.name);
        }
        continue;
      }

      // Handle rest element: const { a, ...rest } = obj
      // Convert struct to externref and use __extern_rest_object to collect remaining props
      if (element.dotDotDotToken) {
        if (ts.isIdentifier(element.name)) {
          const restName = element.name.text;
          let restIdx = fctx.localMap.get(restName);
          if (restIdx === undefined) {
            restIdx = allocLocal(fctx, restName, { kind: "externref" });
          }
          // Collect already-destructured property names to exclude
          const excludedKeys: string[] = [];
          for (const el of pattern.elements) {
            if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
            const pn = el.propertyName ?? el.name;
            if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
            else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
            else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
          }
          // Use __extern_rest_object(externObj, excludedKeysStr)
          let restObjIdx = ctx.funcMap.get("__extern_rest_object");
          if (restObjIdx === undefined) {
            const importsBefore = ctx.numImportFuncs;
            const restObjType = addFuncType(
              ctx,
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
            shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
            restObjIdx = ctx.funcMap.get("__extern_rest_object");
          }
          if (restObjIdx !== undefined) {
            const excludedStr = excludedKeys.join(",");
            addStringConstantGlobal(ctx, excludedStr);
            const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
            if (excludedStrIdx !== undefined) {
              // Convert struct ref to externref
              fctx.body.push({ op: "local.get", index: tmpLocal });
              fctx.body.push({ op: "extern.convert_any" } as Instr);
              fctx.body.push({ op: "global.get", index: excludedStrIdx });
              fctx.body.push({ op: "call", funcIdx: restObjIdx });
              fctx.body.push({ op: "local.set", index: restIdx });
            }
          }
        }
        continue;
      }

      if (!ts.isIdentifier(element.name)) continue;
      const localName = element.name.text;

      if (!propName && !propNameResolvedText) continue;
      const propNameText = propName ? propName.text : propNameResolvedText!;
      const fieldIdx = fields.findIndex((f) => f.name === propNameText);
      if (fieldIdx === -1) {
        reportError(ctx, element, `Unknown field in destructuring: ${propNameText}`);
        continue;
      }

      const field = fields[fieldIdx];
      if (!field) continue;
      const fieldType = field.type;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Handle default value: `const { x = defaultVal } = obj`
      if (element.initializer) {
        emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }); // end null guard

  // Sync destructured locals to module globals
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

/**
 * Destructure an externref value using __extern_get(obj, key_string) for each property.
 * Fallback for when the source type is unknown/any/externref (no struct info available).
 */
export function compileExternrefObjectDestructuringDecl(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectBindingPattern,
  resultType: ValType,
): void {
  // Store externref in temp local
  const tmpLocal = allocLocal(fctx, `__ext_obj_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) {
    ensureBindingLocals(ctx, fctx, pattern);
    return;
  }

  // Pre-allocate all binding locals
  ensureBindingLocals(ctx, fctx, pattern);

  // Null guard: skip destructuring if source is null
  const isNullable = resultType.kind === "externref" || resultType.kind === "ref_null";
  emitNullGuard(
    ctx,
    fctx,
    tmpLocal,
    isNullable,
    () => {
      // Collect non-rest property names for __extern_rest_object exclusion
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

        // Handle rest element: const { a, ...rest } = externObj
        if (element.dotDotDotToken) {
          if (ts.isIdentifier(element.name)) {
            const restName = element.name.text;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            // Use __extern_rest_object(obj, excludedKeysStr)
            let restObjIdx = ctx.funcMap.get("__extern_rest_object");
            if (restObjIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const restObjType = addFuncType(
                ctx,
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "externref" }],
              );
              addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              restObjIdx = ctx.funcMap.get("__extern_rest_object");
              getIdx = ctx.funcMap.get("__extern_get");
            }
            if (restObjIdx !== undefined) {
              const excludedStr = excludedKeys.join(",");
              addStringConstantGlobal(ctx, excludedStr);
              const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
              if (excludedStrIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: tmpLocal });
                fctx.body.push({ op: "global.get", index: excludedStrIdx });
                fctx.body.push({ op: "call", funcIdx: restObjIdx });
                fctx.body.push({ op: "local.set", index: restIdx });
              }
            }
          }
          continue;
        }

        // Determine the property name to look up
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

        // Emit: __extern_get(tmpLocal, "propName") -> externref
        // Register the property name as a string constant global
        addStringConstantGlobal(ctx, propNameText);
        const strGlobalIdx = ctx.stringGlobalMap.get(propNameText);
        if (strGlobalIdx === undefined) continue;

        // Refresh getIdx in case addStringConstantGlobal shifted indices
        getIdx = ctx.funcMap.get("__extern_get");
        if (getIdx === undefined) continue;

        fctx.body.push({ op: "local.get", index: tmpLocal });
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

          // Handle default value: check ref.is_null || __extern_is_undefined
          if (element.initializer) {
            const tmpElem = allocLocal(fctx, `__ext_obj_dflt_${fctx.locals.length}`, elemType);
            fctx.body.push({ op: "local.tee", index: tmpElem });
            emitExternrefDefaultCheck(ctx, fctx, tmpElem);
            const thenInstrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, element.initializer!, localType ?? elemType);
              fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
            });
            const elseCoerce =
              localType && !valTypesMatch(elemType, localType)
                ? collectInstrs(fctx, () => {
                    coerceType(ctx, fctx, elemType, localType!);
                  })
                : [];
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
          // Nested destructuring on externref — recursively destructure
          const nestedLocal = allocLocal(fctx, `__ext_nested_${fctx.locals.length}`, elemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          ensureBindingLocals(ctx, fctx, element.name);
          if (ts.isObjectBindingPattern(element.name)) {
            fctx.body.push({ op: "local.get", index: nestedLocal });
            compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, elemType);
          } else {
            fctx.body.push({ op: "local.get", index: nestedLocal });
            compileExternrefArrayDestructuringDecl(ctx, fctx, element.name, elemType);
          }
        }
      }
    },
    resultType.kind,
  ); // end null guard

  // Sync destructured locals to module globals
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

/**
 * Destructure an externref value using __extern_get(obj, boxed_index) for each element.
 * Handles cases where the RHS is dynamically typed (e.g. arguments, iterators, function returns).
 */
export function compileExternrefArrayDestructuringDecl(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayBindingPattern,
  resultType: ValType,
): void {
  // Store externref in temp local
  const tmpLocal = allocLocal(fctx, `__ext_arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Per spec §8.4.2 GetIterator: throw TypeError if value is null/undefined.
  // Array destructuring requires GetIterator on the source — which aborts on null/undefined.
  // Skip for empty `[]` patterns (#225) — only fire when there are real element accesses.
  if ((resultType.kind === "externref" || resultType.kind === "ref_null") && pattern.elements.length > 0) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
    if (resultType.kind === "externref") {
      const undefIdx = ensureExternIsUndefined(ctx, fctx);
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "call", funcIdx: undefIdx });
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
      }
    }
  }

  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) {
    ensureBindingLocals(ctx, fctx, pattern);
    return;
  }

  // Ensure __box_number is available (needed to convert index to externref)
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    // Also refresh getIdx since it may have shifted
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) {
    ensureBindingLocals(ctx, fctx, pattern);
    return;
  }

  // Pre-allocate all binding locals
  ensureBindingLocals(ctx, fctx, pattern);

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;
    if (!ts.isBindingElement(element)) continue;

    // Handle rest element: const [...rest] = arr
    // Use __extern_get to build a JS array slice from index i onwards
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        const restName = element.name.text;
        let restIdx = fctx.localMap.get(restName);
        if (restIdx === undefined) {
          restIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        // Use Array.prototype.slice via __extern_call_slice if available,
        // or build rest via __extern_get in a loop
        // For now, use __extern_get to collect: rest = arr.slice(i)
        // We need a host helper for slicing — just store the original array for now
        // and let the JS side handle .slice() via externref
        let sliceIdx = ctx.funcMap.get("__extern_slice");
        if (sliceIdx === undefined) {
          const importsBefore = ctx.numImportFuncs;
          const sliceType = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
          addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
          shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
          sliceIdx = ctx.funcMap.get("__extern_slice");
          // Refresh other indices
          boxIdx = ctx.funcMap.get("__box_number");
          getIdx = ctx.funcMap.get("__extern_get");
        }
        if (sliceIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "f64.const", value: i });
          fctx.body.push({ op: "call", funcIdx: sliceIdx });
          fctx.body.push({ op: "local.set", index: restIdx });
        }
      }
      continue;
    }

    // Emit: __extern_get(tmpLocal, box(i)) -> externref
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "f64.const", value: i });
    fctx.body.push({ op: "call", funcIdx: boxIdx! });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    const elemType: ValType = { kind: "externref" };

    if (ts.isIdentifier(element.name)) {
      const localName = element.name.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      const localType = getLocalType(fctx, localIdx);

      // Handle default value: const [a = defaultVal] = arr
      // Check ref.is_null || __extern_is_undefined (JS undefined != wasm null)
      if (element.initializer) {
        const tmpElem = allocLocal(fctx, `__ext_dflt_${fctx.locals.length}`, elemType);
        fctx.body.push({ op: "local.tee", index: tmpElem });
        emitExternrefDefaultCheck(ctx, fctx, tmpElem);
        const thenInstrs = collectInstrs(fctx, () => {
          compileExpression(ctx, fctx, element.initializer!, localType ?? elemType);
          fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
        });
        const elseCoerce =
          localType && !valTypesMatch(elemType, localType)
            ? collectInstrs(fctx, () => {
                coerceType(ctx, fctx, elemType, localType!);
              })
            : [];
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
      // Nested destructuring on externref — recursively destructure
      const nestedLocal = allocLocal(fctx, `__ext_arr_nested_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: nestedLocal });

      // Handle default initializer: if value is null/undefined, use the default
      if (element.initializer) {
        fctx.body.push({ op: "local.get", index: nestedLocal });
        emitExternrefDefaultCheck(ctx, fctx, nestedLocal);
        const defaultInstrs = collectInstrs(fctx, () => {
          const initType = compileExpression(ctx, fctx, element.initializer!, elemType);
          if (initType && initType.kind !== "externref") {
            if (initType.kind === "ref" || initType.kind === "ref_null") {
              fctx.body.push({ op: "extern.convert_any" } as Instr);
            } else if (initType.kind === "f64") {
              const bIdx = ctx.funcMap.get("__box_number");
              if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
            } else if (initType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
              const bIdx = ctx.funcMap.get("__box_number");
              if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
            }
          }
          fctx.body.push({ op: "local.set", index: nestedLocal });
        });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: defaultInstrs,
          else: [],
        });
      }

      ensureBindingLocals(ctx, fctx, element.name);
      if (ts.isObjectBindingPattern(element.name)) {
        fctx.body.push({ op: "local.get", index: nestedLocal });
        compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, elemType);
      } else {
        fctx.body.push({ op: "local.get", index: nestedLocal });
        compileExternrefArrayDestructuringDecl(ctx, fctx, element.name, elemType);
      }
    }
  }
}

export function compileArrayDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (!decl.initializer) return;

  const pattern = decl.name as ts.ArrayBindingPattern;
  const bodyLenBefore = fctx.body.length;

  // When the pattern has rest elements, force vec mode for the initializer so
  // array literals produce a full vec (not a truncated tuple matching the binding pattern type)
  const patternHasRest = pattern.elements.some((el) => ts.isBindingElement(el) && el.dotDotDotToken);
  if (patternHasRest) (ctx as any)._arrayLiteralForceVec = true;
  const resultType = compileExpression(ctx, fctx, decl.initializer);
  if (patternHasRest) (ctx as any)._arrayLiteralForceVec = false;
  if (!resultType) return;

  if (resultType.kind !== "ref" && resultType.kind !== "ref_null") {
    if (resultType.kind === "externref") {
      compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, resultType);
      syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
      return;
    }
    // For f64/i32 — box to externref and use externref fallback
    if (resultType.kind === "f64" || resultType.kind === "i32") {
      if (resultType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
    }
    fctx.body.length = bodyLenBefore;
    ensureBindingLocals(ctx, fctx, pattern);
    reportError(ctx, decl, "Cannot destructure: not an array type");
    return;
  }

  const typeIdx = (resultType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle vec struct (array wrapped in {length, data})
  if (!typeDef || typeDef.kind !== "struct") {
    // Non-struct ref: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  const isVecArray = arrDef && arrDef.kind === "array";

  // Check if this is a tuple struct (fields named _0, _1, etc.)
  // Note: 0-field structs are treated as empty tuples so that defaults apply correctly
  // when the pattern has more elements than the tuple (e.g. `var [{x}={x:1}] = []`)
  const isTupleStruct =
    !isVecArray &&
    typeDef.kind === "struct" &&
    (typeDef.fields.length === 0 || typeDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`));

  // Check if this is a string type (AnyString, NativeString, ConsString)
  const isStringStruct =
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    (typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx || typeIdx === ctx.consStrTypeIdx);

  if (!isVecArray && !isTupleStruct && !isStringStruct) {
    // Unknown struct: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  // String destructuring: use __str_charAt to extract individual characters
  if (isStringStruct) {
    compileStringDestructuring(ctx, fctx, pattern, resultType, bodyLenBefore);
    return;
  }

  // Store ref in temp local
  const tmpLocal = allocLocal(fctx, `__destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  const isNullableArr = resultType.kind === "ref_null";

  // When the pattern has rest elements, tuples may not have enough fields;
  // convert to externref and use __extern_slice for the rest
  const hasRestElement = pattern.elements.some((el) => ts.isBindingElement(el) && el.dotDotDotToken);

  if (isTupleStruct && hasRestElement) {
    // Tuple + rest: convert to externref and use externref fallback which
    // handles rest via __extern_slice
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  if (isTupleStruct) {
    // Tuple destructuring: extract fields directly from the struct by index
    const tupleFields = (typeDef as { fields: { name?: string; type: ValType }[] }).fields;

    // Pre-allocate all binding locals so they exist even when the tuple is
    // shorter than the pattern (e.g. `var [x] = []`) (#379)
    ensureBindingLocals(ctx, fctx, pattern);

    emitNullGuard(ctx, fctx, tmpLocal, isNullableArr, () => {
      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;

        // When tuple is shorter than pattern, apply defaults if present
        if (i >= tupleFields.length) {
          if (ts.isBindingElement(element) && element.initializer) {
            if (ts.isIdentifier(element.name)) {
              const localName = element.name.text;
              const localIdx = fctx.localMap.get(localName);
              if (localIdx !== undefined) {
                const localType = fctx.locals[localIdx]!.type;
                compileExpression(ctx, fctx, element.initializer, localType);
                fctx.body.push({ op: "local.set", index: localIdx });
              }
            } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
              // Nested binding pattern with default: compile default and destructure it
              ensureBindingLocals(ctx, fctx, element.name);
              (ctx as any)._arrayLiteralForceVec = true;
              let initType: ValType | null | typeof VOID_RESULT;
              try {
                initType = compileExpression(ctx, fctx, element.initializer);
              } finally {
                (ctx as any)._arrayLiteralForceVec = false;
              }
              if (initType) {
                if (
                  (initType.kind === "ref" || initType.kind === "ref_null") &&
                  ts.isObjectBindingPattern(element.name)
                ) {
                  const initTypeIdx = (initType as { typeIdx: number }).typeIdx;
                  const tmpObjLocal = allocLocal(fctx, `__dflt_obj_${fctx.locals.length}`, initType);
                  fctx.body.push({ op: "local.set", index: tmpObjLocal });
                  const nestedStructName = ctx.typeIdxToStructName.get(initTypeIdx);
                  const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
                  if (nestedFields) {
                    for (const nestedElem of element.name.elements) {
                      if (!ts.isBindingElement(nestedElem)) continue;
                      const propNNode = nestedElem.propertyName ?? nestedElem.name;
                      const propNText = ts.isIdentifier(propNNode)
                        ? propNNode.text
                        : ts.isStringLiteral(propNNode)
                          ? propNNode.text
                          : ts.isNumericLiteral(propNNode)
                            ? propNNode.text
                            : undefined;
                      if (!ts.isIdentifier(nestedElem.name)) continue;
                      if (!propNText) continue;
                      const nLocalName = nestedElem.name.text;
                      const nFieldIdx = nestedFields.findIndex((f) => f.name === propNText);
                      if (nFieldIdx === -1) continue;
                      const nFieldEntry = nestedFields[nFieldIdx];
                      if (!nFieldEntry) continue;
                      const nLocalIdx = fctx.localMap.get(nLocalName);
                      if (nLocalIdx === undefined) continue;
                      fctx.body.push({ op: "local.get", index: tmpObjLocal });
                      fctx.body.push({ op: "struct.get", typeIdx: initTypeIdx, fieldIdx: nFieldIdx });
                      const localType = getLocalType(fctx, nLocalIdx);
                      const fType = nFieldEntry.type;
                      if (localType && !valTypesMatch(fType, localType)) {
                        coerceType(ctx, fctx, fType, localType);
                      }
                      fctx.body.push({ op: "local.set", index: nLocalIdx });
                    }
                  }
                } else if (
                  (initType.kind === "ref" || initType.kind === "ref_null") &&
                  ts.isArrayBindingPattern(element.name)
                ) {
                  const initTypeIdx = (initType as { typeIdx: number }).typeIdx;
                  const initTypeDef = ctx.mod.types[initTypeIdx];
                  if (initTypeDef && initTypeDef.kind === "struct") {
                    const initArrTypeIdx = getArrTypeIdxFromVec(ctx, initTypeIdx);
                    const initArrDef = ctx.mod.types[initArrTypeIdx];
                    if (initArrDef && initArrDef.kind === "array") {
                      const tmpVecLocal = allocLocal(fctx, `__dflt_vec_${fctx.locals.length}`, initType);
                      fctx.body.push({ op: "local.set", index: tmpVecLocal });
                      const initElemType = initArrDef.element;
                      for (let j = 0; j < element.name.elements.length; j++) {
                        const ne = element.name.elements[j]!;
                        if (ts.isOmittedExpression(ne)) continue;
                        if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                        const nName = ne.name.text;
                        const nLocalIdx = fctx.localMap.get(nName);
                        if (nLocalIdx === undefined) continue;
                        fctx.body.push({ op: "local.get", index: tmpVecLocal });
                        fctx.body.push({ op: "struct.get", typeIdx: initTypeIdx, fieldIdx: 1 });
                        fctx.body.push({ op: "i32.const", value: j });
                        emitBoundsCheckedArrayGet(fctx, initArrTypeIdx, initElemType);
                        const localType = getLocalType(fctx, nLocalIdx);
                        if (localType && !valTypesMatch(initElemType, localType)) {
                          coerceType(ctx, fctx, initElemType, localType);
                        }
                        fctx.body.push({ op: "local.set", index: nLocalIdx });
                      }
                    } else {
                      // Tuple struct default — extract fields by index
                      const tupleDefFields = (initTypeDef as { fields: { name?: string; type: ValType }[] }).fields;
                      const tmpTupleLocal = allocLocal(fctx, `__dflt_tuple_${fctx.locals.length}`, initType);
                      fctx.body.push({ op: "local.set", index: tmpTupleLocal });
                      for (let j = 0; j < element.name.elements.length; j++) {
                        const ne = element.name.elements[j]!;
                        if (ts.isOmittedExpression(ne)) continue;
                        if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                        if (j >= tupleDefFields.length) break;
                        const nName = ne.name.text;
                        const nLocalIdx = fctx.localMap.get(nName);
                        if (nLocalIdx === undefined) continue;
                        const tfType = tupleDefFields[j]!.type;
                        fctx.body.push({ op: "local.get", index: tmpTupleLocal });
                        fctx.body.push({ op: "struct.get", typeIdx: initTypeIdx, fieldIdx: j });
                        const localType = getLocalType(fctx, nLocalIdx);
                        if (localType && !valTypesMatch(tfType, localType)) {
                          coerceType(ctx, fctx, tfType, localType);
                        }
                        fctx.body.push({ op: "local.set", index: nLocalIdx });
                      }
                    }
                  } else {
                    fctx.body.push({ op: "drop" } as Instr);
                  }
                } else {
                  // Non-ref default value: convert to externref and use externref destructuring
                  if (initType.kind === "f64") {
                    const bIdx = ctx.funcMap.get("__box_number");
                    if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
                  } else if (initType.kind === "i32") {
                    fctx.body.push({ op: "f64.convert_i32_s" });
                    const bIdx = ctx.funcMap.get("__box_number");
                    if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
                  } else if (initType.kind !== "externref") {
                    if (initType.kind === "ref" || initType.kind === "ref_null") {
                      fctx.body.push({ op: "extern.convert_any" } as Instr);
                    }
                  }
                  if (ts.isArrayBindingPattern(element.name)) {
                    compileExternrefArrayDestructuringDecl(ctx, fctx, element.name, { kind: "externref" });
                  } else {
                    compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, { kind: "externref" });
                  }
                }
              }
            }
          }
          continue;
        }

        const fieldType = tupleFields[i]!.type;

        // Handle rest element — skip for tuples (not meaningful)
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;
          allocLocal(fctx, restName, { kind: "externref" });
          continue;
        }

        // Handle nested binding patterns
        if (
          ts.isBindingElement(element) &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
        ) {
          const nestedLocal = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });
          fctx.body.push({ op: "local.set", index: nestedLocal });

          // Handle default initializer: if value is null/undefined, use the default
          if (element.initializer) {
            (ctx as any)._arrayLiteralForceVec = true;
            try {
              emitNestedBindingDefault(ctx, fctx, nestedLocal, fieldType, element.initializer);
            } finally {
              (ctx as any)._arrayLiteralForceVec = false;
            }
          }

          ensureBindingLocals(ctx, fctx, element.name);

          // For ref types, try native struct field access instead of externref fallback
          if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
            const nestedTypeIdx = (fieldType as { typeIdx: number }).typeIdx;
            const nestedTypeDef = ctx.mod.types[nestedTypeIdx];

            if (ts.isObjectBindingPattern(element.name)) {
              // Object binding pattern: extract fields by name from the struct
              const nestedStructName = ctx.typeIdxToStructName.get(nestedTypeIdx);
              const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
              if (nestedFields) {
                for (const nestedElem of element.name.elements) {
                  if (!ts.isBindingElement(nestedElem)) continue;
                  const propNNode = nestedElem.propertyName ?? nestedElem.name;
                  const propNText = ts.isIdentifier(propNNode)
                    ? propNNode.text
                    : ts.isStringLiteral(propNNode)
                      ? propNNode.text
                      : ts.isNumericLiteral(propNNode)
                        ? propNNode.text
                        : undefined;
                  if (!ts.isIdentifier(nestedElem.name)) continue;
                  if (!propNText) continue;
                  const nLocalName = nestedElem.name.text;
                  const nFieldIdx = nestedFields.findIndex((f) => f.name === propNText);
                  if (nFieldIdx === -1) continue;
                  const nFieldEntry = nestedFields[nFieldIdx];
                  if (!nFieldEntry) continue;
                  const nLocalIdx = fctx.localMap.get(nLocalName);
                  if (nLocalIdx === undefined) continue;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: nFieldIdx });
                  const localType = getLocalType(fctx, nLocalIdx);
                  const fType = nFieldEntry.type;
                  if (localType && !valTypesMatch(fType, localType)) {
                    coerceType(ctx, fctx, fType, localType);
                  }
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
                continue;
              }
            } else if (ts.isArrayBindingPattern(element.name)) {
              // Check if nested is a tuple struct
              const isNestedTuple =
                nestedTypeDef &&
                nestedTypeDef.kind === "struct" &&
                nestedTypeDef.fields.length > 0 &&
                nestedTypeDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);
              if (isNestedTuple) {
                // Extract fields directly from the nested tuple struct
                const nestedFields = (nestedTypeDef as { fields: { name?: string; type: ValType }[] }).fields;
                for (let j = 0; j < element.name.elements.length; j++) {
                  const ne = element.name.elements[j]!;
                  if (ts.isOmittedExpression(ne)) continue;
                  if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                  if (j >= nestedFields.length) continue;
                  const nName = ne.name.text;
                  let nLocalIdx = fctx.localMap.get(nName);
                  if (nLocalIdx === undefined) {
                    const nTsType = ctx.checker.getTypeAtLocation(ne);
                    nLocalIdx = allocLocal(fctx, nName, resolveWasmType(ctx, nTsType));
                  }
                  const nLocalType = getLocalType(fctx, nLocalIdx);
                  const nFieldType = nestedFields[j]!.type;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: j });
                  if (nLocalType && !valTypesMatch(nFieldType, nLocalType)) {
                    coerceType(ctx, fctx, nFieldType, nLocalType);
                  }
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
                continue;
              }
              // Vec array destructuring
              const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedTypeIdx);
              const nestedArrDef = ctx.mod.types[nestedArrTypeIdx];
              if (nestedArrDef && nestedArrDef.kind === "array") {
                const nestedElemType = nestedArrDef.element;
                for (let j = 0; j < element.name.elements.length; j++) {
                  const ne = element.name.elements[j]!;
                  if (ts.isOmittedExpression(ne)) continue;
                  if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                  const nName = ne.name.text;
                  const nLocalIdx = fctx.localMap.get(nName);
                  if (nLocalIdx === undefined) continue;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: 1 });
                  fctx.body.push({ op: "i32.const", value: j });
                  emitBoundsCheckedArrayGet(fctx, nestedArrTypeIdx, nestedElemType);
                  const localType = getLocalType(fctx, nLocalIdx);
                  if (localType && !valTypesMatch(nestedElemType, localType)) {
                    coerceType(ctx, fctx, nestedElemType, localType);
                  }
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
                continue;
              }
            }
          }

          // Fallback: convert to externref and recursively destructure
          fctx.body.push({ op: "local.get", index: nestedLocal });
          if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" } as Instr);
          } else if (fieldType.kind === "f64") {
            const bIdx = ctx.funcMap.get("__box_number");
            if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
          } else if (fieldType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const bIdx = ctx.funcMap.get("__box_number");
            if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
          }

          if (ts.isArrayBindingPattern(element.name)) {
            compileExternrefArrayDestructuringDecl(ctx, fctx, element.name, { kind: "externref" });
          } else {
            compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, { kind: "externref" });
          }
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        // Reuse existing local (from ensureBindingLocals) if available;
        // for module globals, create a local with the checker's resolved type
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          const elemTsType = ctx.checker.getTypeAtLocation(element);
          const resolvedType = resolveWasmType(ctx, elemTsType);
          localIdx = allocLocal(fctx, localName, resolvedType);
        }
        const localType = getLocalType(fctx, localIdx);

        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });

        // Coerce field type to local type if they differ (e.g. externref -> f64)
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }

        // Handle default value: `const [a = defaultVal] = tuple`
        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, localType ?? fieldType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for tuple path
    // Sync destructured locals to module globals
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  // Vec array destructuring (original path)
  if (!arrDef || arrDef.kind !== "array") return;
  const elemType = arrDef.element;

  emitNullGuard(ctx, fctx, tmpLocal, isNullableArr, () => {
    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue; // skip holes: [a, , c]

      // Handle rest element: const [a, ...rest] = arr
      if (ts.isBindingElement(element) && element.dotDotDotToken) {
        // Compute rest length: max(0, original.length - i)
        const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
        // First compute len - i and store it
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
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
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // src data
        fctx.body.push({ op: "i32.const", value: i });
        fctx.body.push({ op: "local.get", index: restLenLocal });
        fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

        // Create new vec struct: struct.new(restLen, restArr)
        fctx.body.push({ op: "local.get", index: restLenLocal });
        fctx.body.push({ op: "local.get", index: restArrLocal });
        fctx.body.push({ op: "struct.new", typeIdx } as Instr);

        if (ts.isIdentifier(element.name)) {
          // Simple rest: const [...x] = arr
          const restName = element.name.text;
          const restLocal = allocLocal(fctx, restName, resultType);
          fctx.body.push({ op: "local.set", index: restLocal });
        } else if (ts.isArrayBindingPattern(element.name)) {
          // Nested rest with array pattern: const [...[...x]] = arr or const [...[a, b]] = arr
          const nestedTmpLocal = allocLocal(fctx, `__rest_nested_${fctx.locals.length}`, resultType);
          fctx.body.push({ op: "local.set", index: nestedTmpLocal });
          ensureBindingLocals(ctx, fctx, element.name);

          // Now destructure the rest vec into the nested pattern
          for (let j = 0; j < element.name.elements.length; j++) {
            const ne = element.name.elements[j]!;
            if (ts.isOmittedExpression(ne)) continue;
            const neBinding = ne as ts.BindingElement;

            if (neBinding.dotDotDotToken && ts.isIdentifier(neBinding.name)) {
              // Nested rest: [...[...x]] — x gets a sub-array from j onwards
              const innerRestLenLocal = allocLocal(fctx, `__inner_rest_len_${fctx.locals.length}`, { kind: "i32" });
              // Compute len - j and store it
              fctx.body.push({ op: "local.get", index: nestedTmpLocal });
              fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 });
              fctx.body.push({ op: "i32.const", value: j });
              fctx.body.push({ op: "i32.sub" } as Instr);
              fctx.body.push({ op: "local.set", index: innerRestLenLocal });
              // Clamp to 0: select(0, len-j, len-j < 0)
              fctx.body.push({ op: "i32.const", value: 0 } as Instr);
              fctx.body.push({ op: "local.get", index: innerRestLenLocal });
              fctx.body.push({ op: "local.get", index: innerRestLenLocal });
              fctx.body.push({ op: "i32.const", value: 0 } as Instr);
              fctx.body.push({ op: "i32.lt_s" } as Instr);
              fctx.body.push({ op: "select" } as Instr);
              fctx.body.push({ op: "local.set", index: innerRestLenLocal });

              const innerRestArrLocal = allocLocal(fctx, `__inner_rest_arr_${fctx.locals.length}`, {
                kind: "ref",
                typeIdx: arrTypeIdx,
              });
              fctx.body.push({ op: "local.get", index: innerRestLenLocal });
              fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
              fctx.body.push({ op: "local.set", index: innerRestArrLocal });

              fctx.body.push({ op: "local.get", index: innerRestArrLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: nestedTmpLocal });
              fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
              fctx.body.push({ op: "i32.const", value: j });
              fctx.body.push({ op: "local.get", index: innerRestLenLocal });
              fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

              fctx.body.push({ op: "local.get", index: innerRestLenLocal });
              fctx.body.push({ op: "local.get", index: innerRestArrLocal });
              fctx.body.push({ op: "struct.new", typeIdx } as Instr);
              const innerRestLocal = fctx.localMap.get(neBinding.name.text);
              if (innerRestLocal === undefined) continue;
              fctx.body.push({ op: "local.set", index: innerRestLocal });
            } else if (ts.isIdentifier(neBinding.name)) {
              // Simple element: [...[a, b]] — extract element j
              const nLocalIdx = fctx.localMap.get(neBinding.name.text);
              if (nLocalIdx === undefined) continue;
              fctx.body.push({ op: "local.get", index: nestedTmpLocal });
              fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
              fctx.body.push({ op: "i32.const", value: j });
              emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);
              fctx.body.push({ op: "local.set", index: nLocalIdx });
            }
          }
        } else {
          // Object binding or other unsupported pattern — drop the value
          fctx.body.push({ op: "drop" } as Instr);
          ensureBindingLocals(ctx, fctx, element.name as ts.BindingPattern);
        }
        continue;
      }

      // Handle nested binding patterns: const [{ x, y }] = arr or const [[a, b]] = arr
      if (
        ts.isBindingElement(element) &&
        (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
      ) {
        const hasDefault = !!element.initializer;

        if (hasDefault && elemType.kind === "externref") {
          // For externref elements with nested patterns + defaults:
          // The array element is externref, but the default initializer (e.g. [4, 5, 6])
          // will compile to a WasmGC vec struct. We need to handle both cases:
          // - If the runtime value is present (non-null externref) → use externref destructuring
          // - If null/undefined → compile default, which produces a WasmGC vec, destructure it directly
          ensureBindingLocals(ctx, fctx, element.name);

          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);

          const nestedExtLocal = allocLocal(fctx, `__ext_nested_${fctx.locals.length}`, elemType);
          fctx.body.push({ op: "local.set", index: nestedExtLocal });

          // Check if the value is null/undefined
          fctx.body.push({ op: "local.get", index: nestedExtLocal });
          emitExternrefDefaultCheck(ctx, fctx, nestedExtLocal);

          // Default branch: compile default, get a WasmGC value, destructure it directly
          (ctx as any)._arrayLiteralForceVec = true;
          const defaultBranch = collectInstrs(fctx, () => {
            // Don't pass elemType as hint -- it may be externref which would coerce
            // the struct result to externref, preventing native struct field access.
            const initType = compileExpression(ctx, fctx, element.initializer!);
            (ctx as any)._arrayLiteralForceVec = false;
            // The default value (e.g. [4,5,6]) produces a WasmGC vec struct.
            // Destructure it directly using typed access instead of externref path.
            if (initType && (initType.kind === "ref" || initType.kind === "ref_null")) {
              const initTypeIdx = (initType as { typeIdx: number }).typeIdx;
              const initTypeDef = ctx.mod.types[initTypeIdx];
              if (initTypeDef && initTypeDef.kind === "struct") {
                const initArrTypeIdx = getArrTypeIdxFromVec(ctx, initTypeIdx);
                const initArrDef = ctx.mod.types[initArrTypeIdx];
                if (ts.isArrayBindingPattern(element.name) && initArrDef && initArrDef.kind === "array") {
                  // Store the vec in a temp local and extract elements
                  const tmpVecLocal = allocLocal(fctx, `__dflt_vec_${fctx.locals.length}`, initType);
                  fctx.body.push({ op: "local.set", index: tmpVecLocal });
                  const initElemType = initArrDef.element;
                  for (let j = 0; j < element.name.elements.length; j++) {
                    const ne = element.name.elements[j]!;
                    if (ts.isOmittedExpression(ne)) continue;
                    if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                    const nName = ne.name.text;
                    const nLocalIdx = fctx.localMap.get(nName);
                    if (nLocalIdx === undefined) continue;
                    fctx.body.push({ op: "local.get", index: tmpVecLocal });
                    fctx.body.push({ op: "struct.get", typeIdx: initTypeIdx, fieldIdx: 1 });
                    fctx.body.push({ op: "i32.const", value: j });
                    emitBoundsCheckedArrayGet(fctx, initArrTypeIdx, initElemType);
                    // Coerce to the local's type if needed
                    const localType = getLocalType(fctx, nLocalIdx);
                    if (localType && !valTypesMatch(initElemType, localType)) {
                      coerceType(ctx, fctx, initElemType, localType);
                    }
                    fctx.body.push({ op: "local.set", index: nLocalIdx });
                  }
                  return; // done — skip the drop below
                }
                if (ts.isObjectBindingPattern(element.name)) {
                  // Store in temp local and extract struct fields
                  const tmpObjLocal = allocLocal(fctx, `__dflt_obj_${fctx.locals.length}`, initType);
                  fctx.body.push({ op: "local.set", index: tmpObjLocal });
                  const nestedStructName = ctx.typeIdxToStructName.get(initTypeIdx);
                  const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
                  if (nestedFields) {
                    for (const nestedElem of element.name.elements) {
                      if (!ts.isBindingElement(nestedElem)) continue;
                      const propNNode = nestedElem.propertyName ?? nestedElem.name;
                      const propNText = ts.isIdentifier(propNNode)
                        ? propNNode.text
                        : ts.isStringLiteral(propNNode)
                          ? propNNode.text
                          : ts.isNumericLiteral(propNNode)
                            ? propNNode.text
                            : undefined;
                      if (!ts.isIdentifier(nestedElem.name)) continue;
                      if (!propNText) continue;
                      const nLocalName = nestedElem.name.text;
                      const nFieldIdx = nestedFields.findIndex((f) => f.name === propNText);
                      if (nFieldIdx === -1) continue;
                      const nLocalIdx = fctx.localMap.get(nLocalName);
                      if (nLocalIdx === undefined) continue;
                      fctx.body.push({ op: "local.get", index: tmpObjLocal });
                      fctx.body.push({ op: "struct.get", typeIdx: initTypeIdx, fieldIdx: nFieldIdx });
                      const localType = getLocalType(fctx, nLocalIdx);
                      const fType = nestedFields[nFieldIdx]!.type;
                      if (localType && !valTypesMatch(fType, localType)) {
                        coerceType(ctx, fctx, fType, localType);
                      }
                      fctx.body.push({ op: "local.set", index: nLocalIdx });
                    }
                    return; // done
                  }
                }
              }
            }
            // Fallback: if the default didn't produce a WasmGC type we can handle,
            // convert to externref and use the externref destructuring path
            if (initType && initType.kind !== "externref") {
              if (initType.kind === "ref" || initType.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" } as Instr);
              } else if (initType.kind === "f64") {
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
            fctx.body.push({ op: "local.set", index: nestedExtLocal });
          });
          // Non-default (else) branch: value exists, use externref destructuring
          const elseBranch = collectInstrs(fctx, () => {
            if (ts.isArrayBindingPattern(element.name)) {
              fctx.body.push({ op: "local.get", index: nestedExtLocal });
              compileExternrefArrayDestructuringDecl(ctx, fctx, element.name, elemType);
            }
            if (ts.isObjectBindingPattern(element.name)) {
              fctx.body.push({ op: "local.get", index: nestedExtLocal });
              compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, elemType);
            }
          });

          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: defaultBranch,
            else: elseBranch,
          });
        } else if (hasDefault) {
          // For ref/ref_null elements with nested patterns + defaults:
          // 1. Get element from array with nullable type (avoid trap on out-of-bounds)
          // 2. Use emitDefaultValueCheck to handle null → default initializer
          // 3. Destructure from the local afterward
          //
          // We set _arrayLiteralForceVec to prevent compileArrayLiteral from choosing
          // the tuple path — TS contextual type in binding patterns resolves as tuple,
          // but the parent vec expects a vec type.
          ensureBindingLocals(ctx, fctx, element.name);

          // Use nullable type so bounds-checked get returns null instead of trapping
          const nullableElemType: ValType =
            elemType.kind === "ref"
              ? { kind: "ref_null", typeIdx: (elemType as { typeIdx: number }).typeIdx }
              : elemType;
          const nestedLocal = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, nullableElemType);

          // Get the element value from the array (leaves value on stack)
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, arrTypeIdx, nullableElemType);

          // emitDefaultValueCheck consumes the value on the stack, applies default if null,
          // and stores the result in nestedLocal. Force vec mode for array literal defaults.
          (ctx as any)._arrayLiteralForceVec = true;
          try {
            emitDefaultValueCheck(ctx, fctx, nullableElemType, nestedLocal, element.initializer!);
          } finally {
            (ctx as any)._arrayLiteralForceVec = false;
          }

          // Now destructure from nestedLocal (guaranteed non-null after default check)
          if (elemType.kind === "ref" || elemType.kind === "ref_null") {
            if (ts.isObjectBindingPattern(element.name)) {
              const nestedTypeIdx = (elemType as { typeIdx: number }).typeIdx;
              const nestedStructName = ctx.typeIdxToStructName.get(nestedTypeIdx);
              const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
              if (nestedFields) {
                for (const nestedElem of element.name.elements) {
                  if (!ts.isBindingElement(nestedElem)) continue;
                  const propNNode = nestedElem.propertyName ?? nestedElem.name;
                  const propNText = ts.isIdentifier(propNNode)
                    ? propNNode.text
                    : ts.isStringLiteral(propNNode)
                      ? propNNode.text
                      : ts.isNumericLiteral(propNNode)
                        ? propNNode.text
                        : undefined;
                  if (!ts.isIdentifier(nestedElem.name)) continue;
                  if (!propNText) continue;
                  const nLocalName = nestedElem.name.text;
                  const nFieldIdx = nestedFields.findIndex((f) => f.name === propNText);
                  if (nFieldIdx === -1) continue;
                  const nFieldEntry = nestedFields[nFieldIdx];
                  if (!nFieldEntry) continue;
                  const nLocalIdx = fctx.localMap.get(nLocalName);
                  if (nLocalIdx === undefined) continue;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: nFieldIdx });
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
              }
            } else if (ts.isArrayBindingPattern(element.name)) {
              const nestedVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
              const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
              const nestedArrDef = ctx.mod.types[nestedArrTypeIdx];
              if (nestedArrDef && nestedArrDef.kind === "array") {
                const nestedElemType = nestedArrDef.element;
                for (let j = 0; j < element.name.elements.length; j++) {
                  const ne = element.name.elements[j]!;
                  if (ts.isOmittedExpression(ne)) continue;
                  if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                  const nName = ne.name.text;
                  const nLocalIdx = fctx.localMap.get(nName);
                  if (nLocalIdx === undefined) continue;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedVecTypeIdx, fieldIdx: 1 });
                  fctx.body.push({ op: "i32.const", value: j });
                  emitBoundsCheckedArrayGet(fctx, nestedArrTypeIdx, nestedElemType);
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
              }
            }
          }
        } else {
          // No default initializer — original path
          const nestedLocal = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, elemType);
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          ensureBindingLocals(ctx, fctx, element.name);
          // If the element type is a ref, try to destructure it properly
          if (elemType.kind === "ref" || elemType.kind === "ref_null") {
            if (ts.isObjectBindingPattern(element.name)) {
              const nestedTypeIdx = (elemType as { typeIdx: number }).typeIdx;
              const nestedStructName = ctx.typeIdxToStructName.get(nestedTypeIdx);
              const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
              if (nestedFields) {
                for (const nestedElem of element.name.elements) {
                  if (!ts.isBindingElement(nestedElem)) continue;
                  const propNNode = nestedElem.propertyName ?? nestedElem.name;
                  const propNText = ts.isIdentifier(propNNode)
                    ? propNNode.text
                    : ts.isStringLiteral(propNNode)
                      ? propNNode.text
                      : ts.isNumericLiteral(propNNode)
                        ? propNNode.text
                        : undefined;
                  if (!ts.isIdentifier(nestedElem.name)) continue;
                  if (!propNText) continue;
                  const nLocalName = nestedElem.name.text;
                  const nFieldIdx = nestedFields.findIndex((f) => f.name === propNText);
                  if (nFieldIdx === -1) continue;
                  const nFieldEntry = nestedFields[nFieldIdx];
                  if (!nFieldEntry) continue;
                  const nLocalIdx = fctx.localMap.get(nLocalName);
                  if (nLocalIdx === undefined) continue;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: nFieldIdx });
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
              }
            } else if (ts.isArrayBindingPattern(element.name)) {
              const nestedVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
              const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
              const nestedArrDef = ctx.mod.types[nestedArrTypeIdx];
              if (nestedArrDef && nestedArrDef.kind === "array") {
                const nestedElemType = nestedArrDef.element;
                for (let j = 0; j < element.name.elements.length; j++) {
                  const ne = element.name.elements[j]!;
                  if (ts.isOmittedExpression(ne)) continue;
                  if (!ts.isBindingElement(ne) || !ts.isIdentifier(ne.name)) continue;
                  const nName = ne.name.text;
                  const nLocalIdx = fctx.localMap.get(nName);
                  if (nLocalIdx === undefined) continue;
                  fctx.body.push({ op: "local.get", index: nestedLocal });
                  fctx.body.push({ op: "struct.get", typeIdx: nestedVecTypeIdx, fieldIdx: 1 });
                  fctx.body.push({ op: "i32.const", value: j });
                  emitBoundsCheckedArrayGet(fctx, nestedArrTypeIdx, nestedElemType);
                  fctx.body.push({ op: "local.set", index: nLocalIdx });
                }
              }
            }
          } else if (elemType.kind === "externref") {
            // Externref elements: use the externref destructuring path
            if (ts.isArrayBindingPattern(element.name)) {
              fctx.body.push({ op: "local.get", index: nestedLocal });
              compileExternrefArrayDestructuringDecl(ctx, fctx, element.name, elemType);
            }
            if (ts.isObjectBindingPattern(element.name)) {
              fctx.body.push({ op: "local.get", index: nestedLocal });
              compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, elemType);
            }
          }
        }
        continue;
      }

      if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
      const localName = element.name.text;
      const localIdx = allocLocal(fctx, localName, elemType);

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);

      // Handle default value: `const [a = defaultVal] = arr`
      if (element.initializer) {
        emitDefaultValueCheck(ctx, fctx, elemType, localIdx, element.initializer);
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }); // end null guard for vec array path

  // Sync destructured locals to module globals
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

/**
 * Compile array destructuring of a string value.
 * Each binding variable gets a single-character string via __str_charAt.
 * e.g. `const [a, b, c] = "abc"` -> a = charAt(str, 0), b = charAt(str, 1), c = charAt(str, 2)
 */
function compileStringDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayBindingPattern,
  resultType: ValType,
  bodyLenBefore: number,
): void {
  // Ensure __str_charAt is available
  ensureNativeStringHelpers(ctx);
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (charAtIdx === undefined) {
    fctx.body.length = bodyLenBefore;
    ensureBindingLocals(ctx, fctx, pattern);
    reportError(ctx, pattern, "Cannot destructure string: __str_charAt helper not available");
    return;
  }

  const strType = nativeStringType(ctx);

  // Store string ref in temp local
  const tmpLocal = allocLocal(fctx, `__destruct_str_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullable = resultType.kind === "ref_null";
  const savedBody = fctx.body;
  const destructInstrs: Instr[] = [];
  fctx.body = destructInstrs;

  // Pre-allocate all binding locals
  ensureBindingLocals(ctx, fctx, pattern);

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Rest element: const [a, ...rest] = "hello" — convert to externref and use __extern_slice
    if (ts.isBindingElement(element) && element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        const restName = element.name.text;
        let restIdx = fctx.localMap.get(restName);
        if (restIdx === undefined) {
          restIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        // Use __extern_slice(str_as_externref, i)
        let sliceIdx = ctx.funcMap.get("__extern_slice");
        if (sliceIdx === undefined) {
          const importsBefore = ctx.numImportFuncs;
          const sliceType = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
          addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
          shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
          sliceIdx = ctx.funcMap.get("__extern_slice");
        }
        if (sliceIdx !== undefined) {
          // Convert string to externref
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "extern.convert_any" } as Instr);
          fctx.body.push({ op: "f64.const", value: i });
          fctx.body.push({ op: "call", funcIdx: sliceIdx });
          fctx.body.push({ op: "local.set", index: restIdx });
        }
      }
      continue;
    }

    // Nested patterns: skip for strings
    if (
      ts.isBindingElement(element) &&
      (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
    ) {
      ensureBindingLocals(ctx, fctx, element.name);
      continue;
    }

    if (!ts.isIdentifier(element.name)) continue;
    const localName = element.name.text;
    const localIdx = allocLocal(fctx, localName, strType);

    // Call charAt(str, i)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "call", funcIdx: charAtIdx });
    fctx.body.push({ op: "local.set", index: localIdx });
  }

  // Close null guard
  fctx.body = savedBody;
  if (isNullable && destructInstrs.length > 0) {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: destructInstrs });
  } else {
    fctx.body.push(...destructInstrs);
  }
}

// Register delegates in shared.ts so index.ts can call these without
// importing statements/destructuring.ts directly (which would create cycles).
registerEnsureBindingLocals(ensureBindingLocals);
registerEmitNestedBindingDefault(emitNestedBindingDefault);
registerEmitDefaultValueCheck(emitDefaultValueCheck);
