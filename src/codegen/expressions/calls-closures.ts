// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Closure and callable property call compilation:
 * - compileClosureCall — call to a closure variable
 * - compileGetterCallable — call where property is a getter returning a callable
 * - compileObjectPrototypeFallback — Object.prototype methods on class instances
 * - compileCallablePropertyCall — call to a callable struct field
 * - tryExternClassMethodOnAny — resolve method call on any-typed receiver via extern classes
 */
import ts from "typescript";
import { isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { getOrCreateFuncRefWrapperTypes } from "../closures.js";
import { allocLocal } from "../context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import { addFuncType, addImport, localGlobalIdx, resolveWasmType } from "../index.js";
import { emitNullCheckThrow } from "../property-access.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, VOID_RESULT } from "../shared.js";
import { emitGuardedFuncRefCast, emitGuardedRefCast, pushDefaultValue } from "../type-coercion.js";
import { getFuncParamTypes, getWasmFuncReturnType, isEffectivelyVoidReturn, wasmFuncReturnsVoid } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./late-imports.js";

/** Compile a call to a closure variable: closureVar(args...) */
export function compileClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  varName: string,
  info: ClosureInfo,
): InnerResult {
  const localIdx = fctx.localMap.get(varName);
  const moduleIdx = localIdx === undefined ? ctx.moduleGlobals.get(varName) : undefined;
  if (localIdx === undefined && moduleIdx === undefined) return null;

  // Determine how to push the closure ref (local vs module global).
  // If the value is externref (e.g. captured in a __cb_N callback or a module
  // global like `var f; f = () => {...}`), we need to convert to the expected
  // struct ref type before struct.get can be used.
  let effectiveLocalIdx = localIdx;
  if (localIdx !== undefined) {
    const localType =
      localIdx < fctx.params.length ? fctx.params[localIdx]?.type : fctx.locals[localIdx - fctx.params.length]?.type;
    // Boxed capture: the local is a ref cell wrapping the real value. Unwrap
    // it first, then coerce the underlying externref to the closure struct type
    // (#1048).
    const boxed = fctx.boxedCaptures?.get(varName);
    if (boxed) {
      const castType: ValType = { kind: "ref_null", typeIdx: info.structTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "local.get", index: localIdx });
      // struct.get $refCell $value — unwrap to underlying externref/ref
      fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
      if (boxed.valType.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      emitGuardedRefCast(fctx, info.structTypeIdx);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    } else if (localType?.kind === "externref") {
      // Convert externref → anyref → ref $closure_struct, store in a new local
      const castType: ValType = { kind: "ref_null", typeIdx: info.structTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "any.convert_extern" });
      // Guard cast to avoid illegal cast traps (#778)
      emitGuardedRefCast(fctx, info.structTypeIdx);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    }
  } else if (moduleIdx !== undefined) {
    // Module global: `var f; f = () => {...}; f(...)` — the global stores
    // externref. Convert to the expected closure struct ref (#852).
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const globalType = globalDef?.type;
    if (globalType?.kind === "externref") {
      const castType: ValType = { kind: "ref_null", typeIdx: info.structTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "global.get", index: moduleIdx });
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, info.structTypeIdx);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    }
  }

  const pushClosureRef = () => {
    if (effectiveLocalIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: effectiveLocalIdx });
    } else {
      fctx.body.push({ op: "global.get", index: moduleIdx! });
    }
    // Null-check → TypeError instead of trap on struct.get (#728, #441)
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: info.structTypeIdx });
  };

  // Stack for call_ref needs: [closure_ref, ...args, funcref]
  // where the lifted func type is (ref $closure_struct, ...arrowParams) → results

  // Push closure ref as first arg (self param of the lifted function)
  pushClosureRef();

  // Push call arguments (only up to the closure's declared parameter count)
  const paramCount = info.paramTypes.length;
  for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, info.paramTypes[i]);
  }

  // Drop excess arguments beyond the closure's parameter count (evaluate for side effects)
  for (let i = paramCount; i < expr.arguments.length; i++) {
    const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
    if (extraType !== null) {
      fctx.body.push({ op: "drop" });
    }
  }

  // Pad missing arguments with defaults (arity mismatch)
  for (let i = expr.arguments.length; i < info.paramTypes.length; i++) {
    pushDefaultValue(fctx, info.paramTypes[i]!, ctx);
  }

  // Push the funcref from the closure struct (field 0) and cast to typed ref
  pushClosureRef();
  fctx.body.push({
    op: "struct.get",
    typeIdx: info.structTypeIdx,
    fieldIdx: 0,
  });
  // Guard funcref cast to avoid illegal cast (#778)
  emitGuardedFuncRefCast(fctx, info.funcTypeIdx);
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: info.funcTypeIdx });

  // call_ref with the lifted function's type index
  fctx.body.push({ op: "call_ref", typeIdx: info.funcTypeIdx });

  // Return VOID_RESULT for void closures so compileExpression doesn't treat
  // the null return as a compilation failure and roll back the emitted instructions
  return info.returnType ?? VOID_RESULT;
}

/**
 * Handle calls where the property is a getter that returns a callable:
 * c.method(args) where `get method()` returns a function reference.
 *
 * Strategy: check if the getter returns a method of the same class
 * (common pattern: `get method() { return this.#method; }`).
 * If so, call the underlying method directly with the receiver.
 * Otherwise, call the getter and invoke the result via host import.
 */
export function compileGetterCallable(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  receiverClassName: string,
  getterIdx: number,
): InnerResult | undefined {
  // Get the getter's return type from the TS type system to find the call signature
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  const callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) return undefined;

  // The getter returns a callable. Check if we can resolve it to a known method
  // on the same class. Look for common patterns:
  // 1. get method() { return this.#privateMethod; } -> C___priv_privateMethod
  // 2. get method() { return this.otherMethod; } -> C_otherMethod

  // Try to find the underlying method by scanning known method names
  // Pattern: getter for propName might return a private method __priv_propName
  // or the same-named private method
  const methodName = ts.isPrivateIdentifier(propAccess.name)
    ? "__priv_" + propAccess.name.text.slice(1)
    : propAccess.name.text;
  const candidateNames = [
    `${receiverClassName}___priv_${methodName}`, // get method -> this.#method
    `${receiverClassName}_${methodName}`, // get method -> this.method (self-reference unlikely but check)
  ];
  // Also check all ancestor classes
  let ancestor = ctx.classParentMap.get(receiverClassName);
  while (ancestor) {
    candidateNames.push(`${ancestor}___priv_${methodName}`);
    candidateNames.push(`${ancestor}_${methodName}`);
    ancestor = ctx.classParentMap.get(ancestor);
  }

  for (const candidateName of candidateNames) {
    const candidateIdx = ctx.funcMap.get(candidateName);
    if (candidateIdx === undefined) continue;

    // Found the underlying method. Call it directly: C___priv_method(receiver, ...args)
    const structTypeIdx = ctx.structMap.get(receiverClassName);
    const paramTypes = getFuncParamTypes(ctx, candidateIdx);
    const recvTypeHint = paramTypes?.[0];
    const recvType = compileExpression(ctx, fctx, propAccess.expression, recvTypeHint);

    // Coerce receiver to match the function's first parameter type
    if (recvType && recvTypeHint) {
      if (
        recvType.kind === "externref" &&
        (recvTypeHint.kind === "ref" || recvTypeHint.kind === "ref_null") &&
        structTypeIdx !== undefined
      ) {
        // externref -> struct: convert via any.convert_extern + guarded cast
        fctx.body.push({ op: "any.convert_extern" } as Instr);
        emitGuardedRefCast(fctx, structTypeIdx);
      } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvTypeHint.kind === "externref") {
        // struct -> externref: convert via extern.convert_any
        fctx.body.push({ op: "extern.convert_any" } as Instr);
      } else if (recvType.kind !== recvTypeHint.kind) {
        // General type mismatch: use coerceType
        coerceType(ctx, fctx, recvType, recvTypeHint);
      }
    } else if (recvType && recvType.kind === "externref" && structTypeIdx !== undefined && recvTypeHint === undefined) {
      // Fallback: no param type info but we know the struct — cast to struct
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      emitGuardedRefCast(fctx, structTypeIdx);
    }

    // Push arguments (skip self at index 0)
    const methodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
    for (let i = 0; i < Math.min(expr.arguments.length, methodParamCount); i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
    }
    for (let i = methodParamCount; i < expr.arguments.length; i++) {
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Pad missing arguments
    if (paramTypes) {
      for (let i = Math.min(expr.arguments.length, methodParamCount) + 1; i < paramTypes.length; i++) {
        pushDefaultValue(fctx, paramTypes[i]!, ctx);
      }
    }

    // Re-lookup: receiver/arg compilation may have triggered late imports
    // (e.g. emitUndefined for missing tuple elements) that shift function indices.
    const finalCandidateIdx = ctx.funcMap.get(candidateName) ?? candidateIdx;
    fctx.body.push({ op: "call", funcIdx: finalCandidateIdx });

    // Determine return type
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isEffectivelyVoidReturn(ctx, retType, candidateName)) return VOID_RESULT;
      if (wasmFuncReturnsVoid(ctx, finalCandidateIdx)) return VOID_RESULT;
      return getWasmFuncReturnType(ctx, finalCandidateIdx) ?? resolveWasmType(ctx, retType);
    }
    return getWasmFuncReturnType(ctx, finalCandidateIdx) ?? VOID_RESULT;
  }

  return undefined; // Couldn't resolve to a known method
}

/**
 * Object.prototype method fallback for known class instances (#799 WI1).
 *
 * When a method call like `obj.toString()` cannot be resolved on a user-defined
 * class or its ancestors, this function checks if the method is an Object.prototype
 * method and emits host-delegated code via externref conversion.
 */
export function compileObjectPrototypeFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  receiverClassName: string,
  methodName: string,
): InnerResult | undefined {
  // toString: coerce receiver to externref and call __extern_toString
  if (methodName === "toString") {
    const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (toStrIdx !== undefined) {
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      return { kind: "externref" };
    }
    return undefined;
  }

  // toLocaleString: delegate to toString (ES spec default behavior)
  if (methodName === "toLocaleString") {
    const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (toStrIdx !== undefined) {
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      return { kind: "externref" };
    }
    return undefined;
  }

  // valueOf: return the receiver itself (Object.prototype.valueOf returns this)
  if (methodName === "valueOf") {
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
    return { kind: "externref" };
  }

  // hasOwnProperty: delegate to __hasOwnProperty host import
  if (methodName === "hasOwnProperty") {
    const hopIdx = ensureLateImport(
      ctx,
      "__hasOwnProperty",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (hopIdx !== undefined) {
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: hopIdx });
      return { kind: "i32" };
    }
    return undefined;
  }

  // propertyIsEnumerable: delegate to __propertyIsEnumerable host import
  if (methodName === "propertyIsEnumerable") {
    const pieIdx = ensureLateImport(
      ctx,
      "__propertyIsEnumerable",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (pieIdx !== undefined) {
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: pieIdx });
      return { kind: "i32" };
    }
    return undefined;
  }

  // isPrototypeOf: delegate to host __isPrototypeOf
  if (methodName === "isPrototypeOf") {
    const ipIdx = ensureLateImport(
      ctx,
      "__isPrototypeOf",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (ipIdx !== undefined) {
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: ipIdx });
      return { kind: "i32" };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Handle calls to callable struct fields: obj.callback() where callback
 * is a function-typed property stored in a struct field (not a method).
 * Returns undefined if the property is not a callable struct field,
 * allowing the caller to fall through to other handling.
 */
export function compileCallablePropertyCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  className: string,
): InnerResult | undefined {
  const methodName = ts.isPrivateIdentifier(propAccess.name)
    ? "__priv_" + propAccess.name.text.slice(1)
    : propAccess.name.text;

  // Check if this property name is a struct field
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return undefined;

  const fieldIdx = fields.findIndex((f) => f.name === methodName);
  if (fieldIdx === -1) return undefined;

  const fieldType = fields[fieldIdx]!.type;

  // The field must be a callable type — check via TS type checker
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  const callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) return undefined;

  const sig = callSigs[0]!;
  const sigParamCount = sig.parameters.length;
  const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
  const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
  const sigParamWasmTypes: ValType[] = [];
  for (let i = 0; i < sigParamCount; i++) {
    const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
    sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
  }

  // If the field is a ref type, check if it's a known closure struct
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    const closureInfo = ctx.closureInfoByTypeIdx.get((fieldType as { typeIdx: number }).typeIdx);
    if (closureInfo) {
      // Compile receiver, get field value (closure struct ref)
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      const closureLocal = allocLocal(fctx, `__cprop_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }

      // Push call arguments (only up to declared param count)
      {
        const cpParamCount = closureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, cpParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
        }
        // Drop excess arguments beyond param count (side effects only)
        for (let i = cpParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing arguments
      for (let i = expr.arguments.length; i < closureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, closureInfo.paramTypes[i]!, ctx);
      }

      // Get funcref from closure struct field 0 and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      fctx.body.push({
        op: "struct.get",
        typeIdx: (fieldType as { typeIdx: number }).typeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

      return closureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Field is externref — try to find or create matching closure wrapper types
  if (fieldType.kind === "externref") {
    const resultTypes = sigRetWasm ? [sigRetWasm] : [];
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);

    if (wrapperTypes) {
      const { structTypeIdx: wrapperStructIdx, closureInfo: matchedClosureInfo } = wrapperTypes;

      // Compile receiver, get field value (externref)
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Convert externref -> closure struct ref (guarded to avoid illegal cast)
      const closureRefType: ValType = {
        kind: "ref_null",
        typeIdx: wrapperStructIdx,
      };
      const closureLocal = allocLocal(fctx, `__cprop_ext_${fctx.locals.length}`, closureRefType);
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, wrapperStructIdx);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, closureRefType);

      // Push call arguments (only up to declared param count)
      {
        const wpParamCount = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, wpParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
        for (let i = wpParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing arguments
      for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // Get funcref from closure struct and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, closureRefType);
      fctx.body.push({
        op: "struct.get",
        typeIdx: wrapperStructIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // For ref types that aren't known closures, try matching against registered closure types
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    // Try to find a matching closure type by signature
    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length !== sigParamCount) continue;
      if (sigRetWasm === null && info.returnType !== null) continue;
      if (sigRetWasm !== null && info.returnType === null) continue;
      if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
      let paramsMatch = true;
      for (let i = 0; i < sigParamCount; i++) {
        if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
          paramsMatch = false;
          break;
        }
      }
      if (paramsMatch) {
        matchedClosureInfo = info;
        matchedStructTypeIdx = typeIdx;
        break;
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile receiver, get field value
      compileExpression(ctx, fctx, propAccess.expression);
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      const closureLocal = allocLocal(fctx, `__cprop_ref_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as self — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      // May need to cast to matching struct type — guard with ref.test (#778)
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        emitGuardedRefCast(fctx, matchedStructTypeIdx!);
      }

      // Push call arguments (only up to declared param count)
      {
        const cpRefParamCount = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, cpRefParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
        for (let i = cpRefParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // Get funcref and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        emitGuardedRefCast(fctx, matchedStructTypeIdx!);
      }
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  return undefined;
}

/**
 * Try to resolve a method call on an `any`-typed receiver through registered extern classes.
 * When the type checker resolves the receiver as `any` (e.g. when lib files aren't loaded
 * in ESM/bundled contexts), we dispatch known collection methods (Set.union, Map.get, etc.)
 * by looking them up in ctx.externClasses and lazily registering the import.
 */
export function tryExternClassMethodOnAny(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): InnerResult {
  // `.slice` is ambiguous across String, Array, ArrayBuffer, Blob, and every
  // TypedArray. When a RegExp literal elsewhere in the module causes typed
  // array extern classes to register before the call is compiled, first-match
  // iteration order binds `value.slice(n)` on an `any` receiver to
  // e.g. `Uint8ClampedArray_slice`, whose externref return type is incompatible
  // with an f64-expected context like `parseInt(value.slice(2), 2)` and
  // produces an invalid Wasm module (#1062). For `.slice` specifically we
  // refuse extern-class dispatch entirely and let the regular String/Array
  // code path handle it — other ambiguous methods (forEach, indexOf, etc.)
  // keep the historical first-match behavior.
  if (methodName === "slice") return null;

  for (const [key, info] of ctx.externClasses) {
    if (key !== info.className) continue;
    const sig = info.methods.get(methodName);
    if (!sig) continue;

    const importName = `${info.importPrefix}_${methodName}`;
    let funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const typeIdx = addFuncType(ctx, sig.params, sig.results);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      funcIdx = ctx.funcMap.get(importName);
    }
    if (funcIdx === undefined) continue;

    compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
    const argCount = sig.params.length - 1; // skip self
    for (let i = 0; i < expr.arguments.length && i < argCount; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    }
    for (let i = expr.arguments.length; i < argCount; i++) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    for (let i = argCount; i < expr.arguments.length; i++) {
      const argType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (argType) fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "call", funcIdx });
    if (sig.results.length === 0) return VOID_RESULT;
    return sig.results[0]!;
  }
  return null;
}
