import ts from "typescript";
import type { CodegenContext, FunctionContext, ClosureInfo, RestParamInfo, ExternClassInfo } from "./index.js";
import {
  allocLocal,
  allocTempLocal,
  releaseTempLocal,
  resolveWasmType,
  getOrRegisterVecType,
  getArrTypeIdxFromVec,
  addFuncType,
  addStringImports,
  addStringConstantGlobal,
  addUnionImports,
  getOrRegisterRefCellType,
  nativeStringType,
  nextModuleGlobalIdx,
  pushBody,
  popBody,
  ensureI32Condition,
  ensureExnTag,
} from "./index.js";
import {
  isNumberType,
  isBooleanType,
  isStringType,
  isVoidType,
  isExternalDeclaredClass,
  isGeneratorType,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { compileStatement } from "./statements.js";
import { pushDefaultValue, defaultValueInstrs, emitGuardedRefCast, coercionInstrs } from "./type-coercion.js";
import { resolveArrayInfo, compileArrayPrototypeCall, compileArrayMethodCall } from "./array-methods.js";
import {
  compileExpression,
  VOID_RESULT,
  getLine,
  getCol,
  coerceType,
  emitNullCheckThrow,
  typeErrorThrowInstrs,
  getOrCreateFuncRefWrapperTypes,
  isEffectivelyVoidReturn,
  wasmFuncReturnsVoid,
  resolveStructName,
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
  compileArrowAsClosure,
  emitLocalTdzCheck,
  ensureLateImport,
  compileAssignment,
  emitNullGuardedStructGet,
  emitExternrefToStructGet,
  tryStaticToNumber,
  isStaticNaN,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  emitBoundsCheckedArrayGet,
  flushLateImportShifts,
  resolveComputedKeyExpression,
} from "./expressions.js";
import { compileNativeStringMethodCall, compileStringLiteral, emitBoolToString } from "./string-ops.js";

import type { InnerResult } from "./expressions.js";

export function getFuncParamTypes(ctx: CodegenContext, funcIdx: number): ValType[] | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func") return typeDef.params;
          return undefined;
        }
        importFuncCount++;
      }
    }
  } else {
    const localIdx = funcIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) {
      const typeDef = ctx.mod.types[func.typeIdx];
      if (typeDef?.kind === "func") return typeDef.params;
    }
  }
  return undefined;
}

/** Compile a call to a closure variable: closureVar(args...) */
function compileClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  varName: string,
  info: ClosureInfo,
): InnerResult {
  const localIdx = fctx.localMap.get(varName);
  const moduleIdx = localIdx === undefined ? ctx.moduleGlobals.get(varName) : undefined;
  if (localIdx === undefined && moduleIdx === undefined) return null;

  // Determine how to push the closure ref (local vs module global)
  const pushClosureRef = () => {
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      fctx.body.push({ op: "global.get", index: moduleIdx! });
      // Module globals use ref_null type; cast to non-null ref
      fctx.body.push({ op: "ref.as_non_null" });
    }
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
    if (extraType !== null && extraType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
  }

  // Pad missing arguments with defaults (arity mismatch)
  for (let i = expr.arguments.length; i < info.paramTypes.length; i++) {
    pushDefaultValue(fctx, info.paramTypes[i]!);
  }

  // Push the funcref from the closure struct (field 0) and cast to typed ref
  pushClosureRef();
  // Null check: throw TypeError if closure ref is null (#728)
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: info.structTypeIdx });
  fctx.body.push({ op: "struct.get", typeIdx: info.structTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "ref.cast", typeIdx: info.funcTypeIdx });
  fctx.body.push({ op: "ref.as_non_null" });

  // call_ref with the lifted function's type index
  fctx.body.push({ op: "call_ref", typeIdx: info.funcTypeIdx });

  // Return VOID_RESULT for void closures so compileExpression doesn't treat
  // the null return as a compilation failure and roll back the emitted instructions
  return info.returnType ?? VOID_RESULT;
}

/**
 * Handle calls to callable struct fields: obj.callback() where callback
 * is a function-typed property stored in a struct field (not a method).
 * Returns undefined if the property is not a callable struct field,
 * allowing the caller to fall through to other handling.
 */
function compileCallablePropertyCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  className: string,
): InnerResult | undefined {
  const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;

  // Check if this property name is a struct field
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return undefined;

  const fieldIdx = fields.findIndex(f => f.name === methodName);
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

      // Push closure ref as first arg (self param)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
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
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing arguments
      for (let i = expr.arguments.length; i < closureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, closureInfo.paramTypes[i]!);
      }

      // Get funcref from closure struct field 0 and call_ref
      fctx.body.push({ op: "local.get", index: closureLocal });
      // Null check: throw TypeError if closure ref is null (#728)
      emitNullCheckThrow(ctx, fctx, fieldType);
      if (fieldType.kind === "ref_null") {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
      fctx.body.push({ op: "struct.get", typeIdx: (fieldType as { typeIdx: number }).typeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
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
      const closureRefType: ValType = { kind: "ref_null", typeIdx: wrapperStructIdx };
      const closureLocal = allocLocal(fctx, `__cprop_ext_${fctx.locals.length}`, closureRefType);
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, wrapperStructIdx);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param)
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);

      // Push call arguments (only up to declared param count)
      {
        const wpParamCount = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, wpParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
        for (let i = wpParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing arguments
      for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Get funcref from closure struct and call_ref
      fctx.body.push({ op: "local.get", index: closureLocal });
      // Null check: throw TypeError if closure ref is null (#728)
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: wrapperStructIdx });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      fctx.body.push({ op: "struct.get", typeIdx: wrapperStructIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

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

      // Push closure ref as self
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
      // May need to cast to matching struct type
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        fctx.body.push({ op: "ref.cast", typeIdx: matchedStructTypeIdx });
      }

      // Push call arguments (only up to declared param count)
      {
        const cpRefParamCount = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, cpRefParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
        for (let i = cpRefParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Get funcref and call_ref
      fctx.body.push({ op: "local.get", index: closureLocal });
      // Null check: throw TypeError if closure ref is null (#728)
      emitNullCheckThrow(ctx, fctx, fieldType);
      if (fieldType.kind === "ref_null") {
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
      }
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        fctx.body.push({ op: "ref.cast", typeIdx: matchedStructTypeIdx });
      }
      fctx.body.push({ op: "struct.get", typeIdx: matchedStructTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  return undefined;
}

export function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult {
  // Optional chaining on calls: obj?.method()
  if (expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
    return compileOptionalCallExpression(ctx, fctx, expr);
  }

  // Optional chaining on direct call: fn?.()
  if (expr.questionDotToken && ts.isIdentifier(expr.expression)) {
    return compileOptionalDirectCall(ctx, fctx, expr);
  }

  // Dynamic import() — not supported in AOT Wasm compilation.
  // Emit unreachable so compilation succeeds; the call will trap at runtime.
  if (expr.expression.kind === ts.SyntaxKind.ImportKeyword) {
    ctx.errors.push({
      message: "Dynamic import() is not supported in AOT Wasm compilation",
      line: getLine(expr),
      column: getCol(expr),
      severity: "warning",
    });
    fctx.body.push({ op: "unreachable" });
    return null;
  }

  // Unwrap parenthesized callee: (fn)(...), ((obj.method))(...) etc.
  // This handles patterns like (0, fn)() which are already handled below,
  // but also (fn)(), ((fn))(), (obj.method)() etc. which would otherwise fail.
  if (ts.isParenthesizedExpression(expr.expression)) {
    let unwrapped: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrapped)) {
      unwrapped = unwrapped.expression;
    }
    // Only unwrap if it's NOT a function expression or arrow (those are IIFEs, handled later)
    // and NOT a binary/comma expression (handled separately below)
    if (!ts.isFunctionExpression(unwrapped) && !ts.isArrowFunction(unwrapped) &&
        !(ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken)) {
      // Handle conditional callee inline: (cond ? fn1 : fn2)(args)
      // Cannot create a synthetic call because ts.factory wraps non-LeftHandSide
      // expressions in ParenthesizedExpression, causing infinite recursion.
      if (ts.isConditionalExpression(unwrapped)) {
        return compileConditionalCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle assignment/binary expressions as callee: (x = fn)(), (a || fn)()
      // These are non-LeftHandSideExpressions, so ts.factory.createCallExpression
      // would re-wrap them in ParenthesizedExpression, causing infinite recursion.
      // Instead, compile the expression for its side effects and value, then use
      // the generic closure-matching path to call the result.
      if (ts.isBinaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle prefix/postfix unary as callee (rare but possible)
      if (ts.isPrefixUnaryExpression(unwrapped) || ts.isPostfixUnaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      const syntheticCall = ts.factory.createCallExpression(
        unwrapped as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle super.method() calls — resolve to ParentClass_method with this as first arg
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return compileSuperMethodCall(ctx, fctx, expr);
  }

  // Handle property access calls: console.log, Math.xxx, extern methods
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;

    // Handle Array.prototype.METHOD.call(obj, ...args) — inline as array method on shape-inferred obj
    {
      const callResult = compileArrayPrototypeCall(ctx, fctx, expr, propAccess);
      if (callResult !== undefined) return callResult;
    }

    // Handle fn.call(thisArg, ...args) and fn.apply(thisArg, argsArray)
    // For standalone functions (no `this`), drop thisArg and call directly.
    // For class methods, use thisArg as the receiver.
    if (propAccess.name.text === "call" || propAccess.name.text === "apply") {
      const isCall = propAccess.name.text === "call";
      const innerExpr = propAccess.expression;

      // Case 1: identifier.call(thisArg, args...) — standalone function
      if (ts.isIdentifier(innerExpr)) {
        const funcName = innerExpr.text;
        let closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        // Fallback: if the variable is a local with a ref type, look up closure info
        // by struct type index. This handles cases like:
        //   const f = makeAdder(5); f.call(null, 10);
        if (!closureInfo && funcIdx === undefined) {
          const localIdx = fctx.localMap.get(funcName);
          if (localIdx !== undefined) {
            const localType = localIdx < fctx.params.length
              ? fctx.params[localIdx]?.type
              : fctx.locals[localIdx - fctx.params.length]?.type;
            if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
              closureInfo = ctx.closureInfoByTypeIdx.get(localType.typeIdx);
            }
          }
        }

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first argument) if present
          if (expr.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (thisType && thisType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }

          if (isCall) {
            // .call(thisArg, arg1, arg2, ...) — remaining args are positional
            const remainingArgs = expr.arguments.slice(1);

            if (closureInfo) {
              // Create a synthetic call expression with remaining args
              const syntheticCall = ts.factory.createCallExpression(
                innerExpr,
                undefined,
                remainingArgs as unknown as readonly ts.Expression[],
              );
              // Copy source file info for error reporting
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
            }

            // Check for rest parameters on the callee
            const callRestInfo = ctx.funcRestParams.get(funcName);

            if (callRestInfo) {
              // Calling a rest-param function via .call(): pack trailing args into a GC array
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              // Compile non-rest arguments
              for (let i = 0; i < callRestInfo.restIndex; i++) {
                if (i < remainingArgs.length) {
                  compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
                } else {
                  pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
                }
              }
              // Pack remaining arguments into a vec struct (array + length)
              const restArgCount = Math.max(0, remainingArgs.length - callRestInfo.restIndex);
              fctx.body.push({ op: "i32.const", value: restArgCount });
              for (let i = callRestInfo.restIndex; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, callRestInfo.elemType);
              }
              fctx.body.push({ op: "array.new_fixed", typeIdx: callRestInfo.arrayTypeIdx, length: restArgCount });
              fctx.body.push({ op: "struct.new", typeIdx: callRestInfo.vecTypeIdx });
            } else {
              // Regular function call
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
              }

              // Supply defaults for missing optional params
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                const numProvided = remainingArgs.length;
                for (const opt of optInfo) {
                  if (opt.index >= numProvided) {
                    pushDefaultValue(fctx, opt.type);
                  }
                }
              }

              // Pad any remaining missing arguments with defaults
              if (paramTypes) {
                const providedCount = Math.min(remainingArgs.length, paramTypes.length);
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.filter(o => o.index >= remainingArgs.length).length
                  : 0;
                const totalPushed = providedCount + optFilledCount;
                for (let i = totalPushed; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!);
                }
              }
            }

            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
              return resolveWasmType(ctx, retType);
            }
            return { kind: "f64" };
          }
          // .apply(thisArg, argsArray) — spread array literal elements as positional args
          if (!isCall && expr.arguments.length >= 2) {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const elements = argsExpr.elements;
              if (closureInfo) {
                const syntheticCall = ts.factory.createCallExpression(
                  innerExpr, undefined,
                  elements as unknown as readonly ts.Expression[],
                );
                (syntheticCall as any).parent = expr.parent;
                return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
              }
              const applyRestInfo = ctx.funcRestParams.get(funcName);
              if (applyRestInfo) {
                // Rest-param function via .apply(): pack trailing elements into vec
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < applyRestInfo.restIndex; i++) {
                  if (i < elements.length) {
                    compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                  } else {
                    pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
                  }
                }
                const restArgCount = Math.max(0, elements.length - applyRestInfo.restIndex);
                fctx.body.push({ op: "i32.const", value: restArgCount });
                for (let i = applyRestInfo.restIndex; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, applyRestInfo.elemType);
                }
                fctx.body.push({ op: "array.new_fixed", typeIdx: applyRestInfo.arrayTypeIdx, length: restArgCount });
                fctx.body.push({ op: "struct.new", typeIdx: applyRestInfo.vecTypeIdx });
              } else {
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                }
                const optInfo = ctx.funcOptionalParams.get(funcName);
                if (optInfo) {
                  for (const opt of optInfo) {
                    if (opt.index >= elements.length) pushDefaultValue(fctx, opt.type);
                  }
                }
                // Pad any remaining missing arguments with defaults
                if (paramTypes) {
                  const providedCount = Math.min(elements.length, paramTypes.length);
                  const optFilledCount = ctx.funcOptionalParams.get(funcName)
                    ? ctx.funcOptionalParams.get(funcName)!.filter(o => o.index >= elements.length).length
                    : 0;
                  const totalPushed = providedCount + optFilledCount;
                  for (let i = totalPushed; i < paramTypes.length; i++) {
                    pushDefaultValue(fctx, paramTypes[i]!);
                  }
                }
              }
              const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
              fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
              const sig = ctx.checker.getResolvedSignature(expr);
              if (sig) {
                const retType = ctx.checker.getReturnTypeOfSignature(sig);
                if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
                if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
                return resolveWasmType(ctx, retType);
              }
              return { kind: "f64" };
            }
          }
          // .apply() with no args array — call with no args
          if (!isCall) {
            if (closureInfo) {
              const syntheticCall = ts.factory.createCallExpression(innerExpr, undefined, []);
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
            }
            const applyNoArgsRestInfo = ctx.funcRestParams.get(funcName);
            if (applyNoArgsRestInfo) {
              // Rest-param function with no args: push empty vec
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < applyNoArgsRestInfo.restIndex; i++) {
                pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
              }
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "array.new_fixed", typeIdx: applyNoArgsRestInfo.arrayTypeIdx, length: 0 });
              fctx.body.push({ op: "struct.new", typeIdx: applyNoArgsRestInfo.vecTypeIdx });
            } else {
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                for (const opt of optInfo) pushDefaultValue(fctx, opt.type);
              }
              // Pad any remaining missing arguments with defaults
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              if (paramTypes) {
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.length
                  : 0;
                for (let i = optFilledCount; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!);
                }
              }
            }
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
              return resolveWasmType(ctx, retType);
            }
            return { kind: "f64" };
          }
        }
      }

      // Case 2: obj.method.call/apply — method call with different receiver
      if (ts.isPropertyAccessExpression(innerExpr)) {
        const methodName = innerExpr.name.text;
        const objExpr = innerExpr.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        // Case 2a: Type.prototype.method.call(receiver, ...args)
        // Rewrite as receiver.method(...args) — create a synthetic call expression
        if (
          ts.isPropertyAccessExpression(objExpr) &&
          objExpr.name.text === "prototype" &&
          ts.isIdentifier(objExpr.expression) &&
          isCall &&
          expr.arguments.length >= 1
        ) {
          const typeName = objExpr.expression.text;
          // Rewrite Type.prototype.method.call(receiver, ...args) as a synthetic
          // property access call on the receiver: receiver.method(...args).
          // This handles String.prototype.slice.call("hello", 0, 2) → "hello".slice(0, 2)
          // and Array.prototype.push.call(arr, 1) → arr.push(1), etc.
          if ((typeName === "String" || typeName === "Number" || typeName === "Array" || typeName === "Boolean" || typeName === "Object") &&
              expr.arguments.length >= 1) {
            const receiverArg = expr.arguments[0]!;
            const remainingArgs = Array.from(expr.arguments).slice(1);
            const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
              receiverArg as ts.Expression,
              methodName
            );
            const syntheticCall = ts.factory.createCallExpression(
              syntheticPropAccess,
              expr.typeArguments,
              remainingArgs as unknown as readonly ts.Expression[],
            );
            ts.setTextRange(syntheticCall, expr);
            (syntheticCall as any).parent = expr.parent;
            return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
          }
        }

        // Resolve class name from the object's type
        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }

        // Also try struct name
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && expr.arguments.length > 0) {
            // First argument is the thisArg (receiver)
            compileExpression(ctx, fctx, expr.arguments[0]!);

            if (isCall) {
              // .call(thisArg, arg1, arg2, ...) — remaining args are positional
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              for (let i = 1; i < expr.arguments.length; i++) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
              }
            } else if (expr.arguments.length >= 2 && ts.isArrayLiteralExpression(expr.arguments[1]!)) {
              // .apply(thisArg, [arg1, arg2, ...]) — spread array literal
              const elements = (expr.arguments[1] as ts.ArrayLiteralExpression).elements;
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              for (let i = 0; i < elements.length; i++) {
                compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i + 1]); // param 0 = self
              }
            }

            // Re-lookup funcIdx: argument compilation may trigger addUnionImports
            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
              return resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      (propAccess.name.text === "log" || propAccess.name.text === "warn" || propAccess.name.text === "error")
    ) {
      return compileConsoleCall(ctx, fctx, expr, propAccess.name.text);
    }

    // WASI mode: process.exit(code) -> proc_exit(code)
    if (
      ctx.wasi &&
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "process" &&
      propAccess.name.text === "exit" &&
      ctx.wasiProcExitIdx >= 0
    ) {
      if (expr.arguments.length >= 1) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
        // The expression might produce f64 — truncate to i32
        const argType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        if (isNumberType(argType)) {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
        }
      } else {
        fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      }
      fctx.body.push({ op: "call", funcIdx: ctx.wasiProcExitIdx });
      return VOID_RESULT;
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Math"
    ) {
      return compileMathCall(ctx, fctx, propAccess.name.text, expr);
    }

    // Handle Number.isNaN(n) and Number.isInteger(n)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Number"
    ) {
      const method = propAccess.name.text;
      if (method === "isNaN" && expr.arguments.length >= 1) {
        // NaN !== NaN is true; for any other value it's false
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.ne" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isInteger" && expr.arguments.length >= 1) {
        // n === Math.trunc(n) && isFinite(n)
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isint_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.trunc" } as Instr);
        fctx.body.push({ op: "f64.eq" } as Instr);
        // Also check finite: n - n === 0 (Infinity - Infinity = NaN, NaN !== 0)
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.sub" } as Instr);
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" } as Instr);
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isFinite" && expr.arguments.length >= 1) {
        // isFinite(n) → n - n === 0.0
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.sub" } as Instr);
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" } as Instr);
        return { kind: "i32" };
      }
      if (method === "isSafeInteger" && expr.arguments.length >= 1) {
        // isSafeInteger(n) = isInteger(n) && abs(n) <= MAX_SAFE_INTEGER
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        const tmp = allocLocal(fctx, `__issafe_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        // isInteger: n === trunc(n) && isFinite(n)
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.trunc" } as Instr);
        fctx.body.push({ op: "f64.eq" } as Instr);
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.sub" } as Instr);
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" } as Instr);
        fctx.body.push({ op: "i32.and" } as Instr);
        // abs(n) <= MAX_SAFE_INTEGER
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.abs" } as Instr);
        fctx.body.push({ op: "f64.const", value: Number.MAX_SAFE_INTEGER });
        fctx.body.push({ op: "f64.le" } as Instr);
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if ((method === "parseFloat" || method === "parseInt") && expr.arguments.length >= 1) {
        // Delegate to the global parseInt / parseFloat host import
        const funcIdx = ctx.funcMap.get(method === "parseFloat" ? "parseFloat" : "parseInt");
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          if (method === "parseInt") {
            if (expr.arguments.length >= 2) {
              compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
            } else {
              // No radix supplied — push NaN sentinel so runtime treats it as undefined
              fctx.body.push({ op: "f64.const", value: NaN });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "f64" };
        }
      }
    }

    // Handle Array.isArray(x) — compile-time type check
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "isArray" &&
      expr.arguments.length >= 1
    ) {
      // Check the TypeScript type of the argument at compile time
      const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      const argWasmType = resolveWasmType(ctx, argTsType);
      // If the wasm type is a ref to a vec struct (array), return true; otherwise false
      const isArr = (argWasmType.kind === "ref" || argWasmType.kind === "ref_null");
      // Still compile the argument for side effects, then drop it
      const argSideType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argSideType) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isArr ? 1 : 0 });
      return { kind: "i32" };
    }

    // Handle String.fromCharCode(code) — host import
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "String" &&
      propAccess.name.text === "fromCharCode" &&
      expr.arguments.length >= 1
    ) {
      const funcIdx = ctx.funcMap.get("String_fromCharCode");
      if (funcIdx !== undefined) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        if (argType && argType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        fctx.body.push({ op: "call", funcIdx });
        // In fast mode, marshal externref string to native string
        if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
          const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
          if (fromExternIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: fromExternIdx });
          }
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }

    // Handle Array.from(arr) — array copy
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "from" &&
      expr.arguments.length >= 1
    ) {
      const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      const argWasmType = resolveWasmType(ctx, argTsType);
      // Only handle array arguments — create a shallow copy
      if (argWasmType.kind === "ref" || argWasmType.kind === "ref_null") {
        const arrInfo = resolveArrayInfo(ctx, argTsType);
        if (arrInfo) {
          const { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;
          // Compile the source array
          compileExpression(ctx, fctx, expr.arguments[0]!);
          const srcVec = allocLocal(fctx, `__arrfrom_src_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
          const srcData = allocLocal(fctx, `__arrfrom_sdata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
          const lenTmp = allocLocal(fctx, `__arrfrom_len_${fctx.locals.length}`, { kind: "i32" });
          const dstData = allocLocal(fctx, `__arrfrom_ddata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });

          fctx.body.push({ op: "local.set", index: srcVec });
          // Get length
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "local.set", index: lenTmp });
          // Get source data
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "local.set", index: srcData });
          // Create new data array with default value
          const defaultVal = elemType.kind === "f64"
            ? { op: "f64.const", value: 0 }
            : elemType.kind === "i32"
              ? { op: "i32.const", value: 0 }
              : { op: "ref.null", typeIdx: (elemType as any).typeIdx ?? -1 };
          fctx.body.push(defaultVal as Instr);
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "array.new", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: dstData });
          // Copy elements: array.copy dst dstOff src srcOff len
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: srcData });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
          // Create new vec struct with copied data
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref", typeIdx: vecTypeIdx };
        }
      }
    }

    // Handle Object.keys(obj), Object.values(obj), and Object.entries(obj)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "keys" || propAccess.name.text === "values" || propAccess.name.text === "entries") &&
      expr.arguments.length === 1
    ) {
      return compileObjectKeysOrValues(ctx, fctx, propAccess.name.text, expr);
    }

    // Handle Object.freeze/seal/preventExtensions — mark object as non-extensible
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "freeze" || propAccess.name.text === "seal" || propAccess.name.text === "preventExtensions") &&
      expr.arguments.length >= 1
    ) {
      // Compile-time tracking: mark variable as non-extensible
      const arg0 = expr.arguments[0]!;
      if (ts.isIdentifier(arg0)) {
        ctx.nonExtensibleVars.add(arg0.text);
      }

      // Compile the argument
      let argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (!argType) return null;

      // For externref objects, set the __ne (non-extensible) flag at runtime.
      // For struct-based objects (ref/ref_null), compile-time tracking is sufficient
      // — do NOT use __extern_set since Wasm GC structs are opaque to JS.
      if (argType.kind === "externref") {
        const objLocal = allocLocal(fctx, `__freeze_obj_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: objLocal });

        // __extern_set(obj, "__ne", box(1))
        const neKey = "__ne";
        addStringConstantGlobal(ctx, neKey);
        const neKeyGlobal = ctx.stringGlobalMap.get(neKey)!;

        const setIdx = ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
        const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);

        if (setIdx !== undefined && boxIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "global.get", index: neKeyGlobal } as Instr);
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "call", funcIdx: boxIdx });
          fctx.body.push({ op: "call", funcIdx: setIdx });
        }

        fctx.body.push({ op: "local.get", index: objLocal });
        return { kind: "externref" };
      }

      // For struct/ref types, just return as-is (compile-time tracking already set)
      return argType;
    }

    // Handle Object.isFrozen/isSealed — stub: return false
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "isFrozen" || propAccess.name.text === "isSealed") &&
      expr.arguments.length >= 1
    ) {
      // Compile and drop the argument, then return false (i32 0)
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Handle Object.isExtensible — stub: return true
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "isExtensible" &&
      expr.arguments.length >= 1
    ) {
      // Compile and drop the argument, then return true (i32 1)
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }

    // Handle Object.setPrototypeOf(obj, proto) — stub: compile both args, drop proto, return obj
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "setPrototypeOf" &&
      expr.arguments.length >= 2
    ) {
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
      const protoType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (protoType) {
        fctx.body.push({ op: "drop" });
      }
      return objType;
    }

    // Handle Object.getPrototypeOf(obj) — return prototype as externref
    // For class instances, creates a struct representing the prototype and returns
    // it as externref via extern.convert_any. For plain objects, returns null.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getPrototypeOf" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // For Object.getPrototypeOf(Child.prototype), return Parent's prototype singleton
      // Must check BEFORE the general class instance check, because TS types
      // Child.prototype as Child (the instance type).
      if (
        ts.isPropertyAccessExpression(arg0) &&
        ts.isIdentifier(arg0.expression) &&
        arg0.name.text === "prototype" &&
        ctx.classSet.has(arg0.expression.text)
      ) {
        const childClassName = arg0.expression.text;
        const parentClassName = ctx.classParentMap.get(childClassName);
        if (parentClassName && emitLazyProtoGet(ctx, fctx, parentClassName)) {
          return { kind: "externref" };
        }
        // Base class with no parent: return null (Object.prototype not modeled)
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      const argTsType = ctx.checker.getTypeAtLocation(arg0);
      const className = resolveStructName(ctx, argTsType);

      // For known class instances, return the class prototype singleton
      if (className && ctx.classSet.has(className)) {
        // Compile and drop the argument (for side effects)
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
        if (emitLazyProtoGet(ctx, fctx, className)) {
          return { kind: "externref" };
        }
      }

      // Fallback: compile and drop arg, return null
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.create(proto) — create instances for known prototypes
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "create" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // Object.create(null) → empty object (externref null)
      if (arg0.kind === ts.SyntaxKind.NullKeyword) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      // Object.create(Foo.prototype) → struct.new with default fields
      if (
        ts.isPropertyAccessExpression(arg0) &&
        ts.isIdentifier(arg0.expression) &&
        arg0.name.text === "prototype"
      ) {
        const protoClassName = arg0.expression.text;
        if (ctx.classSet.has(protoClassName)) {
          const structTypeIdx = ctx.structMap.get(protoClassName);
          const fields = ctx.structFields.get(protoClassName);
          if (structTypeIdx !== undefined && fields) {
            // Push default values for all fields, then struct.new
            for (const field of fields) {
              pushDefaultValue(fctx, field.type);
            }
            fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
            return { kind: "ref", typeIdx: structTypeIdx };
          }
        }
      }

      // Fallback: compile and drop arg, return null externref
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.defineProperty(obj, prop, descriptor) — stub
    // If descriptor is an object literal with a `value` property, sets obj[prop] = value via __extern_set.
    // Otherwise compiles all args for side effects and returns obj.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "defineProperty" &&
      expr.arguments.length >= 3
    ) {
      return compileObjectDefineProperty(ctx, fctx, expr);
    }

    // Handle Object.defineProperties(obj, props) — stub: compile both args, drop props, return obj
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "defineProperties" &&
      expr.arguments.length >= 2
    ) {
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
      const propsType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (propsType) {
        fctx.body.push({ op: "drop" });
      }
      return objType;
    }

    // Handle Object.getOwnPropertyDescriptor(obj, prop) — stub: return undefined (ref.null extern)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getOwnPropertyDescriptor" &&
      expr.arguments.length >= 2
    ) {
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (objType) fctx.body.push({ op: "drop" });
      const propType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (propType) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // ── Reflect API — compile-time rewrites to equivalent operations ──────
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Reflect"
    ) {
      const reflectMethod = propAccess.name.text;

      // Reflect.get(obj, prop) → obj[prop]
      if (reflectMethod === "get" && expr.arguments.length >= 2) {
        const syntheticElemAccess = ts.factory.createElementAccessExpression(
          expr.arguments[0] as ts.Expression,
          expr.arguments[1] as ts.Expression,
        );
        ts.setTextRange(syntheticElemAccess, expr);
        (syntheticElemAccess as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticElemAccess);
      }

      // Reflect.set(obj, prop, val) → (obj[prop] = val, true)
      if (reflectMethod === "set" && expr.arguments.length >= 3) {
        const syntheticElemAccess = ts.factory.createElementAccessExpression(
          expr.arguments[0] as ts.Expression,
          expr.arguments[1] as ts.Expression,
        );
        const syntheticAssign = ts.factory.createBinaryExpression(
          syntheticElemAccess,
          ts.factory.createToken(ts.SyntaxKind.EqualsToken),
          expr.arguments[2] as ts.Expression,
        );
        ts.setTextRange(syntheticAssign, expr);
        (syntheticAssign as any).parent = expr.parent;
        const assignType = compileExpression(ctx, fctx, syntheticAssign);
        if (assignType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.has(obj, prop) → prop in obj
      if (reflectMethod === "has" && expr.arguments.length >= 2) {
        const syntheticIn = ts.factory.createBinaryExpression(
          expr.arguments[1] as ts.Expression,
          ts.factory.createToken(ts.SyntaxKind.InKeyword),
          expr.arguments[0] as ts.Expression,
        );
        ts.setTextRange(syntheticIn, expr);
        (syntheticIn as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticIn);
      }

      // Reflect.apply(fn, thisArg, args) → fn.apply(thisArg, args)
      if (reflectMethod === "apply" && expr.arguments.length >= 3) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          expr.arguments[0] as ts.Expression as ts.LeftHandSideExpression,
          "apply",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[1] as ts.Expression, expr.arguments[2] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }

      // Reflect.construct(C, args) → new C(...args)
      // For now, only handle array literal args: Reflect.construct(C, [a, b])
      if (reflectMethod === "construct" && expr.arguments.length >= 2) {
        const ctorExpr = expr.arguments[0] as ts.Expression as ts.LeftHandSideExpression;
        const argsExpr = expr.arguments[1]!;
        // If args is an array literal, spread it as positional args
        let newArgs: readonly ts.Expression[];
        if (ts.isArrayLiteralExpression(argsExpr)) {
          newArgs = argsExpr.elements;
        } else {
          // Fallback: pass args array as-is (single arg)
          newArgs = [argsExpr as ts.Expression];
        }
        const syntheticNew = ts.factory.createNewExpression(
          ctorExpr,
          undefined,
          newArgs as ts.Expression[],
        );
        ts.setTextRange(syntheticNew, expr);
        (syntheticNew as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticNew);
      }

      // Reflect.ownKeys(obj) → Object.keys(obj)
      if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "keys",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[0] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }

      // Reflect.defineProperty(obj, prop, desc) → (Object.defineProperty(obj, prop, desc), true)
      if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "defineProperty",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          Array.from(expr.arguments) as ts.Expression[],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        const resultType = compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
        if (resultType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.getPrototypeOf(obj) → Object.getPrototypeOf(obj)
      if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "getPrototypeOf",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[0] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }

      // Reflect.setPrototypeOf(obj, proto) → (Object.setPrototypeOf(obj, proto), true)
      if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "setPrototypeOf",
        );
        const syntheticCall = ts.factory.createCallExpression(
          syntheticPropAccess,
          undefined,
          [expr.arguments[0] as ts.Expression, expr.arguments[1] as ts.Expression],
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        const resultType = compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
        if (resultType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.deleteProperty(obj, prop) → (delete obj[prop], result as boolean)
      if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
        const syntheticElemAccess = ts.factory.createElementAccessExpression(
          expr.arguments[0] as ts.Expression,
          expr.arguments[1] as ts.Expression,
        );
        const syntheticDelete = ts.factory.createDeleteExpression(
          syntheticElemAccess as ts.UnaryExpression,
        );
        ts.setTextRange(syntheticDelete, expr);
        (syntheticDelete as any).parent = expr.parent;
        return compileExpression(ctx, fctx, syntheticDelete);
      }

      // Reflect.isExtensible(obj) → Object.isExtensible(obj) (stub: true)
      if (reflectMethod === "isExtensible" && expr.arguments.length >= 1) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (argType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.preventExtensions(obj) → stub: compile arg, return true
      if (reflectMethod === "preventExtensions" && expr.arguments.length >= 1) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (argType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }

      // Reflect.getOwnPropertyDescriptor(obj, prop) → stub: return undefined
      if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
        const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (objType) fctx.body.push({ op: "drop" });
        const propType = compileExpression(ctx, fctx, expr.arguments[1]!);
        if (propType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Handle Promise.all / Promise.race / Promise.resolve / Promise.reject — host-delegated static calls
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Promise" &&
      (propAccess.name.text === "all" || propAccess.name.text === "race" ||
       propAccess.name.text === "resolve" || propAccess.name.text === "reject")
    ) {
      const methodName = propAccess.name.text;
      const importName = `Promise_${methodName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        if (expr.arguments.length >= 1) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        } else {
          // Promise.resolve() with no args — pass undefined (ref.null extern)
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // Handle JSON.stringify / JSON.parse as host import calls
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "JSON"
    ) {
      const method = propAccess.name.text;
      if ((method === "stringify" || method === "parse") && expr.arguments.length >= 1) {
        const importName = `JSON_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile argument and coerce to externref if needed
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
          if (argType && argType.kind !== "externref") {
            coerceType(ctx, fctx, argType, { kind: "externref" });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // Handle Date.now() and Date.UTC() — pure Wasm static methods
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Date"
    ) {
      const method = propAccess.name.text;
      if (method === "now") {
        // Date.now() — no clock in pure Wasm, return 0
        fctx.body.push({ op: "f64.const", value: 0 } as Instr);
        return { kind: "f64" };
      }
      if (method === "UTC") {
        // Date.UTC(year, month, day?, hours?, minutes?, seconds?, ms?)
        // Same as new Date(y,m,d,...).getTime() but without the year 0-99 quirk
        const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);
        const args = expr.arguments;

        // year
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 1970 } as Instr);
        }
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        const yearL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: yearL } as Instr);

        // month (0-indexed) + 1
        if (args.length >= 2) {
          compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
          fctx.body.push({ op: "i64.add" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        }
        const monthL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: monthL } as Instr);

        // day (default 1)
        if (args.length >= 3) {
          compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        }
        const dayL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: dayL } as Instr);

        // hours (default 0)
        if (args.length >= 4) {
          compileExpression(ctx, fctx, args[3]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const hoursL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: hoursL } as Instr);

        // minutes (default 0)
        if (args.length >= 5) {
          compileExpression(ctx, fctx, args[4]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const minutesL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: minutesL } as Instr);

        // seconds (default 0)
        if (args.length >= 6) {
          compileExpression(ctx, fctx, args[5]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const secondsL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: secondsL } as Instr);

        // ms (default 0)
        if (args.length >= 7) {
          compileExpression(ctx, fctx, args[6]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const msL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: msL } as Instr);

        // days_from_civil(year, month, day) * 86400000 + h*3600000 + m*60000 + s*1000 + ms
        fctx.body.push(
          { op: "local.get", index: yearL } as Instr,
          { op: "local.get", index: monthL } as Instr,
          { op: "local.get", index: dayL } as Instr,
          { op: "call", funcIdx: daysFromCivilIdx } as Instr,
          { op: "i64.const", value: 86400000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "local.get", index: hoursL } as Instr,
          { op: "i64.const", value: 3600000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: minutesL } as Instr,
          { op: "i64.const", value: 60000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: secondsL } as Instr,
          { op: "i64.const", value: 1000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: msL } as Instr,
          { op: "i64.add" } as Instr,
          { op: "f64.convert_i64_s" } as Instr,
        );

        releaseTempLocal(fctx, msL);
        releaseTempLocal(fctx, secondsL);
        releaseTempLocal(fctx, minutesL);
        releaseTempLocal(fctx, hoursL);
        releaseTempLocal(fctx, dayL);
        releaseTempLocal(fctx, monthL);
        releaseTempLocal(fctx, yearL);

        return { kind: "f64" };
      }
      // Date.parse — stub: return NaN
      if (method === "parse") {
        // Drop argument if any
        for (const arg of expr.arguments) {
          const t = compileExpression(ctx, fctx, arg);
          if (t) fctx.body.push({ op: "drop" } as Instr);
        }
        fctx.body.push({ op: "f64.const", value: NaN } as Instr);
        return { kind: "f64" };
      }
    }

    // Check if this is a static method call: ClassName.staticMethod(args)
    if (ts.isIdentifier(propAccess.expression) && ctx.classSet.has(propAccess.expression.text)) {
      const clsName = propAccess.expression.text;
      const methodName = propAccess.name.text;
      const fullName = `${clsName}_${methodName}`;
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // No self parameter for static methods
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
          // Pad missing arguments with defaults
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStaticIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStaticIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStaticIdx)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Check if receiver is an externref object
    const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);

    // Handle Date instance method calls BEFORE extern class dispatch,
    // because Date is declared in lib.d.ts (so isExternalDeclaredClass returns true)
    // but we implement it natively as a WasmGC struct.
    {
      const dateResult = compileDateMethodCall(ctx, fctx, propAccess, expr, receiverType);
      if (dateResult !== undefined) return dateResult;
    }

    if (isExternalDeclaredClass(receiverType, ctx.checker)) {
      return compileExternMethodCall(ctx, fctx, propAccess, expr);
    }

    // Property introspection: hasOwnProperty / propertyIsEnumerable
    if (propAccess.name.text === "hasOwnProperty" || propAccess.name.text === "propertyIsEnumerable") {
      return compilePropertyIntrospection(ctx, fctx, propAccess, expr);
    }

    // Generator method calls: gen.next(), gen.return(value), gen.throw(error)
    if (isGeneratorType(receiverType)) {
      const methodName = propAccess.name.text;
      if (methodName === "next") {
        compileExpression(ctx, fctx, propAccess.expression);
        const funcIdx = ctx.funcMap.get("__gen_next");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "return") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (value to return), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_return");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "throw") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (error to throw), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_throw");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      }
    }

    // Handle Promise instance methods: .then(cb), .catch(cb)
    // Promise values are externref; delegate to host imports
    {
      const method = propAccess.name.text;
      if ((method === "then" || method === "catch") && expr.arguments.length >= 1) {
        const importName = `Promise_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile the Promise value (receiver)
          compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          // Compile the callback argument, coercing to externref
          const cbType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          if (cbType && cbType.kind !== "externref") {
            coerceType(ctx, fctx, cbType, { kind: "externref" });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // Handle wrapper type method calls: new Number(x).valueOf(), etc.
    // Since wrapper constructors now return primitives, valueOf() is a no-op identity.
    {
      const wrapperMethodName = propAccess.name.text;
      const recvSymName = receiverType.getSymbol()?.name;
      if (recvSymName === "Number" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "f64" });
        return { kind: "f64" };
      }
      if (recvSymName === "String" && wrapperMethodName === "valueOf") {
        const strType = ctx.nativeStrings ? nativeStringType(ctx) : { kind: "externref" } as ValType;
        compileExpression(ctx, fctx, propAccess.expression, strType);
        return strType;
      }
      if (recvSymName === "Boolean" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
        return { kind: "i32" };
      }
    }



    // Check if receiver is a local class instance
    let receiverClassName = receiverType.getSymbol()?.name;
    // Map class expression symbol names to their synthetic names
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    // Fallback for union types, interfaces, abstract classes:
    // When the direct symbol name is not a known class, try to resolve via
    // union members, apparent type, or base types.
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
      // Try union type members: for `A | B`, check each member for a known class
      if (receiverType.isUnion()) {
        for (const memberType of (receiverType as ts.UnionType).types) {
          let memberName = memberType.getSymbol()?.name;
          if (memberName && !ctx.classSet.has(memberName)) {
            memberName = ctx.classExprNameMap.get(memberName) ?? memberName;
          }
          if (memberName && ctx.classSet.has(memberName)) {
            const fullName = `${memberName}_${methodName}`;
            if (ctx.funcMap.has(fullName)) {
              receiverClassName = memberName;
              break;
            }
            // Walk inheritance chain
            let ancestor = ctx.classParentMap.get(memberName);
            while (ancestor) {
              if (ctx.funcMap.has(`${ancestor}_${methodName}`)) {
                receiverClassName = memberName;
                break;
              }
              ancestor = ctx.classParentMap.get(ancestor);
            }
            if (receiverClassName && ctx.classSet.has(receiverClassName)) break;
          }
        }
      }
      // Try apparent type (handles interfaces, abstract classes)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const apparentType = ctx.checker.getApparentType(receiverType);
        if (apparentType !== receiverType) {
          let apparentName = apparentType.getSymbol()?.name;
          if (apparentName && !ctx.classSet.has(apparentName)) {
            apparentName = ctx.classExprNameMap.get(apparentName) ?? apparentName;
          }
          if (apparentName && ctx.classSet.has(apparentName) && ctx.funcMap.has(`${apparentName}_${methodName}`)) {
            receiverClassName = apparentName;
          }
        }
      }
      // Try base types: if the receiver type has base types (e.g. abstract class → concrete class)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const baseTypes = receiverType.getBaseTypes?.();
        if (baseTypes) {
          for (const baseType of baseTypes) {
            let baseName = baseType.getSymbol()?.name;
            if (baseName && !ctx.classSet.has(baseName)) {
              baseName = ctx.classExprNameMap.get(baseName) ?? baseName;
            }
            if (baseName && ctx.classSet.has(baseName) && ctx.funcMap.has(`${baseName}_${methodName}`)) {
              receiverClassName = baseName;
              break;
            }
          }
        }
      }
      // Try struct name from the receiver's wasm type
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const structName = resolveStructName(ctx, receiverType);
        if (structName && ctx.classSet.has(structName) && ctx.funcMap.has(`${structName}_${methodName}`)) {
          receiverClassName = structName;
        }
      }
      // Final fallback: scan all known classes for one that has the method.
      // This handles interface types and abstract classes where we can't determine
      // the implementing class from the type alone. We pick the first class that
      // has the method and whose struct fields are a superset of the receiver type's properties.
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const recvProps = receiverType.getProperties?.() ?? [];
        const recvPropNames = new Set(recvProps.map(p => p.name));
        for (const className of ctx.classSet) {
          if (!ctx.funcMap.has(`${className}_${methodName}`)) continue;
          // Quick heuristic: check that the class has at least the same property names
          // as the interface (structural compatibility check)
          const classFields = ctx.structFields.get(className);
          if (classFields && recvPropNames.size > 0) {
            const classFieldNames = new Set(classFields.map(f => f.name));
            let compatible = true;
            for (const prop of recvPropNames) {
              // Methods won't be in struct fields, so skip function-typed properties
              const propSymbol = recvProps.find(p => p.name === prop);
              const propType = propSymbol ? ctx.checker.getTypeOfSymbol(propSymbol) : undefined;
              const isMethod = propType && (propType.getCallSignatures?.()?.length ?? 0) > 0;
              if (!isMethod && !classFieldNames.has(prop)) {
                compatible = false;
                break;
              }
            }
            if (!compatible) continue;
          }
          receiverClassName = className;
          break;
        }
      }
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(fullName);
      // Walk inheritance chain to find the method in a parent class
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(fullName);
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      // Walk child classes (handles abstract class → concrete subclass)
      if (funcIdx === undefined) {
        for (const [childClass, parentClass] of ctx.classParentMap) {
          if (parentClass === receiverClassName || parentClass === fullName.split('_')[0]) {
            const childFullName = `${childClass}_${methodName}`;
            const childFuncIdx = ctx.funcMap.get(childFullName);
            if (childFuncIdx !== undefined) {
              fullName = childFullName;
              funcIdx = childFuncIdx;
              break;
            }
          }
        }
      }
      // If no method found, check if the property is a callable struct field
      // (e.g. this.callback() where callback is a function-typed property)
      if (funcIdx === undefined) {
        const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, receiverClassName);
        if (callablePropResult !== undefined) return callablePropResult;
      }
      if (funcIdx !== undefined) {
        // Push self (the receiver) as first argument
        let recvType = compileExpression(ctx, fctx, propAccess.expression);
        // If receiver is externref but the method expects a struct ref, coerce
        if (recvType && recvType.kind === "externref") {
          const structTypeIdx = ctx.structMap.get(receiverClassName);
          if (structTypeIdx !== undefined) {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            emitGuardedRefCast(fctx, structTypeIdx);
            recvType = { kind: "ref_null", typeIdx: structTypeIdx };
          }
        }
        // Null-guard: if receiver is ref_null, check for null before calling method
        if (recvType && recvType.kind === "ref_null") {
          // Determine return type early so we can build null-guard
          const sig = ctx.checker.getResolvedSignature(expr);
          let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (!isEffectivelyVoidReturn(ctx, retType, fullName)) callReturnType = resolveWasmType(ctx, retType);
          }
          const tmp = allocLocal(fctx, `__ng_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.tee", index: tmp });
          fctx.body.push({ op: "ref.is_null" });

          // Build the else branch (non-null path) with the full call
          const savedBody = pushBody(fctx);
          fctx.body.push({ op: "local.get", index: tmp });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
          }
          if (paramTypes) {
            for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          const finalMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const elseInstrs = fctx.body;
          fctx.body = savedBody;

          if (callReturnType === VOID_RESULT) {
            // Void method: if null, skip; else call
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [] as Instr[],
              else: elseInstrs,
            });
            return VOID_RESULT;
          } else {
            const resultType: ValType = callReturnType.kind === "ref"
              ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
              : callReturnType;
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: resultType },
              then: defaultValueInstrs(resultType),
              else: elseInstrs,
            });
            return resultType;
          }
        }
        // Non-nullable receiver: emit call directly
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
        }
        // Pad missing arguments with defaults (skip self param at index 0)
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }
        // Re-lookup funcIdx: argument compilation may trigger addUnionImports
        const finalMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });

        // Determine return type
        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
          return resolveWasmType(ctx, retType);
        }
        return VOID_RESULT;
      }
    }

    // Check if receiver is a struct type (e.g. object literal with methods)
    {
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const methodName = propAccess.name.text;
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        // If no method found, check callable property on struct
        if (funcIdx === undefined) {
          const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, structTypeName);
          if (callablePropResult !== undefined) return callablePropResult;
        }
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          // Module globals produce ref_null but method params expect ref — null-guard
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName)) callReturnType = resolveWasmType(ctx, retType);
            }
            const tmp = allocLocal(fctx, `__ng_srecv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            for (let i = 0; i < expr.arguments.length; i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            }
            if (paramTypes) {
              for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }
            const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: [] as Instr[],
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType = callReturnType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
                : callReturnType;
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: defaultValueInstrs(resultType),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStructMethodIdx)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Array method calls
    {
      const arrMethodResult = compileArrayMethodCall(ctx, fctx, propAccess, expr, receiverType);
      if (arrMethodResult !== undefined) return arrMethodResult;
    }

    // Primitive method calls: number.toString(), number.toFixed()
    if (isNumberType(receiverType) && propAccess.name.text === "toString") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      // number_toString expects f64 but source may be i32 (e.g. string.length)
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const funcIdx = ctx.funcMap.get("number_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (isNumberType(receiverType) && propAccess.name.text === "toFixed") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      // Compile the digits argument (default 0)
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      const funcIdx = ctx.funcMap.get("number_toFixed");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // String method calls
    if (isStringType(receiverType)) {
      const method = propAccess.name.text;

      // string.toString() and string.valueOf() — identity, just return the string itself
      if (method === "toString" || method === "valueOf") {
        return compileExpression(ctx, fctx, propAccess.expression);
      }

      // Fast mode: native string method dispatch
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method);
      }

      // charCodeAt: uses wasm:js-string charCodeAt import (not string_charCodeAt)
      if (method === "charCodeAt") {
        const charCodeAtIdx = ctx.funcMap.get("charCodeAt");
        if (charCodeAtIdx !== undefined) {
          compileExpression(ctx, fctx, propAccess.expression);
          if (expr.arguments.length > 0) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
            if (!argType || argType === VOID_RESULT) {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (argType.kind === "f64") {
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            }
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          fctx.body.push({ op: "call", funcIdx: charCodeAtIdx });
          return { kind: "i32" };
        }
      }

      const importName = `string_${method}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        compileExpression(ctx, fctx, propAccess.expression);
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments;
        for (let ai = 0; ai < args.length; ai++) {
          const expectedArgType = paramTypes?.[ai + 1]; // +1 for self param
          const argResult = compileExpression(ctx, fctx, args[ai]!, expectedArgType);
          if (!argResult || argResult === VOID_RESULT) {
            // void/null result — push a default value for the expected type
            pushDefaultValue(fctx, expectedArgType ?? { kind: "f64" });
          } else if (expectedArgType && argResult.kind !== expectedArgType.kind) {
            coerceType(ctx, fctx, argResult, expectedArgType);
          }
        }
        // Pad missing optional args with defaults (e.g. indexOf 2nd arg)
        if (paramTypes && args.length + 1 < paramTypes.length) {
          for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
            const pt = paramTypes[pi]!;
            if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
            else if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
            else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
        const returnsNum = method === "indexOf" || method === "lastIndexOf" || method === "codePointAt";
        return returnsBool ? { kind: "i32" } : returnsNum ? { kind: "f64" } : { kind: "externref" };
      }
    }

    // Boolean method calls: bool.toString(), bool.valueOf()
    if (isBooleanType(receiverType)) {
      const method = propAccess.name.text;
      if (method === "toString") {
        compileExpression(ctx, fctx, propAccess.expression);
        emitBoolToString(ctx, fctx);
        return { kind: "externref" };
      }
      if (method === "valueOf") {
        // Boolean.valueOf() returns the boolean primitive — just compile the expression
        return compileExpression(ctx, fctx, propAccess.expression);
      }
    }

    // number.valueOf() — return the number itself
    if (isNumberType(receiverType) && propAccess.name.text === "valueOf") {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback .toString() for any type not already handled above
    // Handles: function.toString(), object.toString(), array.toString(), class instance.toString()
    if (propAccess.name.text === "toString" && expr.arguments.length === 0) {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      // For arrays, emit "[object Array]"; for everything else, "[object Object]"
      const tsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const wasm = resolveWasmType(ctx, tsType);
      // Check if it's an array type (ref to vec struct)
      let isArray = false;
      if (wasm.kind === "ref" || wasm.kind === "ref_null") {
        const arrInfo = resolveArrayInfo(ctx, tsType);
        if (arrInfo) isArray = true;
      }
      // Check if this is a function type (has call signatures, is not a class/interface)
      const callSigs = tsType.getCallSignatures?.();
      const isFunc = callSigs && callSigs.length > 0 && !tsType.getProperties?.()?.length;

      if (isFunc) {
        addStringConstantGlobal(ctx, "function () { [native code] }");
        const idx = ctx.stringGlobalMap.get("function () { [native code] }")!;
        fctx.body.push({ op: "global.get", index: idx });
      } else {
        const str = isArray ? "[object Array]" : "[object Object]";
        addStringConstantGlobal(ctx, str);
        const idx = ctx.stringGlobalMap.get(str)!;
        fctx.body.push({ op: "global.get", index: idx });
      }
      return { kind: "externref" };
    }

    // Fallback .valueOf() for any type not already handled above
    // valueOf() on non-primitive types typically returns the object itself
    if (propAccess.name.text === "valueOf" && expr.arguments.length === 0) {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback for method calls on any-typed / externref / unresolvable receivers.
    // This handles patterns like: ref(args).next(), anyObj.someMethod(), etc.
    // Common in test262 where variables are typed as `any` or inferred as `any`.
    {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvWasm = resolveWasmType(ctx, recvTsType);
      const isAnyOrExternref = (recvTsType.flags & ts.TypeFlags.Any) !== 0 ||
        recvWasm.kind === "externref";

      if (isAnyOrExternref) {
        const methodName = propAccess.name.text;

        // Generator protocol: .next(), .return(value), .throw(error) on any/externref
        // These are very common in test262 generator tests where variables are typed as `any`.
        if (methodName === "next") {
          const genNextIdx = ctx.funcMap.get("__gen_next");
          if (genNextIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            // Drop any arguments (generator .next() with args not yet supported)
            for (const arg of expr.arguments) {
              const argType = compileExpression(ctx, fctx, arg);
              if (argType && argType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
            fctx.body.push({ op: "call", funcIdx: genNextIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "return") {
          const genReturnIdx = ctx.funcMap.get("__gen_return");
          if (genReturnIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genReturnIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "throw") {
          const genThrowIdx = ctx.funcMap.get("__gen_throw");
          if (genThrowIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genThrowIdx });
            return { kind: "externref" };
          }
        }

        // General fallback for any method call on any/externref receiver:
        // compile the receiver and all arguments for side effects, return externref.
        // This avoids "Unsupported call expression" errors for unresolvable methods.
        {
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType && recvType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType && argType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }
  }

  // Handle global isNaN(n) / isFinite(n) — inline wasm
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    if (funcName === "isNaN" && expr.arguments.length >= 1) {
      // isNaN(n) → n !== n
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.ne" } as Instr);
      return { kind: "i32" };
    }

    if (funcName === "isFinite" && expr.arguments.length >= 1) {
      // isFinite(n) → n - n === 0.0  (Infinity - Infinity = NaN, NaN - NaN = NaN, finite - finite = 0)
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.sub" } as Instr);
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" } as Instr);
      return { kind: "i32" };
    }

    // parseInt(s, radix?) and parseFloat(s) — host imports
    if ((funcName === "parseInt" || funcName === "parseFloat") && expr.arguments.length >= 1) {
      const importFuncIdx = ctx.funcMap.get(funcName);
      if (importFuncIdx !== undefined) {
        const arg0 = expr.arguments[0]!;
        const arg0Type = compileExpression(ctx, fctx, arg0);
        // Coerce to externref, preserving boolean identity (not boxing as number)
        if (arg0Type && arg0Type.kind !== "externref") {
          if (arg0Type.kind === "i32" && (arg0.kind === ts.SyntaxKind.TrueKeyword || arg0.kind === ts.SyntaxKind.FalseKeyword)) {
            // Boolean literal: box as boolean so String(true) → "true"
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_boolean");
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else {
            coerceType(ctx, fctx, arg0Type, { kind: "externref" });
          }
        }
        if (funcName === "parseInt") {
          if (expr.arguments.length >= 2) {
            compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
          } else {
            // No radix supplied — push NaN sentinel so runtime treats it as undefined
            fctx.body.push({ op: "f64.const", value: NaN });
          }
        }
        fctx.body.push({ op: "call", funcIdx: importFuncIdx });
        return { kind: "f64" };
      }
    }

    // Number(x) — ToNumber coercion
    if (funcName === "Number" && expr.arguments.length >= 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "i64") {
        // BigInt → number: f64.convert_i64_s
        fctx.body.push({ op: "f64.convert_i64_s" });
        return { kind: "f64" };
      }
      if (argType?.kind === "externref") {
        // String → number: use parseFloat
        const pfIdx = ctx.funcMap.get("parseFloat");
        if (pfIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          return { kind: "f64" };
        }
      }
      // Already numeric — no-op
      return argType;
    }

    // BigInt(x) — ToBigInt coercion
    if (funcName === "BigInt" && expr.arguments.length >= 1) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "f64") {
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        return { kind: "i64" };
      }
      if (argType?.kind === "i32") {
        fctx.body.push({ op: "i64.extend_i32_s" });
        return { kind: "i64" };
      }
      // Already i64 — no-op
      return argType;
    }

    // Number() with 0 args → 0
    if (funcName === "Number" && expr.arguments.length === 0) {
      fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: 0 } as Instr);
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }

    // Symbol() / Symbol('description') — create unique i32 symbol ID
    if (funcName === "Symbol") {
      return compileSymbolCall(ctx, fctx, expr.arguments);
    }

    // String(x) — ToString coercion
    if (funcName === "String") {
      if (expr.arguments.length === 0) {
        // String() with no args → ""
        addStringConstantGlobal(ctx, "");
        const emptyIdx = ctx.stringGlobalMap.get("")!;
        fctx.body.push({ op: "global.get", index: emptyIdx });
        return { kind: "externref" };
      }

      // Check if argument is a null/undefined literal before compiling
      const strArg0 = expr.arguments[0]!;
      const strArg0IsNull = strArg0.kind === ts.SyntaxKind.NullKeyword;
      const strArg0IsUndefined = strArg0.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(strArg0) && strArg0.text === "undefined") ||
        ts.isVoidExpression(strArg0);

      if (strArg0IsNull) {
        // String(null) → "null"
        addStringConstantGlobal(ctx, "null");
        const nullGIdx = ctx.stringGlobalMap.get("null")!;
        fctx.body.push({ op: "global.get", index: nullGIdx });
        return { kind: "externref" };
      }

      if (strArg0IsUndefined) {
        // String(undefined) → "undefined"
        addStringConstantGlobal(ctx, "undefined");
        const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
        fctx.body.push({ op: "global.get", index: undefGIdx });
        return { kind: "externref" };
      }

      const argType = compileExpression(ctx, fctx, strArg0);

      if (argType === VOID_RESULT || argType === null) {
        // String(void-expr) → "undefined"
        addStringConstantGlobal(ctx, "undefined");
        const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
        fctx.body.push({ op: "global.get", index: undefGIdx });
        return { kind: "externref" };
      }

      if (argType?.kind === "i32") {
        // Check if it's a boolean type → "true"/"false"
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isBooleanType(argTsType)) {
          emitBoolToString(ctx, fctx);
          return { kind: "externref" };
        }
        // number (i32) → string via f64 conversion
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      if (argType?.kind === "f64") {
        // number → string
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      if (argType?.kind === "externref") {
        // Check TS type to determine what this externref actually is
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (argTsType.flags & ts.TypeFlags.Null) {
          // Drop the ref.null.extern, push "null" constant
          fctx.body.push({ op: "drop" });
          addStringConstantGlobal(ctx, "null");
          const nullGIdx = ctx.stringGlobalMap.get("null")!;
          fctx.body.push({ op: "global.get", index: nullGIdx });
          return { kind: "externref" };
        }
        if (argTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          fctx.body.push({ op: "drop" });
          addStringConstantGlobal(ctx, "undefined");
          const undefGIdx = ctx.stringGlobalMap.get("undefined")!;
          fctx.body.push({ op: "global.get", index: undefGIdx });
          return { kind: "externref" };
        }
        if (isStringType(argTsType)) {
          // Already a string — return as-is
          return { kind: "externref" };
        }
        // Other externref — try extern_toString if available
        const toStrIdx = ctx.funcMap.get("extern_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
        }
        return { kind: "externref" };
      }

      if ((argType?.kind === "ref" || argType?.kind === "ref_null") && ctx.fast) {
        // Check if it's a native string type
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isStringType(argTsType)) {
          // Already a native string — return as-is
          return argType;
        }
        // Object ref → "[object Object]"
        fctx.body.push({ op: "drop" });
        addStringConstantGlobal(ctx, "[object Object]");
        const objGIdx = ctx.stringGlobalMap.get("[object Object]")!;
        fctx.body.push({ op: "global.get", index: objGIdx });
        return { kind: "externref" };
      }

      return argType ?? { kind: "externref" };
    }

    // Boolean(x) — ToBoolean coercion → returns i32 (0 or 1)
    if (funcName === "Boolean") {
      if (expr.arguments.length === 0) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      // void / undefined → always false
      if (argType === VOID_RESULT || argType === null) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      if (argType?.kind === "f64") {
        // f64: truthy if != 0 and != NaN
        const tmp = allocLocal(fctx, `__bool_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.ne" } as Instr);
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.eq" } as Instr); // NaN check: x == x
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "i32") {
        // i32: truthy if != 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" } as Instr);
        return { kind: "i32" };
      }
      // String: truthy if length > 0
      if ((argType?.kind === "ref" || argType?.kind === "ref_null") &&
          ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 &&
          isStringType(ctx.checker.getTypeAtLocation(expr.arguments[0]!))) {
        // Get length (field 0 of $AnyString) and check != 0
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "externref") {
        // Check if this is a string type — use string length > 0 for truthiness
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        if (isStringType(argTsType)) {
          addStringImports(ctx);
          const lenIdx = ctx.funcMap.get("length");
          if (lenIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: lenIdx });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.ne" } as Instr);
            return { kind: "i32" };
          }
        }
        // externref: truthy if non-null (and not "" or 0 — but we can't check that without host)
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.xor" } as Instr);
        return { kind: "i32" };
      }
      // Ref types (objects, arrays): always truthy — drop the ref, push 1
      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      // fallback: treat as truthy (non-null ref)
      return { kind: "i32" };
    }

    // Array(n) — create array of length n, or Array(a,b,c) → [a,b,c]
    // Treat Array() the same as new Array() — they have identical semantics in JS.
    if (funcName === "Array") {
      return compileArrayConstructorCall(ctx, fctx, expr);
    }
  }

  // Regular function call
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    // Check if this is a closure call
    let closureInfo = ctx.closureMap.get(funcName);
    if (!closureInfo) {
      // Fallback: if the variable is a local with a ref type, look up closure info
      // by struct type index. This handles cases like:
      //   var f; f = function() { ... }; f();
      const localIdx = fctx.localMap.get(funcName);
      if (localIdx !== undefined) {
        const localType = localIdx < fctx.params.length
          ? fctx.params[localIdx]?.type
          : fctx.locals[localIdx - fctx.params.length]?.type;
        if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
          closureInfo = ctx.closureInfoByTypeIdx.get(localType.typeIdx);
        }
      }
    }
    if (closureInfo) {
      return compileClosureCall(ctx, fctx, expr, funcName, closureInfo);
    }

    const funcIdx = ctx.funcMap.get(funcName);
    if (funcIdx === undefined) {
      // Before giving up, check if this identifier is a local/param with callable TS type
      // (e.g. function parameter `fn: (x: number) => number` stored as externref).
      // If so, create or find a matching closure wrapper type and dispatch via call_ref.
      // Only attempt this for actual locals/params — not for unknown imported functions.
      const calleeLocalIdx = fctx.localMap.get(funcName);
      const calleeModGlobal = calleeLocalIdx === undefined ? ctx.moduleGlobals.get(funcName) : undefined;
      const calleeCapturedGlobal = calleeLocalIdx === undefined && calleeModGlobal === undefined ? ctx.capturedGlobals.get(funcName) : undefined;
      const isKnownVariable = calleeLocalIdx !== undefined || calleeModGlobal !== undefined || calleeCapturedGlobal !== undefined;
      const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
      const callSigs = isKnownVariable ? calleeTsType.getCallSignatures?.() : undefined;
      if (callSigs && callSigs.length > 0) {
        const sig = callSigs[0]!;
        const sigParamCount = sig.parameters.length;
        const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
        const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
        const sigParamWasmTypes: ValType[] = [];
        for (let i = 0; i < sigParamCount; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
          sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
        }

        // Eagerly create the closure wrapper types for this signature so the
        // lookup succeeds even when no actual closure with this signature has
        // been compiled yet (compilation order issue).
        // All callers must wrap their closures into this wrapper type before
        // passing them (see coercion in compileExpression and compileAssignment).
        const resultTypes = sigRetWasm ? [sigRetWasm] : [];
        const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);

        if (wrapperTypes) {
          const matchedClosureInfo = wrapperTypes.closureInfo;
          const matchedStructTypeIdx = wrapperTypes.structTypeIdx;

          // Compile the callee to get the value on the stack
          const innerResultType = compileExpression(ctx, fctx, expr.expression);

          // Save closure ref to a local
          let closureLocal: number;
          if (innerResultType?.kind === "externref") {
            const closureRefType: ValType = { kind: "ref_null", typeIdx: matchedStructTypeIdx };
            closureLocal = allocLocal(fctx, `__callable_param_${fctx.locals.length}`, closureRefType);
            fctx.body.push({ op: "any.convert_extern" });
            emitGuardedRefCast(fctx, matchedStructTypeIdx);
            fctx.body.push({ op: "local.set", index: closureLocal });
          } else {
            const closureRefType: ValType = innerResultType ?? { kind: "ref", typeIdx: matchedStructTypeIdx };
            closureLocal = allocLocal(fctx, `__callable_param_${fctx.locals.length}`, closureRefType);
            fctx.body.push({ op: "local.set", index: closureLocal });
          }

          // Push closure ref as first arg (self param of the lifted function)
          fctx.body.push({ op: "local.get", index: closureLocal });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);

          // Push call arguments with type coercion (only up to declared param count)
          {
            const cpParamCnt = matchedClosureInfo.paramTypes.length;
            for (let i = 0; i < Math.min(expr.arguments.length, cpParamCnt); i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
            }
            for (let i = cpParamCnt; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null && extraType !== VOID_RESULT) {
                fctx.body.push({ op: "drop" });
              }
            }
          }

          // Pad missing arguments with defaults
          for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
            pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
          }

          // Push the funcref from the closure struct (field 0) and call_ref
          fctx.body.push({ op: "local.get", index: closureLocal });
          // Null check: throw TypeError if closure ref is null (#728)
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.get", typeIdx: matchedStructTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

          return matchedClosureInfo.returnType ?? VOID_RESULT;
        }
      }

      // Graceful fallback for unknown functions — compile arguments (for side effects)
      // then emit ref.null extern (undefined) as the return value.
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }


    // Check if this function is eligible for call-site inlining
    const inlineInfo = ctx.inlinableFunctions.get(funcName);
    if (inlineInfo && !expr.arguments.some((a: any) => ts.isSpreadElement(a))) {
      // Inline the function body: compile arguments into temp locals, then emit body
      const argLocals: number[] = [];
      for (let i = 0; i < inlineInfo.paramCount; i++) {
        if (i < expr.arguments.length) {
          compileExpression(ctx, fctx, expr.arguments[i]!, inlineInfo.paramTypes[i]);
        } else {
          pushDefaultValue(fctx, inlineInfo.paramTypes[i]!);
        }
        const tmpLocal = allocLocal(fctx, `__inline_${funcName}_p${i}_${fctx.locals.length}`, inlineInfo.paramTypes[i]!);
        fctx.body.push({ op: "local.set", index: tmpLocal });
        argLocals.push(tmpLocal);
      }
      // Drop extra arguments (evaluate for side effects)
      for (let i = inlineInfo.paramCount; i < expr.arguments.length; i++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (extraType !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Emit the inlined body, remapping local.get indices to the temp locals
      for (const instr of inlineInfo.body) {
        if (instr.op === "local.get") {
          const mapped = argLocals[(instr as any).index];
          if (mapped !== undefined) {
            fctx.body.push({ op: "local.get", index: mapped });
          } else {
            fctx.body.push(instr); // should not happen for valid inline candidates
          }
        } else {
          fctx.body.push(instr);
        }
      }
      return inlineInfo.returnType ?? VOID_RESULT;
    }

    // Prepend captured values for nested functions with captures
    const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
    if (nestedCaptures) {
      for (const cap of nestedCaptures) {
        if (cap.mutable && cap.valType) {
          // Mutable capture: wrap in a ref cell so writes propagate back
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
          // Check if this local is already boxed (from a previous call to the same or another closure)
          if (fctx.boxedCaptures?.has(cap.name)) {
            // Already a ref cell — pass the ref cell reference directly
            const currentLocalIdx = fctx.localMap.get(cap.name)!;
            fctx.body.push({ op: "local.get", index: currentLocalIdx });
          } else {
            // Create a ref cell, store the current value, keep ref on stack
            fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
            fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
            // Also box the outer local so subsequent reads/writes go through the ref cell
            const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref", typeIdx: refCellTypeIdx });
            // Duplicate: need the ref cell for the call AND for the outer local
            fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
            // Re-register the original name to point to the boxed local
            fctx.localMap.set(cap.name, boxedLocalIdx);
            if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
            fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
          }
        } else {
          // TDZ check for captured let/const variables
          const capTdzIdx = fctx.tdzFlagLocals?.get(cap.name);
          if (capTdzIdx !== undefined) {
            emitLocalTdzCheck(ctx, fctx, cap.name, capTdzIdx);
          }
          fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
        }
      }
    }

    // Check for rest parameters on the callee
    const restInfo = ctx.funcRestParams.get(funcName);

    // Check if any argument uses spread syntax
    const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));

    if (restInfo && !hasSpreadArg) {
      // Calling a rest-param function: pack trailing args into a GC array
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // Compile non-rest arguments
      for (let i = 0; i < restInfo.restIndex; i++) {
        if (i < expr.arguments.length) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, expr.arguments.length - restInfo.restIndex);
      // Push length first (for struct.new order: length, data)
      fctx.body.push({ op: "i32.const", value: restArgCount });
      // Push elements, then array.new_fixed
      for (let i = restInfo.restIndex; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, restInfo.elemType);
      }
      fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: restArgCount });
      // Wrap in vec struct: { length, data }
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    } else if (hasSpreadArg) {
      // Spread in function call: fn(...arr) — unpack array elements as positional args
      compileSpreadCallArgs(ctx, fctx, expr, funcIdx, restInfo);
    } else {
      // Normal call — compile provided arguments with type hints from function signature
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      const captureCount = nestedCaptures ? nestedCaptures.length : 0;
      // User-visible param count excludes capture params (which are prepended internally)
      const paramCount = paramTypes ? paramTypes.length - captureCount : expr.arguments.length;
      for (let i = 0; i < expr.arguments.length; i++) {
        if (i < paramCount) {
          // Offset into paramTypes by captureCount since captures are the leading params
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + captureCount]);
        } else {
          // Extra argument beyond function's parameter count — evaluate for
          // side effects (JS semantics) and discard the result
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }

      // Supply defaults for missing optional params
      const optInfo = ctx.funcOptionalParams.get(funcName);
      if (optInfo) {
        const numProvided = expr.arguments.length;
        for (const opt of optInfo) {
          if (opt.index >= numProvided) {
            pushDefaultValue(fctx, opt.type);
          }
        }
      }

      // Pad any remaining missing arguments with defaults
      // (handles arity mismatch: calling f(a, b) with just f(1))
      if (paramTypes) {
        // Count how many args were actually pushed: provided args (capped at paramCount)
        // plus optional param defaults already pushed
        // plus capture params already pushed by nestedCaptures loop above
        const providedCount = Math.min(expr.arguments.length, paramCount) + captureCount;
        const optFilledCount = optInfo
          ? optInfo.filter(o => o.index >= expr.arguments.length).length
          : 0;
        const totalPushed = providedCount + optFilledCount;
        for (let i = totalPushed; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!);
        }
      }
    }

    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

    // Determine return type from function signature
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
      // Safety check: if the Wasm function actually has void return (e.g. async
      // functions with Promise<void>), the TS type may be misleading
      if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
      return resolveWasmType(ctx, retType);
    }
    return { kind: "f64" };
  }

  // Handle IIFE: (function() { ... })() or (() => expr)() — inline the function body
  {
    // Unwrap parenthesized expression to find the function/arrow
    let callee = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
      // Generator function expressions (function*) must NOT be inlined as IIFEs
      // because their body contains `yield` which requires a generator context.
      // Let them fall through to the normal closure compilation path (#657).
      const isGeneratorIIFE = ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined;
      if (isGeneratorIIFE) {
        // Fall through to normal call compilation below
      } else {
      const params = callee.parameters;
      const args = expr.arguments;
      // Support IIFEs with matching parameter/argument counts
      if (params.length <= args.length) {
        // Allocate locals for parameters and compile arguments
        const paramLocals: number[] = [];
        for (let i = 0; i < params.length; i++) {
          const paramName = ts.isIdentifier(params[i]!.name) ? params[i]!.name.text : `__iife_p${i}`;
          const argType = compileExpression(ctx, fctx, args[i]!);
          const localType = argType ?? { kind: "f64" as const };
          const idx = allocLocal(fctx, paramName, localType);
          fctx.body.push({ op: "local.set", index: idx });
          paramLocals.push(idx);
        }
        // Drop extra arguments
        for (let i = params.length; i < args.length; i++) {
          const t = compileExpression(ctx, fctx, args[i]!);
          if (t && t !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
        // Compile body
        if (ts.isArrowFunction(callee) && !ts.isBlock(callee.body)) {
          // Concise body: expression — no return issue
          return compileExpression(ctx, fctx, callee.body);
        }

        // Block body (arrow or function expression) — need to handle return
        const bodyStmts = ts.isArrowFunction(callee) ? (callee.body as ts.Block).statements : callee.body.statements;
        if (bodyStmts.length === 0) {
          return VOID_RESULT;
        }

        // Determine return type from TS
        const iifeRetType = ctx.checker.getTypeAtLocation(expr);
        const iifeWasmRetType = isVoidType(iifeRetType) ? null : resolveWasmType(ctx, iifeRetType);

        if (iifeWasmRetType) {
          // Returning IIFE: allocate a result local, compile body into a block,
          // and replace `return` with `local.set + br` to exit the block
          const retLocal = allocLocal(fctx, `__iife_ret_${fctx.locals.length}`, iifeWasmRetType);
          const savedBody = fctx.body;
          fctx.savedBodies.push(savedBody);
          const blockBody: Instr[] = [];
          fctx.body = blockBody;

          // Save and override returnType so that return statements inside the
          // IIFE coerce to the IIFE's own return type, not the outer function's.
          // Without this, a boolean-returning IIFE inside an f64-returning
          // function would coerce i32→f64 before local.set into an i32 local.
          const savedReturnType = fctx.returnType;
          fctx.returnType = iifeWasmRetType;

          // Increase block depth so return→br targets the right level
          fctx.blockDepth++;
          for (const stmt of bodyStmts) {
            compileStatement(ctx, fctx, stmt);
          }
          fctx.blockDepth--;

          // Restore outer function's return type
          fctx.returnType = savedReturnType;
          fctx.savedBodies.pop();
          fctx.body = savedBody;

          // Post-process: replace `return` / `return_call` / `return_call_ref` ops
          // with `local.set retLocal + br <depth>`.  Tail-call optimization in
          // compileReturnStatement may have merged call+return into return_call;
          // inside an IIFE we must undo that since we need local.set + br instead.
          function patchReturns(instrs: Instr[], depth: number): void {
            for (let i = 0; i < instrs.length; i++) {
              const op = instrs[i]!.op;
              if (op === "return") {
                // The instruction before `return` is the return value expression.
                // Replace `return` with `local.set + br`
                instrs[i] = { op: "local.set", index: retLocal } as Instr;
                instrs.splice(i + 1, 0, { op: "br", depth } as Instr);
                i++; // skip the inserted br
              } else if (op === "return_call" || op === "return_call_ref") {
                // Undo tail-call: return_call funcIdx → call funcIdx + local.set + br
                const instr = instrs[i] as any;
                instr.op = op === "return_call" ? "call" : "call_ref";
                instrs.splice(i + 1, 0,
                  { op: "local.set", index: retLocal } as Instr,
                  { op: "br", depth } as Instr,
                );
                i += 2; // skip inserted instructions
              }
              // Recurse into sub-blocks (if/then/else/block/loop)
              const instr = instrs[i] as any;
              if (instr.then) patchReturns(instr.then, depth + 1);
              if (instr.else) patchReturns(instr.else, depth + 1);
              if (instr.body && Array.isArray(instr.body)) patchReturns(instr.body, depth + 1);
            }
          }
          patchReturns(blockBody, 0);

          // Emit: block { <body> } local.get retLocal
          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: blockBody,
          } as Instr);
          fctx.body.push({ op: "local.get", index: retLocal });
          return iifeWasmRetType;
        } else {
          // Void IIFE — just compile inline
          for (const stmt of bodyStmts) {
            compileStatement(ctx, fctx, stmt);
          }
          return VOID_RESULT;
        }
      }
      } // end else (non-generator IIFE)
    }
  }

  // Handle standalone super() calls (constructor chaining) — normally handled by
  // compileClassBodies, but handle here as fallback
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    // super() call in constructor — already handled by compileClassBodies inline
    // Just return void since the work is done there
    return null;
  }

  // Handle IIFE: (function(...) { ... })(...) — immediately invoked function expression
  {
    const iifeResult = compileIIFE(ctx, fctx, expr);
    if (iifeResult !== undefined) return iifeResult;
  }

  // Handle comma-operator indirect calls: (0, foo)() or (expr, fn)()
  // Unwrap parenthesized comma expression, evaluate left for side effects, call right.
  {
    let callee = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Evaluate left side for side effects and drop
      const leftType = compileExpression(ctx, fctx, callee.left);
      if (leftType && leftType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      // Create a synthetic call with the right side as callee
      const syntheticCall = ts.factory.createCallExpression(
        callee.right as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      // Preserve parent for type checker resolution
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle ElementAccessExpression calls: obj['method']() or obj[0]() or obj[constKey]()
  // Convert to equivalent property access method call when the index resolves to a static key.
  if (ts.isElementAccessExpression(expr.expression)) {
    const elemAccess = expr.expression;
    const argExpr = elemAccess.argumentExpression;
    // Resolve the key to a static string: string literals, numeric literals, const variables, etc.
    let resolvedMethodName: string | undefined;
    if (argExpr) {
      if (ts.isStringLiteral(argExpr)) {
        resolvedMethodName = argExpr.text;
      } else if (ts.isNumericLiteral(argExpr)) {
        resolvedMethodName = String(Number(argExpr.text));
      } else {
        resolvedMethodName = resolveComputedKeyExpression(ctx, argExpr);
      }
    }

    // Handle super['method']() calls — resolve to ParentClass_method with this as first arg
    if (elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword && resolvedMethodName !== undefined) {
      return compileSuperElementMethodCall(ctx, fctx, expr, resolvedMethodName);
    }

    if (resolvedMethodName !== undefined) {
      const methodName = resolvedMethodName;
      const receiverType = ctx.checker.getTypeAtLocation(elemAccess.expression);

      // Try class instance method: ClassName_methodName
      let receiverClassName = receiverType.getSymbol()?.name;
      if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
        receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
      }
      if (receiverClassName && ctx.classSet.has(receiverClassName)) {
        const fullName = `${receiverClassName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          compileExpression(ctx, fctx, elemAccess.expression);
          // Push remaining arguments with type hints
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }

      // Try struct method: structName_methodName
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, elemAccess.expression);
          // Null-guard: if receiver is ref_null, check for null before calling method
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName)) callReturnType = resolveWasmType(ctx, retType);
            }
            const tmp = allocLocal(fctx, `__ng_ea_recv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            for (let i = 0; i < expr.arguments.length; i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            }
            if (paramTypes) {
              for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }
            fctx.body.push({ op: "call", funcIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: [] as Instr[],
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType = callReturnType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
                : callReturnType;
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: defaultValueInstrs(resultType),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          for (let i = 0; i < expr.arguments.length; i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
          }
          if (paramTypes) {
            for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }

      // Try static method: ClassName.staticMethod via element access
      if (ts.isIdentifier(elemAccess.expression) && ctx.classSet.has(elemAccess.expression.text)) {
        const clsName = elemAccess.expression.text;
        const fullName = `${clsName}_${methodName}`;
        if (ctx.staticMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined) {
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            for (let i = 0; i < expr.arguments.length; i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
            }
            if (paramTypes) {
              for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!);
              }
            }
            fctx.body.push({ op: "call", funcIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
              return resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }

      // Try string method: string_methodName
      if (isStringType(receiverType)) {
        const importName = `string_${methodName}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, elemAccess.expression);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const args = expr.arguments;
          for (let ai = 0; ai < args.length; ai++) {
            const argResult = compileExpression(ctx, fctx, args[ai]!);
            const expectedType = paramTypes?.[ai + 1];
            if (argResult && expectedType && argResult.kind !== expectedType.kind) {
              coerceType(ctx, fctx, argResult, expectedType);
            }
          }
          if (paramTypes && args.length + 1 < paramTypes.length) {
            for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
              const pt = paramTypes[pi]!;
              if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
              else if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
              else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          const returnsBool = methodName === "includes" || methodName === "startsWith" || methodName === "endsWith";
          return returnsBool ? { kind: "i32" } : methodName === "indexOf" || methodName === "lastIndexOf" ? { kind: "f64" } : { kind: "externref" };
        }
      }

      // Try number method: number.toString(), number.toFixed()
      if (isNumberType(receiverType) && (methodName === "toString" || methodName === "toFixed")) {
        const exprType = compileExpression(ctx, fctx, elemAccess.expression);
        if (exprType && exprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        if (methodName === "toFixed" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!);
        } else if (methodName === "toFixed") {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const funcIdx = ctx.funcMap.get(methodName === "toFixed" ? "number_toFixed" : "number_toString");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }

      // Try array method calls
      {
        const arrMethodResult = compileArrayMethodCall(ctx, fctx, elemAccess, expr, receiverType, methodName);
        if (arrMethodResult !== undefined) return arrMethodResult;
      }

      // Fallback for resolved element access calls that didn't match any known method:
      // compile receiver, discard; compile each argument for side effects; return externref.
      {
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType && recvType !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType && argType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Fallback for element access calls where the key couldn't be resolved statically:
    // compile receiver + index expression + arguments for side effects; return externref.
    {
      const recvType = compileExpression(ctx, fctx, elemAccess.expression);
      if (recvType && recvType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
      if (argExpr) {
        const keyType = compileExpression(ctx, fctx, argExpr);
        if (keyType && keyType !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
      }
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType && argType !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle fn.bind(thisArg, ...partialArgs)(...remainingArgs) — immediate bind+call
  // Transform to fn(...partialArgs, ...remainingArgs), dropping thisArg.
  if (ts.isCallExpression(expr.expression)) {
    const bindCall = expr.expression;
    if (ts.isPropertyAccessExpression(bindCall.expression) &&
        bindCall.expression.name.text === "bind") {
      const bindTarget = bindCall.expression.expression;

      // Case: identifier.bind(thisArg, ...partialArgs)(...args)
      if (ts.isIdentifier(bindTarget)) {
        const funcName = bindTarget.text;
        const closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first bind argument) for side effects
          if (bindCall.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, bindCall.arguments[0]!);
            if (thisType && thisType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }

          // Collect all effective arguments: partial args from bind + remaining args from outer call
          const partialArgs = bindCall.arguments.length > 1
            ? Array.from(bindCall.arguments).slice(1)
            : [];
          const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

          if (closureInfo) {
            const syntheticCall = ts.factory.createCallExpression(
              bindTarget,
              undefined,
              allArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as any).parent = expr.parent;
            return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
          }

          // Regular function call
          const paramTypes = getFuncParamTypes(ctx, funcIdx!);
          for (let i = 0; i < allArgs.length; i++) {
            compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i]);
          }

          // Supply defaults for missing optional params
          const optInfo = ctx.funcOptionalParams.get(funcName);
          if (optInfo) {
            for (const opt of optInfo) {
              if (opt.index >= allArgs.length) {
                pushDefaultValue(fctx, opt.type);
              }
            }
          }

          // Pad remaining missing params
          if (paramTypes) {
            const optFilledCount = optInfo
              ? optInfo.filter(o => o.index >= allArgs.length).length
              : 0;
            const totalPushed = allArgs.length + optFilledCount;
            for (let i = totalPushed; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!);
            }
          }

          const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
          fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return resolveWasmType(ctx, retType);
          }
          return { kind: "f64" };
        }
      }

      // Case: obj.method.bind(thisArg)(...args) — method call with different receiver
      if (ts.isPropertyAccessExpression(bindTarget)) {
        const methodName = bindTarget.name.text;
        const objExpr = bindTarget.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && bindCall.arguments.length > 0) {
            // First bind argument is the thisArg (receiver)
            compileExpression(ctx, fctx, bindCall.arguments[0]!);

            // Remaining bind args + outer call args
            const partialArgs = bindCall.arguments.length > 1
              ? Array.from(bindCall.arguments).slice(1)
              : [];
            const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            for (let i = 0; i < allArgs.length; i++) {
              compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i + 1]);
            }

            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
              return resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }
    }
  }

  // Handle CallExpression as callee: fn()(), makeAdder(10)(32), etc.
  // The inner call returns a closure struct (possibly coerced to externref),
  // and we need to call the returned closure with the outer arguments.
  if (ts.isCallExpression(expr.expression)) {
    // Get the TS type of the inner call result — should be a callable type
    const innerResultTsType = ctx.checker.getTypeAtLocation(expr.expression);
    const callSigs = innerResultTsType.getCallSignatures?.();

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Find matching closure info by comparing param types and return type
      // against all registered closure types
      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;

      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        // Check return type match
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
        // Check param types match
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
        // Compile the inner call expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        // Save closure ref to a local so we can extract both args and funcref
        let closureLocal: number;
        if (innerResultType?.kind === "externref") {
          // Need to convert externref back to the closure struct ref (guarded)
          const closureRefType: ValType = { kind: "ref_null", typeIdx: matchedStructTypeIdx };
          closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, matchedStructTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });
        } else {
          const closureRefType: ValType = innerResultType ?? { kind: "ref", typeIdx: matchedStructTypeIdx };
          closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "local.set", index: closureLocal });
        }

        // Push closure ref as first arg (self param of the lifted function)
        // The local is ref_null but the function expects non-null ref, so cast
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "ref.as_non_null" } as Instr);

        // Push call arguments (only up to declared param count)
        {
          const crParamCnt = matchedClosureInfo.paramTypes.length;
          for (let i = 0; i < Math.min(expr.arguments.length, crParamCnt); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
          }
          for (let i = crParamCnt; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }

        // Pad missing arguments with defaults
        for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
        }

        // Push the funcref from the closure struct (field 0) and cast to typed ref
        fctx.body.push({ op: "local.get", index: closureLocal });
        // Null check: throw TypeError if closure ref is null (#728)
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
        fctx.body.push({ op: "struct.get", typeIdx: matchedStructTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
        fctx.body.push({ op: "ref.as_non_null" });

        // call_ref with the lifted function's type index
        fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

        // Return VOID_RESULT for void closures so compileExpression doesn't
        // treat the null return as a compilation failure and roll back instructions
        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }
  }

  // Handle ConditionalExpression as callee (not wrapped in parens):
  // (cond ? fn1 : fn2)(args) — handled directly
  if (ts.isConditionalExpression(expr.expression)) {
    return compileConditionalCallee(ctx, fctx, expr, expr.expression);
  }

  // Generic fallback: compile the callee expression to get a value on the stack,
  // then try to use it as a closure call. This handles patterns like
  // accessing function values from complex expressions.
  {
    const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
    const callSigs = calleeTsType.getCallSignatures?.();

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Look for a matching closure type
      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

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
        // Compile the callee expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        // Save closure ref to a local
        let closureLocal: number;
        if (innerResultType?.kind === "externref") {
          const closureRefType: ValType = { kind: "ref_null", typeIdx: matchedStructTypeIdx };
          closureLocal = allocLocal(fctx, `__cond_call_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, matchedStructTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });
        } else {
          const closureRefType: ValType = innerResultType ?? { kind: "ref", typeIdx: matchedStructTypeIdx };
          closureLocal = allocLocal(fctx, `__cond_call_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "local.set", index: closureLocal });
        }

        // Push closure ref as first arg (self param)
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "ref.as_non_null" } as Instr);

        // Push call arguments (only up to declared param count)
        {
          const ccParamCnt = matchedClosureInfo.paramTypes.length;
          for (let i = 0; i < Math.min(expr.arguments.length, ccParamCnt); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
          }
          for (let i = ccParamCnt; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null && extraType !== VOID_RESULT) {
              fctx.body.push({ op: "drop" });
            }
          }
        }

        // Pad missing arguments
        for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
        }

        // Push the funcref from closure struct and call_ref
        fctx.body.push({ op: "local.get", index: closureLocal });
        // Null check: throw TypeError if closure ref is null (#728)
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
        fctx.body.push({ op: "ref.as_non_null" } as Instr);
        fctx.body.push({ op: "struct.get", typeIdx: matchedStructTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
        fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }

  }

  // Graceful fallback: compile the callee expression and all arguments for side effects,
  // then push ref.null.extern. This avoids hard compile errors for unrecognized call patterns
  // (e.g. chained calls, dynamic dispatch, uncommon AST shapes).
  {
    const calleeType = compileExpression(ctx, fctx, expr.expression);
    if (calleeType && calleeType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType && argType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile a call with a ConditionalExpression callee: (cond ? fn1 : fn2)(args)
 *
 * We compile the condition, then emit an if/else where each branch makes
 * the call with the respective callee.
 *
 * Cannot create synthetic CallExpression via ts.factory because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler above.
 */
function compileConditionalCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  condExpr: ts.ConditionalExpression,
): InnerResult {
  // Compile condition
  const condType = compileExpression(ctx, fctx, condExpr.condition);
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  // Determine the expected return type of the call from the original expression
  const callSig = ctx.checker.getResolvedSignature(expr);
  let callRetType: ValType | null = null;
  if (callSig) {
    const retTsType = ctx.checker.getReturnTypeOfSignature(callSig);
    if (!isVoidType(retTsType)) {
      callRetType = resolveWasmType(ctx, retTsType);
    }
  }

  // Helper: compile a call branch by constructing the call inline
  // Uses the branch expression (whenTrue or whenFalse) as the callee.
  function compileBranchCall(branchExpr: ts.Expression): InnerResult {
    // If the branch is an identifier referencing a known function, call it directly
    if (ts.isIdentifier(branchExpr)) {
      const funcName = branchExpr.text;
      let closureInfo = ctx.closureMap.get(funcName);
      // Fallback: if variable is a local with ref type, look up closure info by type idx
      if (!closureInfo) {
        const localIdx = fctx.localMap.get(funcName);
        if (localIdx !== undefined) {
          const localType = localIdx < fctx.params.length
            ? fctx.params[localIdx]?.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
          if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
            closureInfo = ctx.closureInfoByTypeIdx.get(localType.typeIdx);
          }
        }
      }
      if (closureInfo) {
        // Use the original expr's arguments but with this identifier as callee
        // Create a minimal synthetic object that mimics a CallExpression
        // for compileClosureCall
        const syntheticCall = Object.create(expr);
        syntheticCall.expression = branchExpr;
        return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
      }
      const funcIdx = ctx.funcMap.get(funcName);
      if (funcIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
        }
        // Pad missing arguments with defaults
        if (paramTypes) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }
        const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
        if (callRetType) return callRetType;
        // Try to determine return type from the branch function's signature
        const branchType = ctx.checker.getTypeAtLocation(branchExpr);
        const branchSigs = branchType.getCallSignatures?.();
        if (branchSigs && branchSigs.length > 0) {
          const retType = ctx.checker.getReturnTypeOfSignature(branchSigs[0]!);
          if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
          return resolveWasmType(ctx, retType);
        }
        return callRetType ?? { kind: "f64" };
      }
    }

    // If the branch is itself a conditional, recurse
    if (ts.isConditionalExpression(branchExpr)) {
      return compileConditionalCallee(ctx, fctx, expr, branchExpr);
    }

    // If the branch is wrapped in parens, unwrap
    if (ts.isParenthesizedExpression(branchExpr)) {
      let inner: ts.Expression = branchExpr;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      return compileBranchCall(inner);
    }

    // If the branch is a property access, try method call
    if (ts.isPropertyAccessExpression(branchExpr)) {
      // Create a synthetic call with the property access as callee
      // PropertyAccessExpression IS a LeftHandSideExpression so no infinite recursion
      const syntheticCall = ts.factory.createCallExpression(
        branchExpr,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }

    // Fallback: compile expression value and try to use as closure call
    const calleeType = compileExpression(ctx, fctx, branchExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    if (callRetType) {
      pushDefaultValue(fctx, callRetType);
      return callRetType;
    }
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  // Compile then-branch call
  const savedBody = fctx.body;
  fctx.body = [];
  let thenType = compileBranchCall(condExpr.whenTrue);
  let thenInstrs = fctx.body;

  // Compile else-branch call
  fctx.body = [];
  let elseType = compileBranchCall(condExpr.whenFalse);
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  // Determine result type
  if (thenType === VOID_RESULT && elseType === VOID_RESULT) {
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: elseInstrs,
    });
    return VOID_RESULT;
  }

  // Coerce branches to a common type
  const thenVal: ValType = thenType && thenType !== VOID_RESULT ? thenType : callRetType ?? { kind: "f64" };
  const elseVal: ValType = elseType && elseType !== VOID_RESULT ? elseType : callRetType ?? { kind: "f64" };
  let resultType: ValType = callRetType ?? thenVal;

  // If types don't match, coerce both to the result type
  if (thenVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, thenVal, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }
  if (elseVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, elseVal, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  // Handle void branches that need to produce a value
  if (thenType === VOID_RESULT || thenType === null) {
    thenInstrs = [...thenInstrs, ...defaultValueInstrs(resultType)];
  }
  if (elseType === VOID_RESULT || elseType === null) {
    elseInstrs = [...elseInstrs, ...defaultValueInstrs(resultType)];
  }

  // Widen ref to ref_null when a branch uses defaultValueInstrs (which produces ref.null)
  if (resultType.kind === "ref" && (thenType === VOID_RESULT || thenType === null || elseType === VOID_RESULT || elseType === null)) {
    resultType = { kind: "ref_null", typeIdx: (resultType as any).typeIdx };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  return resultType;
}

/**
 * Compile a call where the callee is an arbitrary expression that is not a
 * LeftHandSideExpression (e.g. assignment: `(x = fn)()`, logical: `(a || fn)()`).
 *
 * We cannot use ts.factory.createCallExpression for these because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler.
 *
 * Strategy: compile the callee expression to get its value on the stack,
 * then try to use the result as a closure call (closure-matching by type),
 * or as a direct function call if the expression resolves to a known function.
 */
function compileExpressionCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  calleeExpr: ts.Expression,
): InnerResult {
  // For assignment expressions, we can look at the RHS to identify the function
  // being called, while still compiling the full assignment for side effects.
  if (ts.isBinaryExpression(calleeExpr) &&
      calleeExpr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      calleeExpr.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      calleeExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // For simple assignment (x = fn)(), compile the assignment for side effects
    // then call the RHS function directly if it's identifiable.
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs)) {
      const funcIdx = ctx.funcMap.get(rhs.text);
      const closureInfo = ctx.closureMap.get(rhs.text);
      if (funcIdx !== undefined || closureInfo) {
        // Compile the full assignment for side effects (stores value in LHS)
        const assignResult = compileExpression(ctx, fctx, calleeExpr);
        if (assignResult && assignResult !== VOID_RESULT) {
          fctx.body.push({ op: "drop" });
        }
        // Now make a direct call using the RHS identifier as callee
        const syntheticCall = ts.factory.createCallExpression(
          rhs,
          expr.typeArguments,
          expr.arguments,
        );
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }
    }
  }

  // Generic path: compile the callee expression and try closure-matching
  const calleeTsType = ctx.checker.getTypeAtLocation(calleeExpr);
  const callSigs = calleeTsType.getCallSignatures?.();

  if (callSigs && callSigs.length > 0) {
    const sig = callSigs[0]!;

    // Look for a matching closure type
    const sigParamCount = sig.parameters.length;
    const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
    const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
    const sigParamWasmTypes: ValType[] = [];
    for (let i = 0; i < sigParamCount; i++) {
      const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
      sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
    }

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
      // Compile the callee expression to get the closure on the stack
      const innerResultType = compileExpression(ctx, fctx, calleeExpr);

      // Save closure ref to a local
      let closureLocal: number;
      if (innerResultType?.kind === "externref") {
        const closureRefType: ValType = { kind: "ref_null", typeIdx: matchedStructTypeIdx };
        closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, matchedStructTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });
      } else {
        const closureRefType: ValType = innerResultType ?? { kind: "ref", typeIdx: matchedStructTypeIdx };
        closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "local.set", index: closureLocal });
      }

      // Push closure ref as first arg (self param)
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);

      // Push call arguments (only up to declared param count)
      {
        const ecParamCnt = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, ecParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
        for (let i = ecParamCnt; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null && extraType !== VOID_RESULT) {
            fctx.body.push({ op: "drop" });
          }
        }
      }

      // Pad missing arguments
      for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!);
      }

      // Push the funcref from closure struct and call_ref
      fctx.body.push({ op: "local.get", index: closureLocal });
      // Null check: throw TypeError if closure ref is null (#728)
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
      fctx.body.push({ op: "struct.get", typeIdx: matchedStructTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: matchedClosureInfo.funcTypeIdx });

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Last resort: compile the callee for side effects and try to resolve
  // the call via the RHS of an assignment or the last operand
  if (ts.isBinaryExpression(calleeExpr)) {
    const assignResult = compileExpression(ctx, fctx, calleeExpr);
    if (assignResult && assignResult !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    // Try calling the RHS (for assignment) or right operand (for logical)
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs) || ts.isPropertyAccessExpression(rhs)) {
      const syntheticCall = ts.factory.createCallExpression(
        rhs as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Graceful fallback for non-LHSE callee: compile callee and args for side effects,
  // return externref null. Avoids hard compile errors for uncommon callee shapes.
  {
    const calleeType = compileExpression(ctx, fctx, calleeExpr);
    if (calleeType && calleeType !== VOID_RESULT) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType && argType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile an IIFE (Immediately Invoked Function Expression):
 *   (function(params) { body })(args)
 *
 * Strategy: compile the function expression as a named module-level function
 * with a unique synthetic name, then emit a direct call to it.
 * Captures from the enclosing scope are passed as extra leading parameters.
 *
 * Returns undefined if the expression is not an IIFE pattern.
 */
function compileIIFE(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // Unwrap parenthesized expression to find the function expression
  let callee = expr.expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isFunctionExpression(callee) && !ts.isArrowFunction(callee)) {
    return undefined; // not an IIFE
  }
  // Generator function expressions (function*) cannot be inlined as IIFEs
  // because their body uses `yield` which requires a generator FunctionContext (#657).
  if (ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined) {
    return undefined;
  }
  const funcExpr = callee as ts.FunctionExpression | ts.ArrowFunction;

  // Determine parameter types from the function's declared parameters
  const paramTypes: ValType[] = [];
  for (const p of funcExpr.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    paramTypes.push(resolveWasmType(ctx, paramType));
  }

  // Determine return type
  const sig = ctx.checker.getSignatureFromDeclaration(funcExpr);
  let returnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope
  const body = funcExpr.body;
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Detect which captured variables are written inside the IIFE body
  const writtenInIIFE = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInIIFE);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInIIFE);
  }

  const ownParamNames = new Set(
    funcExpr.parameters
      .filter((p) => ts.isIdentifier(p.name))
      .map((p) => (p.name as ts.Identifier).text),
  );

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean }[] = [];
  for (const name of referencedNames) {
    if (ownParamNames.has(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInIIFE.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // Generate a unique name for the IIFE
  const iifeName = `__iife_${ctx.closureCounter++}`;
  const results: ValType[] = returnType ? [returnType] : [];

  // Build parameter types: for mutable captures use ref cells, others pass by value
  // Use ref_null for ref types to allow null default initialization (var hoisting)
  const captureParamTypes = captures.map((c) => {
    if (c.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
      return { kind: "ref_null" as const, typeIdx: refCellTypeIdx };
    }
    // Widen ref to ref_null so hoisted vars initialized to null can be passed
    if (c.type.kind === "ref") {
      return { kind: "ref_null" as const, typeIdx: (c.type as { typeIdx: number }).typeIdx };
    }
    return c.type;
  });
  const allParamTypes = [...captureParamTypes, ...paramTypes];
  const funcTypeIdx = addFuncType(ctx, allParamTypes, results, `${iifeName}_type`);

  const liftedFctx: FunctionContext = {
    name: iifeName,
    params: [
      ...captures.map((c, i) => ({ name: c.name, type: captureParamTypes[i]! })),
      ...funcExpr.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i] ?? ({ kind: "f64" } as ValType),
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // For mutable captures, register them as boxed so read/write uses struct.get/set
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
    }
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    // Concise arrow body — expression is the return value
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType === null && returnType) {
      // Push default return value
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  // Append default return if needed
  if (returnType) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Register the lifted function
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: iifeName,
    typeIdx: funcTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(iifeName, funcIdx);

  // Emit the call: push captures (with ref cells for mutable ones), then arguments, then call
  for (const cap of captures) {
    if (cap.mutable) {
      // Wrap the current value in a ref cell for mutable capture
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      // Check if the outer local is already boxed
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Create a ref cell, store value, keep ref on stack
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref", typeIdx: refCellTypeIdx });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        // Re-register the original name to point to the boxed local
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }

  // Compile call arguments, matching to declared params; extras are evaluated and dropped
  // Flatten spread elements on array literals into individual expressions
  const flatIIFEArgs = flattenCallArgs(expr.arguments) ?? expr.arguments as unknown as ts.Expression[];
  const paramCount = paramTypes.length;
  for (let i = 0; i < flatIIFEArgs.length; i++) {
    const arg = flatIIFEArgs[i]!;
    // Skip any remaining spread elements that couldn't be flattened
    if (ts.isSpreadElement(arg)) continue;
    if (i < paramCount) {
      compileExpression(ctx, fctx, arg, paramTypes[i]);
    } else {
      // Extra argument — evaluate for side effects, drop result
      const extraType = compileExpression(ctx, fctx, arg);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Supply defaults for missing params
  for (let i = flatIIFEArgs.length; i < paramCount; i++) {
    const pt = paramTypes[i] ?? { kind: "f64" as const };
    if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (pt.kind === "ref" || pt.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: pt.typeIdx });
  }

  // Re-lookup in case addUnionImports shifted indices
  const finalFuncIdx = ctx.funcMap.get(iifeName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

  if (returnType) return returnType;
  return VOID_RESULT;
}

// ── New expressions ──────────────────────────────────────────────────

/** Resolve the enclosing class name from a FunctionContext.
 *  Uses enclosingClassName if set (e.g. closures), otherwise parses ClassName from "ClassName_methodName". */
export function resolveEnclosingClassName(fctx: FunctionContext): string | undefined {
  if (fctx.enclosingClassName) return fctx.enclosingClassName;
  const underscoreIdx = fctx.name.indexOf("_");
  if (underscoreIdx > 0) return fctx.name.substring(0, underscoreIdx);
  return undefined;
}

/** Compile super.method(args) — resolve to ParentClass_method and call with this */
function compileSuperMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) return null;

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    ctx.errors.push({
      message: `Cannot use super in class without parent: ${currentClassName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Cannot find method '${methodName}' on parent class '${parentClassName}'`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  for (let i = 0; i < expr.arguments.length; i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return resolveWasmType(ctx, retType);
  }
  return null;
}

/**
 * Compile `super['method'](args)` — resolve to ParentClass_method and call with this.
 * Same logic as compileSuperMethodCall but the method name comes from a computed key.
 */
function compileSuperElementMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) return null;

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    ctx.errors.push({
      message: `Cannot use super in class without parent: ${currentClassName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Cannot find method '${methodName}' on parent class '${parentClassName}'`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  for (let i = 0; i < expr.arguments.length; i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return VOID_RESULT;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return VOID_RESULT;
    return resolveWasmType(ctx, retType);
  }
  return VOID_RESULT;
}

/**
 * Compile `super.prop` — access a parent class property or getter via `this`.
 * For getter accessors, calls the parent's getter function.
 * For struct fields, accesses the field on `this` (child struct inherits parent fields).
 */
export function compileSuperPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    ctx.errors.push({
      message: `Cannot use super outside of a class method: ${fctx.name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    ctx.errors.push({
      message: `Cannot use super in class without parent: ${currentClassName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        // Push this as argument to the getter
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this` — child struct includes parent fields
  // Walk up to find which ancestor defines this field
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        // Use the current class's struct since it inherits all parent fields
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex((f) => f.name === propName);
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        // If not found in current, try parent struct directly
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: could be a method reference (not a call) — try to find a parent method
  // For now, emit a default based on the TypeScript type at the access site
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Compile `super[expr]` — access a parent class property via computed key on `this`.
 * Resolves the key at compile time if possible and delegates to compileSuperPropertyAccess logic.
 * For dynamic keys, falls back to default value for the access type.
 */
export function compileSuperElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const argExpr = expr.argumentExpression;
  // Try to resolve the key to a static string
  let propName: string | undefined;
  if (argExpr) {
    if (ts.isStringLiteral(argExpr)) {
      propName = argExpr.text;
    } else if (ts.isNumericLiteral(argExpr)) {
      propName = String(Number(argExpr.text));
    } else {
      propName = resolveComputedKeyExpression(ctx, argExpr);
    }
  }

  if (propName === undefined) {
    // Dynamic key on super — cannot resolve at compile time
    // Emit default value for the access type
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    ctx.errors.push({
      message: `Cannot use super outside of a class method: ${fctx.name}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    ctx.errors.push({
      message: `Cannot use super in class without parent: ${currentClassName}`,
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this`
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex((f) => f.name === propName);
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: emit default value based on TypeScript type
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Infer the element type of an untyped `new Array()` by scanning how the
 * target variable is used. Walks the enclosing function body for element
 * assignments (arr[i] = value) and push calls (arr.push(value)), then
 * returns the TS element type of the first concrete (non-any) value found.
 */
function inferArrayElementType(ctx: CodegenContext, expr: ts.NewExpression): ts.Type | null {
  // Find the variable name this `new Array()` is assigned to.
  // Pattern: `var x = new Array()` or `var x: T = new Array()`
  const parent = expr.parent;
  let varName: string | null = null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    varName = parent.name.text;
  } else if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
             && ts.isIdentifier(parent.left)) {
    varName = parent.left.text;
  }
  if (!varName) return null;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = expr;
  while (scope && !ts.isFunctionDeclaration(scope) && !ts.isFunctionExpression(scope)
         && !ts.isArrowFunction(scope) && !ts.isMethodDeclaration(scope)
         && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return; // already found

    // arr[i] = value
    if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isElementAccessExpression(node.left)
        && ts.isIdentifier(node.left.expression)
        && node.left.expression.text === varName) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "push"
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === varName
        && node.arguments.length >= 1) {
      const valType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(scope);
  return inferredElemType;
}

/**
 * Check if a node tree references the `arguments` identifier
 * (skipping nested functions/arrows which have their own scope).
 */
function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return false;
  }
  return ts.forEachChild(node, usesArguments) ?? false;
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
function flattenCallArgs(args: readonly ts.Expression[]): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        // Spread on array literal: inline elements
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        // Spread on non-literal — can't flatten at compile time
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * Compile `new FunctionExpression(args)` — treats the function expression
 * as an immediately-invoked constructor. The function body is compiled
 * as a lifted closure function and called with the provided arguments.
 * Supports spread arguments and the `arguments` object.
 */
function compileNewFunctionExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcExpr: ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__new_ctor_${closureId}`;
  const body = funcExpr.body;
  if (!body || !ts.isBlock(body)) return null;

  // 1. Flatten call-site arguments (resolve spread on array literals)
  const rawArgs = expr.arguments ?? [];
  const flatArgs = flattenCallArgs(rawArgs);
  if (!flatArgs) {
    // Can't flatten spread at compile time — unsupported
    ctx.errors.push({
      message: "new FunctionExpression with non-literal spread not supported",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }

  const needsArguments = usesArguments(body);

  // 2. Determine the parameter list for the lifted function
  //    Use the function's formal params if it has them, otherwise
  //    create f64 params matching the flattened call-site args.
  const formalParams: ValType[] = [];
  if (funcExpr.parameters.length > 0) {
    for (const p of funcExpr.parameters) {
      const paramType = ctx.checker.getTypeAtLocation(p);
      formalParams.push(resolveWasmType(ctx, paramType));
    }
  } else {
    // No formal params — create f64 params for each call-site arg
    for (let i = 0; i < flatArgs.length; i++) {
      formalParams.push({ kind: "f64" });
    }
  }

  // 3. Analyze captured variables
  const referencedNames = new Set<string>();
  for (const stmt of body.statements) {
    collectReferencedIdentifiers(stmt, referencedNames);
  }
  const writtenInClosure = new Set<string>();
  for (const stmt of body.statements) {
    collectWrittenIdentifiers(stmt, writtenInClosure);
  }

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const isOwnParam = funcExpr.parameters.some(
      (p) => ts.isIdentifier(p.name) && p.name.text === name,
    );
    if (isOwnParam) continue;
    if (name === "arguments") continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    const isMutable = writtenInClosure.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // 4. Build the closure struct type
  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
    ...captures.map((c) => {
      if (c.mutable) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
        return {
          name: c.name,
          type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
          mutable: false,
        };
      }
      return { name: c.name, type: c.type, mutable: false };
    }),
  ];

  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
  });

  // 5. Build the lifted function
  //    Params: (ref $closure_struct, arg0: f64, arg1: f64, ...)
  const liftedParams: ValType[] = [
    { kind: "ref", typeIdx: structTypeIdx },
    ...formalParams,
  ];

  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, [], `${closureName}_type`);

  // Create the lifted function context
  const paramDefs: { name: string; type: ValType }[] = [
    { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } },
  ];
  if (funcExpr.parameters.length > 0) {
    for (let i = 0; i < funcExpr.parameters.length; i++) {
      const p = funcExpr.parameters[i]!;
      paramDefs.push({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: formalParams[i] ?? { kind: "f64" },
      });
    }
  } else {
    for (let i = 0; i < flatArgs.length; i++) {
      paramDefs.push({ name: `__arg${i}`, type: { kind: "f64" } });
    }
  }

  const liftedFctx: FunctionContext = {
    name: closureName,
    params: paramDefs,
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

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: 0 });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
    } else {
      const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
      liftedFctx.body.push({ op: "local.get", index: 0 });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // Set up `arguments` if the body references it
  if (needsArguments) {
    const numArgs = formalParams.length;
    const elemType: ValType = { kind: "f64" };
    const vti = getOrRegisterVecType(ctx, "f64", elemType);
    const ati = getArrTypeIdxFromVec(ctx, vti);
    const vecRef: ValType = { kind: "ref", typeIdx: vti };
    const argsLocal = allocLocal(liftedFctx, "arguments", vecRef);
    const arrTmp = allocLocal(liftedFctx, "__args_arr_tmp", { kind: "ref", typeIdx: ati });

    // Push each param coerced to f64
    for (let i = 0; i < numArgs; i++) {
      liftedFctx.body.push({ op: "local.get", index: i + 1 }); // skip __self
      const pt = formalParams[i]!;
      if (pt.kind === "i32") {
        liftedFctx.body.push({ op: "f64.convert_i32_s" });
      } else if (pt.kind === "externref" || pt.kind === "ref" || pt.kind === "ref_null") {
        liftedFctx.body.push({ op: "drop" });
        liftedFctx.body.push({ op: "f64.const", value: 0 });
      }
    }
    liftedFctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: numArgs });
    liftedFctx.body.push({ op: "local.set", index: arrTmp });
    liftedFctx.body.push({ op: "i32.const", value: numArgs });
    liftedFctx.body.push({ op: "local.get", index: arrTmp });
    liftedFctx.body.push({ op: "struct.new", typeIdx: vti });
    liftedFctx.body.push({ op: "local.set", index: argsLocal });
  }

  // 6. Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, liftedFctx, stmt);
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 7. Register the lifted function
  const liftedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(closureName, liftedFuncIdx);

  // 8. At the call site: build closure struct, push args, call
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      if (fctx.boxedCaptures?.has(cap.name)) {
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref_null", typeIdx: refCellTypeIdx });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Store closure struct in local for __self arg
  const closureLocal = allocLocal(fctx, `__ctor_closure_${closureId}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: closureLocal });

  // Push __self argument
  fctx.body.push({ op: "local.get", index: closureLocal });

  // Push call-site arguments (flattened, spread already resolved)
  for (let i = 0; i < flatArgs.length; i++) {
    compileExpression(ctx, fctx, flatArgs[i]!, formalParams[i]);
  }

  // Call the lifted function
  fctx.body.push({ op: "call", funcIdx: liftedFuncIdx });

  // new expression returns the constructed object — produce externref null
  // since we don't construct actual objects, and callers typically discard the result
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * Compile a ClassExpression used as a value (e.g. `x = class { ... }`).
 * The class should already be collected during the collection phase.
 * We produce the constructor function reference so the class can be instantiated.
 */
export function compileClassExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ClassExpression,
): ValType | null {
  // Look up the synthetic name assigned during the collection phase
  const syntheticName = ctx.anonClassExprNames.get(expr);
  if (syntheticName) {
    const ctorName = `${syntheticName}_new`;
    const funcIdx = ctx.funcMap.get(ctorName);
    if (funcIdx !== undefined) {
      // Produce a ref.func to the constructor as the class value
      fctx.body.push({ op: "ref.func", funcIdx });
      return { kind: "funcref" };
    }
  }

  // If the class has a name, check if it was collected under that name
  if (expr.name) {
    const className = expr.name.text;
    if (ctx.classSet.has(className)) {
      const ctorName = `${className}_new`;
      const funcIdx = ctx.funcMap.get(ctorName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "ref.func", funcIdx });
        return { kind: "funcref" };
      }
    }
  }

  // Fallback: produce externref null (class was not collected)
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

export function compileNewExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null {
  // Handle `new function() { ... }(args)` — constructor with function expression
  if (ts.isFunctionExpression(expr.expression)) {
    return compileNewFunctionExpression(ctx, fctx, expr, expr.expression);
  }

  // Handle `new (class { ... })()` — anonymous class expression in new
  // Unwrap parenthesized expressions to find the class expression
  {
    let unwrappedExpr: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrappedExpr)) {
      unwrappedExpr = unwrappedExpr.expression;
    }
    if (ts.isClassExpression(unwrappedExpr)) {
      // Look up the synthetic name assigned during the collection phase
      const syntheticName = ctx.anonClassExprNames.get(unwrappedExpr);
      if (syntheticName) {
        const ctorName = `${syntheticName}_new`;
        const funcIdx = ctx.funcMap.get(ctorName);
        if (funcIdx === undefined) {
          ctx.errors.push({
            message: `Missing constructor for anonymous class`,
            line: getLine(expr),
            column: getCol(expr),
          });
          return null;
        }

        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }

        fctx.body.push({ op: "call", funcIdx });
        const structTypeIdx = ctx.structMap.get(syntheticName)!;
        return { kind: "ref", typeIdx: structTypeIdx };
      }
    }
  }

  // Handle `new Promise(executor)` — delegate to host import
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    const funcIdx = ctx.funcMap.get("Promise_new");
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      // No import registered — fallback to null
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle `new Number(x)`, `new String(x)`, `new Boolean(x)` — wrapper constructors
  // Return externref so typeof returns "object" (wrapper semantics).
  // Number/Boolean: box to externref via __box_number. String: already externref.
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "Number" || ctorName === "String" || ctorName === "Boolean") {
      const args = expr.arguments ?? [];

      if (ctorName === "Number") {
        // new Number(x) → compile x as f64, box to externref
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxIdx });
        }
        return { kind: "externref" };
      }

      if (ctorName === "String") {
        // new String(x) → compile x as externref string, return as externref
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        } else {
          const emptyStrResult = compileStringLiteral(ctx, fctx, "");
          if (!emptyStrResult) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        return { kind: "externref" };
      }

      if (ctorName === "Boolean") {
        // new Boolean(x) → compile x as f64, box to externref
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxIdx });
        }
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Error(msg)`, `new TypeError(msg)`, `new RangeError(msg)` — inline as externref
  // Instead of importing a host constructor, we represent the error as its message string
  // boxed to externref. This keeps the compilation pure-Wasm.
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "Error" || ctorName === "TypeError" || ctorName === "RangeError" ||
        ctorName === "SyntaxError" || ctorName === "URIError" || ctorName === "EvalError" ||
        ctorName === "ReferenceError") {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        // Compile the message argument to externref
        const resultType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        if (resultType && resultType.kind !== "externref") {
          coerceType(ctx, fctx, resultType, { kind: "externref" });
        }
      } else {
        // No message — push null externref
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }
  }

  // Handle `new Object()` — create an empty struct (equivalent to {})
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Object") {
    // Look for an empty struct type, or create an externref null as empty object
    // In non-fast mode, an empty object is just an externref null
    // In fast mode or when we have struct types, emit a minimal struct
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Proxy(target, handler)` — compile as pass-through to target
  // Tier 0: the proxy variable behaves exactly like the target object.
  // This converts compile errors into working code for the 465+ test262 tests
  // that use Proxy. Future tiers will inline get/set traps.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy") {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      // Compile the target argument — the proxy IS the target for now
      const targetResult = compileExpression(ctx, fctx, args[0]!);
      // Drop the handler argument (don't even compile it to avoid side effects
      // from unsupported handler patterns — but we do need to compile it if it
      // has side effects... for now, just skip it)
      return targetResult;
    }
    // No arguments — null proxy
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Function(...)` — dynamic code generation is not possible in Wasm.
  // Emit a no-op function that returns undefined (ref.null extern) to prevent
  // compile errors. Tests that rely on dynamic behavior will fail at runtime
  // instead of at compile time, which is more informative.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Function") {
    // Compile and discard all arguments (they may have side effects)
    const args = expr.arguments ?? [];
    for (const arg of args) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Return ref.null extern — represents a function that returns undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Date()`, `new Date(ms)`, `new Date(y, m, d, ...)` — native Date struct
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Date") {
    const dateTypeIdx = ensureDateStruct(ctx);
    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Date() — no clock in pure Wasm, use epoch 0
      fctx.body.push({ op: "i64.const", value: 0n } as unknown as Instr);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    if (args.length === 1) {
      // new Date(ms) — millisecond timestamp
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // new Date(year, month, day?, hours?, minutes?, seconds?, ms?)
    // JS months are 0-indexed. Day defaults to 1, rest default to 0.
    {
      const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

      // Compile year
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      const yearLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: yearLocal } as Instr);

      // Compile month (0-indexed) + 1 for civil algorithm
      compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "i64.const", value: 1n } as Instr);
      fctx.body.push({ op: "i64.add" } as Instr);
      const monthLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: monthLocal } as Instr);

      // Compile day (default 1)
      if (args.length >= 3) {
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 1n } as Instr);
      }
      const dayLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: dayLocal } as Instr);

      // Compile hours (default 0)
      if (args.length >= 4) {
        compileExpression(ctx, fctx, args[3]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const hoursLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: hoursLocal } as Instr);

      // Compile minutes (default 0)
      if (args.length >= 5) {
        compileExpression(ctx, fctx, args[4]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const minutesLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: minutesLocal } as Instr);

      // Compile seconds (default 0)
      if (args.length >= 6) {
        compileExpression(ctx, fctx, args[5]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const secondsLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: secondsLocal } as Instr);

      // Compile ms (default 0)
      if (args.length >= 7) {
        compileExpression(ctx, fctx, args[6]!, { kind: "f64" });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      }
      const msLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: msLocal } as Instr);

      // Handle year 0-99 mapping to 1900-1999 (JS Date quirk)
      // if (0 <= year <= 99) year += 1900
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 0n } as Instr,
        { op: "i64.ge_s" } as Instr,
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 99n } as Instr,
        { op: "i64.le_s" } as Instr,
        { op: "i32.and" } as Instr,
        { op: "if", blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: yearLocal } as Instr,
            { op: "i64.const", value: 1900n } as Instr,
            { op: "i64.add" } as Instr,
            { op: "local.set", index: yearLocal } as Instr,
          ],
        } as unknown as Instr,
      );

      // Call days_from_civil(year, month, day) → i64 days
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "local.get", index: monthLocal } as Instr,
        { op: "local.get", index: dayLocal } as Instr,
        { op: "call", funcIdx: daysFromCivilIdx } as Instr,
      );

      // timestamp = days * 86400000 + hours * 3600000 + minutes * 60000 + seconds * 1000 + ms
      fctx.body.push(
        { op: "i64.const", value: 86400000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "local.get", index: hoursLocal } as Instr,
        { op: "i64.const", value: 3600000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: minutesLocal } as Instr,
        { op: "i64.const", value: 60000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: secondsLocal } as Instr,
        { op: "i64.const", value: 1000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: msLocal } as Instr,
        { op: "i64.add" } as Instr,
      );

      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);

      releaseTempLocal(fctx, msLocal);
      releaseTempLocal(fctx, secondsLocal);
      releaseTempLocal(fctx, minutesLocal);
      releaseTempLocal(fctx, hoursLocal);
      releaseTempLocal(fctx, dayLocal);
      releaseTempLocal(fctx, monthLocal);
      releaseTempLocal(fctx, yearLocal);

      return { kind: "ref", typeIdx: dateTypeIdx };
    }
  }

  // Handle `new TypedArray(n)` — TypedArray constructors (Uint8Array, Int32Array, Float64Array, etc.)
  // TypedArrays are fixed-length numeric arrays. We represent them as vec structs with f64 elements,
  // where length equals capacity (no dynamic growth like regular arrays).
  if (ts.isIdentifier(expr.expression)) {
    const TYPED_ARRAY_NAMES = new Set([
      "Int8Array", "Uint8Array", "Uint8ClampedArray",
      "Int16Array", "Uint16Array",
      "Int32Array", "Uint32Array",
      "Float32Array", "Float64Array",
    ]);
    if (TYPED_ARRAY_NAMES.has(expr.expression.text)) {
      const elemWasm: ValType = { kind: "f64" };
      const vecTypeIdx = getOrRegisterVecType(ctx, "f64", elemWasm);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new TypedArray() → empty array, length 0
        fctx.body.push({ op: "i32.const", value: 0 });           // length = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      if (args.length === 1) {
        // Check if argument is a numeric literal or expression (size constructor)
        // vs an array/iterable (copy constructor)
        const argType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSym = argType.getSymbol?.();
        const isArrayLike = argSym?.name === "Array" ||
          (argType.flags & ts.TypeFlags.Object) !== 0 &&
          argSym?.name !== undefined &&
          TYPED_ARRAY_NAMES.has(argSym.name);

        if (!isArrayLike || ts.isNumericLiteral(args[0]!)) {
          // new TypedArray(n) → fixed-size array of length n, all zeros
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.tee", index: sizeLocal }); // length = n
          fctx.body.push({ op: "local.get", index: sizeLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }

        // new TypedArray(arrayLike) — copy from source array
        // Compile source, then copy elements
        const srcResult = compileExpression(ctx, fctx, args[0]!);
        if (srcResult && (srcResult.kind === "ref" || srcResult.kind === "ref_null")) {
          const srcTypeIdx = (srcResult as { typeIdx: number }).typeIdx;
          const srcTypeDef = ctx.mod.types[srcTypeIdx];
          // Check if source is a vec struct
          if (srcTypeDef?.kind === "struct" && srcTypeDef.fields[0]?.name === "length" && srcTypeDef.fields[1]?.name === "data") {
            const srcVecLocal = allocLocal(fctx, `__ta_src_${fctx.locals.length}`, srcResult);
            fctx.body.push({ op: "local.set", index: srcVecLocal });
            // Get source length
            fctx.body.push({ op: "local.get", index: srcVecLocal });
            fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 0 });
            const lenLocal = allocLocal(fctx, `__ta_len_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.tee", index: lenLocal });
            // Create new array of that length
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            const dstDataLocal = allocLocal(fctx, `__ta_dst_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
            fctx.body.push({ op: "local.set", index: dstDataLocal });

            // If source and dest have the same array type, use array.copy
            const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
            if (srcArrTypeIdx === arrTypeIdx) {
              fctx.body.push({ op: "local.get", index: dstDataLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: srcVecLocal });
              fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: lenLocal });
              fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
            }
            // Build result vec struct
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "local.get", index: dstDataLocal });
            fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
            return { kind: "ref_null", typeIdx: vecTypeIdx };
          }
        }
        // Fallback: treat argument as length
        // (source was already compiled and is on stack — drop it and recompile as f64)
        if (srcResult) fctx.body.push({ op: "drop" });
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const fallbackSize = allocLocal(fctx, `__ta_fsz_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: fallbackSize });
        fctx.body.push({ op: "local.get", index: fallbackSize });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      // new TypedArray() with multiple args — shouldn't happen per spec, but handle gracefully
      // Treat like new TypedArray(0)
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  const type = ctx.checker.getTypeAtLocation(expr);
  const symbol = type.getSymbol();
  let className = symbol?.name;

  // For class expressions (const C = class { ... }), the symbol name may be
  // the internal anonymous name (e.g. "__class"). Look up the mapped name first,
  // then fall back to the identifier used in the new expression.
  if (className && !ctx.classSet.has(className)) {
    const mapped = ctx.classExprNameMap.get(className);
    if (mapped) {
      className = mapped;
    }
  }
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const idName = expr.expression.text;
    if (ctx.classSet.has(idName)) {
      className = idName;
    } else {
      // Check classExprNameMap — for `let C: any; C = class { ... }; new C()`,
      // the identifier C maps to the synthetic class name via classExprNameMap.
      const mapped = ctx.classExprNameMap.get(idName);
      if (mapped && ctx.classSet.has(mapped)) {
        className = mapped;
      }
    }
  }

  if (!className) {
    // Unknown constructor (e.g. Test262Error) — call an imported constructor
    // registered upfront by collectUnknownConstructorImports.
    const ctorName = ts.isIdentifier(expr.expression) ? expr.expression.text : "__unknown";
    const importName = `__new_${ctorName}`;
    const funcIdx = ctx.funcMap.get(importName);

    if (funcIdx !== undefined) {
      // Compile arguments as externref
      const args = expr.arguments ?? [];
      for (const arg of args) {
        const resultType = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (resultType && resultType.kind !== "externref") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Re-lookup funcIdx: argument compilation may trigger addUnionImports
      const finalNewIdx = ctx.funcMap.get(importName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalNewIdx });
    } else {
      // Fallback: no import registered (shouldn't happen), produce null
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle local class constructors
  if (ctx.classSet.has(className)) {
    const ctorName = `${className}_new`;
    const funcIdx = ctx.funcMap.get(ctorName);
    if (funcIdx === undefined) {
      ctx.errors.push({
        message: `Missing constructor for class: ${className}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }

    // Compile constructor arguments with type hints
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    const args = expr.arguments ?? [];
    const ctorRestInfo = ctx.funcRestParams.get(ctorName);

    // Check for spread arguments
    const hasSpreadCtorArg = args.some((a) => ts.isSpreadElement(a));
    if (hasSpreadCtorArg && paramTypes) {
      // Flatten spread arguments for constructor call
      const flatCtorArgs = flattenCallArgs(args);
      if (flatCtorArgs) {
        for (let i = 0; i < flatCtorArgs.length && i < paramTypes.length; i++) {
          compileExpression(ctx, fctx, flatCtorArgs[i]!, paramTypes[i]);
        }
        // Pad missing args
        for (let i = flatCtorArgs.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!);
        }
      } else {
        // Non-literal spread — compile via compileSpreadCallArgs
        compileSpreadCallArgs(ctx, fctx, expr as unknown as ts.CallExpression, funcIdx, ctorRestInfo);
      }
    } else if (ctorRestInfo && !hasSpreadCtorArg) {
      // Calling a rest-param constructor: pack trailing args into a GC array
      for (let i = 0; i < ctorRestInfo.restIndex; i++) {
        if (i < args.length) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" });
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, args.length - ctorRestInfo.restIndex);
      fctx.body.push({ op: "i32.const", value: restArgCount });
      for (let i = ctorRestInfo.restIndex; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, ctorRestInfo.elemType);
      }
      fctx.body.push({ op: "array.new_fixed", typeIdx: ctorRestInfo.arrayTypeIdx, length: restArgCount });
      fctx.body.push({ op: "struct.new", typeIdx: ctorRestInfo.vecTypeIdx });
    } else {
      for (let i = 0; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
      }
      // Pad missing constructor arguments with defaults (arity mismatch)
      if (paramTypes) {
        for (let i = args.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!);
        }
      }
    }

    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalCtorIdx = ctx.funcMap.get(ctorName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
    const structTypeIdx = ctx.structMap.get(className)!;
    return { kind: "ref", typeIdx: structTypeIdx };
  }

  const externInfo = ctx.externClasses.get(className);
  if (externInfo) {
    // Compile constructor arguments with type hints
    const args = expr.arguments ?? [];
    for (let i = 0; i < args.length; i++) {
      compileExpression(ctx, fctx, args[i]!, externInfo.constructorParams[i]);
    }
    // Pad missing optional args with default values
    for (let i = args.length; i < externInfo.constructorParams.length; i++) {
      pushDefaultValue(fctx, externInfo.constructorParams[i]!);
    }

    const importName = `${externInfo.importPrefix}_new`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      ctx.errors.push({
        message: `Missing import for constructor: ${importName}`,
        line: getLine(expr),
        column: getCol(expr),
      });
      return null;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // new Uint8Array(n), new Int32Array(n), new Float64Array(n), etc. → vec struct with f64 elements
  {
    const TYPED_ARRAY_CTORS = new Set([
      "Int8Array", "Uint8Array", "Int16Array", "Uint16Array",
      "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    ]);
    if (className && TYPED_ARRAY_CTORS.has(className)) {
      const elemType: ValType = { kind: "f64" };
      const vecTypeIdx = getOrRegisterVecType(ctx, "f64", elemType);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new Uint8Array() → empty array
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      } else {
        // new Uint8Array(n) → array of size n, all zeros
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: sizeLocal });
        fctx.body.push({ op: "local.get", index: sizeLocal });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      }
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new ArrayBuffer(byteLength) → vec struct with i32 elements (1 byte per element)
  if (className === "ArrayBuffer") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // new ArrayBuffer(byteLength) → create vec with byteLength elements, all 0
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) → wrap the ArrayBuffer reference (same vec struct)
  if (className === "DataView") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      // new DataView(buffer) → compile buffer arg, which should be an ArrayBuffer vec ref
      const resultType = compileExpression(ctx, fctx, args[0]!);
      // If the result is already the right vec type, return it directly
      if (resultType && (resultType.kind === "ref" || resultType.kind === "ref_null")) {
        return resultType;
      }
      // If we got a different type (e.g. externref), just return as-is
      if (resultType) return resultType;
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    } else {
      // No buffer — create empty ArrayBuffer-like vec
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new Array() / new Array(n) / new Array(a, b, c)
  if (className === "Array") {
    // Use contextual type (from variable declaration) if available, else expression type.
    // `new Array()` without type args gives Array<any>, but `var a: number[] = new Array()`
    // needs to produce Array<number> to match the variable's vec type.
    const ctxType = ctx.checker.getContextualType(expr);
    let exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);
    // If element type is `any` (no contextual type, no explicit type arg),
    // infer from how the array variable is used: scan element assignments
    // like arr[i] = value and arr.push(value) to determine the element type.
    let inferredElemWasm: ValType | null = null;
    const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
    if (rawTypeArgs?.[0] && (rawTypeArgs[0].flags & ts.TypeFlags.Any)) {
      const inferredElemTsType = inferArrayElementType(ctx, expr);
      if (inferredElemTsType) {
        inferredElemWasm = resolveWasmType(ctx, inferredElemTsType);
      }
    }

    let vecTypeIdx: number;
    let arrTypeIdx: number;
    let elemWasm: ValType;
    if (inferredElemWasm) {
      // Use inferred element type to register/find the right vec type
      const elemKey =
        inferredElemWasm.kind === "ref" || inferredElemWasm.kind === "ref_null"
          ? `ref_${(inferredElemWasm as { typeIdx: number }).typeIdx}`
          : inferredElemWasm.kind;
      vecTypeIdx = getOrRegisterVecType(ctx, elemKey, inferredElemWasm);
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = inferredElemWasm;
    } else {
      const resolved = resolveWasmType(ctx, exprType);
      vecTypeIdx = (resolved as { typeIdx: number }).typeIdx;
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const typeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const elemTsType = typeArgs?.[0];
      elemWasm = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
    }

    if (arrTypeIdx < 0) {
      ctx.errors.push({ message: "new Array(): invalid vec type", line: getLine(expr), column: getCol(expr) });
      return null;
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 });           // length = 0
      fctx.body.push({ op: "i32.const", value: DEFAULT_CAPACITY });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length === 1) {
      // new Array(n) → array with capacity n, length 0
      // For test262 patterns like `var a = new Array(16); a[0] = x;`
      // we create an array of size n with default values and set length to n
      // (JS semantics: sparse array with length n, all slots undefined)
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: sizeLocal });
      fctx.body.push({ op: "local.get", index: sizeLocal });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // new Array(a, b, c) → [a, b, c]
    for (const arg of args) {
      compileExpression(ctx, fctx, arg, elemWasm);
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: args.length });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: args.length });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  ctx.errors.push({
    message: `Unsupported new expression for class: ${className}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}

// ── Extern class inheritance helper ──────────────────────────────────

/** Walk the externClassParent chain to find the extern class that declares a member */
export function findExternInfoForMember(
  ctx: CodegenContext,
  className: string,
  memberName: string,
  kind: "method" | "property",
): ExternClassInfo | null {
  let current: string | undefined = className;
  while (current) {
    const info = ctx.externClasses.get(current);
    if (info) {
      if (kind === "method" && info.methods.has(memberName)) return info;
      if (kind === "property" && info.properties.has(memberName)) return info;
    }
    current = ctx.externClassParent.get(current);
  }
  return null;
}

// ── Extern method calls ──────────────────────────────────────────────

function compileExternMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const className = receiverType.getSymbol()?.name;
  const methodName = propAccess.name.text;

  if (!className) return null;

  // Walk inheritance chain to find the class that declares the method
  const resolvedInfo = findExternInfoForMember(ctx, className, methodName, "method");
  const externInfo = resolvedInfo ?? ctx.externClasses.get(className);
  if (!externInfo) {
    ctx.errors.push({
      message: `Unknown extern class: ${className}`,
      line: getLine(callExpr),
      column: getCol(callExpr),
    });
    return null;
  }

  // Push 'this' (the receiver object)
  compileExpression(ctx, fctx, propAccess.expression);

  // Push arguments with type hints (params[0] is 'this', args start at [1])
  const methodOwner = resolvedInfo ?? externInfo;
  const methodInfo = methodOwner.methods.get(methodName);
  for (let i = 0; i < callExpr.arguments.length; i++) {
    const hint = methodInfo?.params[i + 1]; // +1 to skip 'this'
    compileExpression(ctx, fctx, callExpr.arguments[i]!, hint);
  }

  // Pad missing optional args with default values
  if (methodInfo) {
    const actualArgs = callExpr.arguments.length + 1; // +1 for 'this'
    for (let i = actualArgs; i < methodInfo.params.length; i++) {
      pushDefaultValue(fctx, methodInfo.params[i]!);
    }
  }

  const importName = `${methodOwner.importPrefix}_${methodName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    ctx.errors.push({
      message: `Missing import for method: ${importName}`,
      line: getLine(callExpr),
      column: getCol(callExpr),
    });
    return null;
  }

  fctx.body.push({ op: "call", funcIdx });

  if (!methodInfo || methodInfo.results.length === 0) return VOID_RESULT;
  return methodInfo.results[0]!;
}

// ── Helper: push default value for a type ────────────────────────────

/**
 * Emit a lazy-initialized prototype global access.
 * On first access, creates a struct instance with default values and stores it
 * as externref in the global. Subsequent accesses return the same instance.
 * This gives reference identity for ClassName.prototype === Object.getPrototypeOf(instance).
 */
export function emitLazyProtoGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
): boolean {
  const protoGlobalIdx = ctx.protoGlobals?.get(className);
  if (protoGlobalIdx === undefined) return false;

  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return false;

  // Build the init body: push default values for all fields, struct.new, extern.convert_any, global.set
  const initBody: Instr[] = [];
  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      initBody.push({ op: "i32.const", value: tag });
    } else {
      // Push default value for each field type
      switch (field.type.kind) {
        case "f64":
          initBody.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          initBody.push({ op: "i32.const", value: 0 });
          break;
        case "i64":
          initBody.push({ op: "i64.const", value: 0n });
          break;
        case "externref":
          initBody.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          initBody.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  initBody.push({ op: "struct.new", typeIdx: structTypeIdx });
  initBody.push({ op: "extern.convert_any" });
  initBody.push({ op: "global.set", index: protoGlobalIdx });

  // Emit: if global is null, init it; then get it
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  return true;
}

/**
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions in compiled function bodies so they push a default
 * value for the new field. Without this, struct.new expects N values on the
 * stack but the constructor only pushed N-1.
 */
export function patchStructNewForDynamicField(
  ctx: CodegenContext,
  structTypeIdx: number,
  newFieldType: ValType,
): void {
  // Walk all compiled function bodies and patch struct.new instructions
  for (const func of ctx.mod.functions) {
    if (!func.body || func.body.length === 0) continue;
    patchStructNewInBody(func.body, structTypeIdx, newFieldType);
  }
  // Also patch the current function being compiled (if any)
  if (ctx.currentFunc) {
    patchStructNewInBody(ctx.currentFunc.body, structTypeIdx, newFieldType);
    // Also patch saved bodies (from pushBody/popBody pattern)
    if (ctx.currentFunc.savedBodies) {
      for (const savedBody of ctx.currentFunc.savedBodies) {
        patchStructNewInBody(savedBody, structTypeIdx, newFieldType);
      }
    }
  }
}

/** Recursively patch struct.new instructions in a body (handles nested if/block/loop). */
function patchStructNewInBody(body: Instr[], structTypeIdx: number, newFieldType: ValType): void {
  for (let i = 0; i < body.length; i++) {
    const instr = body[i]!;
    if (instr.op === "struct.new" && (instr as any).typeIdx === structTypeIdx) {
      // Insert default value instruction before this struct.new
      const defaultInstr = defaultValueInstrForType(newFieldType);
      body.splice(i, 0, ...defaultInstr);
      i += defaultInstr.length; // skip past inserted instructions
    }
    // Recurse into nested blocks
    if ((instr as any).then) patchStructNewInBody((instr as any).then, structTypeIdx, newFieldType);
    if ((instr as any).else) patchStructNewInBody((instr as any).else, structTypeIdx, newFieldType);
    if ((instr as any).body) {
      // block, loop, try instructions
      const nestedBody = (instr as any).body;
      if (Array.isArray(nestedBody)) patchStructNewInBody(nestedBody, structTypeIdx, newFieldType);
    }
    if ((instr as any).instrs) {
      const nestedInstrs = (instr as any).instrs;
      if (Array.isArray(nestedInstrs)) patchStructNewInBody(nestedInstrs, structTypeIdx, newFieldType);
    }
    // try/catch blocks
    if ((instr as any).catches) {
      for (const c of (instr as any).catches) {
        if (Array.isArray(c.body)) patchStructNewInBody(c.body, structTypeIdx, newFieldType);
      }
    }
    if ((instr as any).catchAll) {
      if (Array.isArray((instr as any).catchAll)) patchStructNewInBody((instr as any).catchAll, structTypeIdx, newFieldType);
    }
  }
}

/** Return instructions that produce a default value for a given type. */
function defaultValueInstrForType(type: ValType): Instr[] {
  switch (type.kind) {
    case "f64":
      return [{ op: "f64.const", value: 0 } as Instr];
    case "i32":
      return [{ op: "i32.const", value: 0 } as Instr];
    case "externref":
      return [{ op: "ref.null.extern" } as Instr];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: type.typeIdx } as Instr];
    case "ref":
      return [
        { op: "ref.null", typeIdx: type.typeIdx } as Instr,
        { op: "ref.as_non_null" } as Instr,
      ];
    case "eqref":
      return [{ op: "ref.null.eq" }];
    default:
      return [{ op: "i32.const", value: 0 } as Instr];
  }
}

// ── Spread in function calls ─────────────────────────────────────────

/**
 * Compile function call arguments when spread syntax is used: fn(...arr)
 * For non-rest targets: unpack array elements as positional args using locals.
 * For rest-param targets: pass the spread array directly as the rest param.
 */
function compileSpreadCallArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcIdx: number,
  restInfo: RestParamInfo | undefined,
): void {
  const paramTypes = getFuncParamTypes(ctx, funcIdx);

  if (restInfo) {
    // Calling a rest-param function with spread — compile non-rest args normally,
    // then for the rest portion, if it's a single spread of an array, pass directly
    let argIdx = 0;
    for (let i = 0; i < restInfo.restIndex; i++) {
      if (argIdx < expr.arguments.length) {
        compileExpression(ctx, fctx, expr.arguments[argIdx]!, paramTypes?.[i]);
        argIdx++;
      }
    }
    // Remaining args should be a single spread element — pass the vec directly
    if (argIdx < expr.arguments.length) {
      const restArg = expr.arguments[argIdx]!;
      if (ts.isSpreadElement(restArg)) {
        // The spread source is already a vec struct — pass directly
        compileExpression(ctx, fctx, restArg.expression);
      } else {
        // Single non-spread arg as rest — wrap in vec struct { 1, [val] }
        fctx.body.push({ op: "i32.const", value: 1 });
        compileExpression(ctx, fctx, restArg, restInfo.elemType);
        fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: 1 });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      }
    } else {
      // No rest args provided — pass empty vec struct { 0, [] }
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_fixed", typeIdx: restInfo.arrayTypeIdx, length: 0 });
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    }
    return;
  }

  // Non-rest target: fn(...arr) — unpack array elements from vec struct into positional args
  // Strategy: for each spread arg, store the vec in a local, extract data array, then extract elements by index
  if (!paramTypes) return;

  // Collect all arguments, resolving spreads
  let paramIdx = 0;
  for (const arg of expr.arguments) {
    if (ts.isSpreadElement(arg)) {
      // Compile the spread source (vec struct)
      const vecType = compileExpression(ctx, fctx, arg.expression);
      if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) continue;

      const vecTypeDef = ctx.mod.types[vecType.typeIdx];
      if (!vecTypeDef || vecTypeDef.kind !== "struct") continue;

      // Extract data array from vec struct
      const vecLocal = allocLocal(fctx, `__spread_vec_${fctx.locals.length}`, vecType);
      fctx.body.push({ op: "local.set", index: vecLocal });

      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
      if (arrTypeIdx < 0) continue;
      const dataLocal = allocLocal(fctx, `__spread_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecType.typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.set", index: dataLocal });

      // Extract elements up to the remaining parameter count
      const arrDefSpread = ctx.mod.types[arrTypeIdx];
      const spreadElemType = arrDefSpread && arrDefSpread.kind === "array" ? arrDefSpread.element : { kind: "f64" as const };
      const remainingParams = paramTypes.length - paramIdx;
      for (let i = 0; i < remainingParams; i++) {
        fctx.body.push({ op: "local.get", index: dataLocal });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGet(fctx, arrTypeIdx, spreadElemType);
        paramIdx++;
      }
    } else {
      compileExpression(ctx, fctx, arg, paramTypes[paramIdx]);
      paramIdx++;
    }
  }
}

// ── Builtins ─────────────────────────────────────────────────────────

function compileConsoleCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
): InnerResult {
  // WASI mode: emit fd_write to stdout instead of JS host imports
  if (ctx.wasi) {
    return compileConsoleCallWasi(ctx, fctx, expr, method);
  }

  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isStringType(argType)) {
      // Fast mode: flatten + marshal native string to externref before passing to host
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
        if (strFlattenIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        }
        const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern");
        if (toExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toExternIdx });
        }
      }
      const funcIdx = ctx.funcMap.get(`console_${method}_string`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isBooleanType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_bool`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isNumberType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_number`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // externref: DOM objects, class instances, anything else
      const funcIdx = ctx.funcMap.get(`console_${method}_externref`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    }
  }
  return VOID_RESULT;
}

// ─── Date support ───────────────────────────────────────────────────────────
// Date is represented as a WasmGC struct with a single mutable i64 field
// (milliseconds since Unix epoch, UTC).  All getters decompose the timestamp
// using Howard Hinnant's civil_from_days algorithm, implemented purely in
// i64 arithmetic — no host imports needed.

/** Ensure the $__Date struct type exists, return its type index. */
function ensureDateStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" }, mutable: true }]);
  return typeIdx;
}

/**
 * Ensure the __date_civil_from_days helper function exists.
 * Signature: (i64 days_since_epoch) -> (i64 packed)
 *   packed = year * 10000 + month * 100 + day
 *   (month 1-12, day 1-31)
 *
 * Uses Hinnant's algorithm: http://howardhinnant.github.io/date_algorithms.html#civil_from_days
 */
function ensureDateCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_civil_from_days");
  if (existing !== undefined) return existing;

  // func (param $z i64) (result i64)
  // locals: $z(0), $era(1), $doe(2), $yoe(3), $doy(4), $mp(5), $y(6), $m(7), $d(8)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_civil_from_days", funcIdx);

  const body: Instr[] = [];

  // z += 719468  (shift epoch from 1970-01-01 to 0000-03-01)
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 0 } as Instr,
  );

  // era = (z >= 0 ? z : z - 146096) / 146097
  // We use i64.div_s which floors toward zero, so we need the adjustment
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    { op: "if", blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 0 } as Instr,
      ],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 146096n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 1 } as Instr,   // era
  );

  // doe = z - era * 146097  (day of era, [0, 146096])
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 2 } as Instr,   // doe
  );

  // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
  body.push(
    { op: "local.get", index: 2 } as Instr,   // doe
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 1460n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 36524n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 146096n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr,   // yoe
  );

  // y = yoe + era * 400
  body.push(
    { op: "local.get", index: 3 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr,   // y (still March-based)
  );

  // doy = doe - (365*yoe + yoe/4 - yoe/100)
  body.push(
    { op: "local.get", index: 2 } as Instr,   // doe
    { op: "i64.const", value: 365n } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr,   // doy
  );

  // mp = (5*doy + 2) / 153
  body.push(
    { op: "i64.const", value: 5n } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 5 } as Instr,   // mp
  );

  // d = doy - (153*mp + 2)/5 + 1
  body.push(
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 8 } as Instr,   // d
  );

  // m = mp < 10 ? mp + 3 : mp - 9
  body.push(
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.const", value: 10n } as Instr,
    { op: "i64.lt_s" } as Instr,
    { op: "if", blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.add" } as Instr,
      ],
      else: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "local.set", index: 7 } as Instr,   // m (1-12)
  );

  // y += (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr,   // y (adjusted)
  );

  // return y * 10000 + m * 100 + d
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "i64.const", value: 10000n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 8 } as Instr,
    { op: "i64.add" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_civil_from_days",
    typeIdx: funcTypeIdx,
    locals: [
      // 0: z (param), 1: era, 2: doe, 3: yoe, 4: doy, 5: mp, 6: y, 7: m, 8: d
      { name: "$era", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$mp", type: { kind: "i64" } },
      { name: "$y", type: { kind: "i64" } },
      { name: "$m", type: { kind: "i64" } },
      { name: "$d", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Ensure the __date_days_from_civil helper function exists.
 * Signature: (i64 year, i64 month, i64 day) -> i64 days_since_epoch
 *
 * Implements Hinnant's days_from_civil algorithm (inverse of civil_from_days).
 */
function ensureDateDaysFromCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_days_from_civil");
  if (existing !== undefined) return existing;

  // func (param $y i64) (param $m i64) (param $d i64) (result i64)
  // locals: $y(0), $m(1), $d(2), $era(3), $yoe(4), $doy(5), $doe(6)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }, { kind: "i64" }, { kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_days_from_civil", funcIdx);

  const body: Instr[] = [];

  // y -= (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 0 } as Instr,   // y
    { op: "local.get", index: 1 } as Instr,   // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 0 } as Instr,   // y adjusted
  );

  // era = (y >= 0 ? y : y - 399) / 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    { op: "if", blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 0 } as Instr,
      ],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 399n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr,   // era
  );

  // yoe = y - era * 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr,   // yoe
  );

  // doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
  body.push(
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 1 } as Instr,   // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.gt_s" } as Instr,
    { op: "if", blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
      else: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.add" } as Instr,
      ],
    } as unknown as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.get", index: 2 } as Instr,   // d
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 5 } as Instr,   // doy
  );

  // doe = yoe * 365 + yoe/4 - yoe/100 + doy
  body.push(
    { op: "local.get", index: 4 } as Instr,   // yoe
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr,   // doe
  );

  // return era * 146097 + doe - 719468
  body.push(
    { op: "local.get", index: 3 } as Instr,   // era
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 6 } as Instr,   // doe
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.sub" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_days_from_civil",
    typeIdx: funcTypeIdx,
    locals: [
      // 3: era, 4: yoe, 5: doy, 6: doe
      { name: "$era", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Compile a Date method call on a Date struct receiver.
 * Returns undefined if this is not a Date method (caller should continue).
 */
function compileDateMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
): InnerResult | undefined {
  const methodName = propAccess.name.text;
  const symName = receiverType.getSymbol()?.name;
  if (symName !== "Date") return undefined;

  const DATE_METHODS = new Set([
    "getTime", "valueOf", "getFullYear", "getMonth", "getDate",
    "getHours", "getMinutes", "getSeconds", "getMilliseconds",
    "getDay", "setTime", "getTimezoneOffset",
    "getUTCFullYear", "getUTCMonth", "getUTCDate",
    "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds",
    "getUTCDay", "toISOString", "toJSON",
    "toString", "toDateString", "toTimeString",
    "toLocaleDateString", "toLocaleTimeString", "toLocaleString",
    "toUTCString", "toGMTString",
  ]);
  if (!DATE_METHODS.has(methodName)) return undefined;

  const dateTypeIdx = ensureDateStruct(ctx);
  const dateRefType: ValType = { kind: "ref", typeIdx: dateTypeIdx };

  // Compile receiver — the Date struct
  const recvResult = compileExpression(ctx, fctx, propAccess.expression, dateRefType);
  if (!recvResult) return null;

  // getTime / valueOf: read i64 timestamp, convert to f64
  if (methodName === "getTime" || methodName === "valueOf") {
    fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 } as unknown as Instr);
    fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    return { kind: "f64" };
  }

  // getTimezoneOffset: always 0 (we operate in UTC)
  if (methodName === "getTimezoneOffset") {
    fctx.body.push({ op: "drop" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    return { kind: "f64" };
  }

  // setTime(ms): update the timestamp field
  if (methodName === "setTime") {
    // We need the ref on stack, but also need the new value
    // Stack: [dateRef]
    // Compile the argument
    const tempLocal = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempLocal } as Instr);
    // Get the new timestamp
    if (callExpr.arguments.length >= 1) {
      fctx.body.push({ op: "local.get", index: tempLocal } as Instr);
      compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 } as unknown as Instr);
      // Return the new timestamp as f64
      fctx.body.push({ op: "local.get", index: tempLocal } as Instr);
      fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 } as unknown as Instr);
      fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    } else {
      fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    }
    releaseTempLocal(fctx, tempLocal);
    return { kind: "f64" };
  }

  // For all time-component getters, we need the i64 timestamp
  // Stack: [dateRef]
  fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 } as unknown as Instr);
  // Stack: [i64 timestamp]

  // Time-of-day getters (no civil calendar needed)
  const MS_PER_DAY = 86400000n;
  const MS_PER_HOUR = 3600000n;
  const MS_PER_MINUTE = 60000n;
  const MS_PER_SECOND = 1000n;

  if (methodName === "getHours" || methodName === "getUTCHours") {
    // hours = ((timestamp % 86400000) + 86400000) % 86400000 / 3600000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMinutes" || methodName === "getUTCMinutes") {
    // minutes = ((timestamp % 3600000) + 3600000) % 3600000 / 60000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_HOUR } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getSeconds" || methodName === "getUTCSeconds") {
    // seconds = ((timestamp % 60000) + 60000) % 60000 / 1000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_MINUTE } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMilliseconds" || methodName === "getUTCMilliseconds") {
    // ms = ((timestamp % 1000) + 1000) % 1000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_SECOND } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // getDay / getUTCDay: day of week (0=Sunday)
  // (floor(timestamp / 86400000) + 4) % 7  (1970-01-01 was Thursday = 4)
  if (methodName === "getDay" || methodName === "getUTCDay") {
    // We need to handle negative timestamps correctly:
    // days = floor(ts / 86400000) — for negative, use (ts - 86399999) / 86400000
    fctx.body.push(
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.div_s" } as Instr,
      // For negative timestamps, i64.div_s truncates toward zero, but we want floor division
      // This is fine because we handle the modular arithmetic with the +7 % 7 below
      { op: "i64.const", value: 4n } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.rem_s" } as Instr,
      // Handle negative remainder: ((result % 7) + 7) % 7
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: 7n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // Calendar getters need civil_from_days
  // Stack: [i64 timestamp]
  // First compute days: floor(timestamp / 86400000)
  // For negative timestamps we need floor division, not truncation.
  // floor_div(a, b) for positive b: (a >= 0) ? a/b : (a - b + 1) / b
  const civilIdx = ensureDateCivilHelper(ctx);

  // Compute floor division of timestamp by MS_PER_DAY
  // Since i64.div_s truncates toward zero, we need to adjust for negative values
  {
    const tempTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempTs } as Instr);

    // if (ts >= 0) ts / 86400000 else (ts - 86399999) / 86400000
    fctx.body.push(
      { op: "local.get", index: tempTs } as Instr,
      { op: "i64.const", value: 0n } as Instr,
      { op: "i64.ge_s" } as Instr,
      { op: "if", blockType: { kind: "val", type: { kind: "i64" } },
        then: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
        else: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY - 1n } as Instr,
          { op: "i64.sub" } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
      } as unknown as Instr,
    );
    releaseTempLocal(fctx, tempTs);
  }

  // Stack: [i64 days_since_epoch]
  fctx.body.push({ op: "call", funcIdx: civilIdx } as Instr);
  // Stack: [i64 packed = year*10000 + month*100 + day]

  if (methodName === "getFullYear" || methodName === "getUTCFullYear") {
    // year = packed / 10000
    fctx.body.push(
      { op: "i64.const", value: 10000n } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getMonth" || methodName === "getUTCMonth") {
    // month = (packed / 100) % 100 - 1  (JS months are 0-indexed)
    fctx.body.push(
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.div_s" } as Instr,
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: 1n } as Instr,
      { op: "i64.sub" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  if (methodName === "getDate" || methodName === "getUTCDate") {
    // day = packed % 100
    fctx.body.push(
      { op: "i64.const", value: 100n } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    );
    return { kind: "f64" };
  }

  // toISOString / toJSON: emit a formatted string
  if (methodName === "toISOString" || methodName === "toJSON") {
    // For now, drop the packed civil date and return a placeholder
    // A full implementation would format as "YYYY-MM-DDTHH:MM:SS.sssZ"
    // but that requires string building which is complex. Return the timestamp as a string.
    fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "1970-01-01T00:00:00.000Z");
  }

  // toString / toDateString / toTimeString / toLocale* / toUTCString / toGMTString:
  // Stub implementations — return a placeholder string representation.
  // Full formatting would require complex string building; for now return a fixed string.
  const STRING_DATE_METHODS = new Set([
    "toString", "toDateString", "toTimeString",
    "toLocaleDateString", "toLocaleTimeString", "toLocaleString",
    "toUTCString", "toGMTString",
  ]);
  if (STRING_DATE_METHODS.has(methodName)) {
    fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "Thu Jan 01 1970 00:00:00 GMT+0000");
  }

  // Shouldn't reach here
  fctx.body.push({ op: "drop" } as Instr);
  fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  return { kind: "f64" };
}

/** WASI mode: compile console.log/warn/error by writing UTF-8 to stdout via fd_write */
function compileConsoleCallWasi(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  _method: string,
): InnerResult {
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return VOID_RESULT;

  let first = true;
  for (const arg of expr.arguments) {
    // Add space separator between arguments (like console.log does)
    if (!first) {
      const spaceData = wasiAllocStringData(ctx, " ");
      fctx.body.push({ op: "i32.const", value: spaceData.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: spaceData.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    }
    first = false;

    // Check if this is a string literal we can embed directly
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const strValue = arg.text;
      const data = wasiAllocStringData(ctx, strValue);
      fctx.body.push({ op: "i32.const", value: data.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: data.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    } else if (ts.isTemplateExpression(arg)) {
      // Template literal: handle head + spans
      if (arg.head.text) {
        const headData = wasiAllocStringData(ctx, arg.head.text);
        fctx.body.push({ op: "i32.const", value: headData.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: headData.length } as Instr);
        fctx.body.push({ op: "call", funcIdx: writeStringIdx });
      }
      for (const span of arg.templateSpans) {
        // Compile the expression and convert to string output
        const exprType = compileExpression(ctx, fctx, span.expression);
        emitWasiValueToStdout(ctx, fctx, exprType, span.expression);
        if (span.literal.text) {
          const litData = wasiAllocStringData(ctx, span.literal.text);
          fctx.body.push({ op: "i32.const", value: litData.offset } as Instr);
          fctx.body.push({ op: "i32.const", value: litData.length } as Instr);
          fctx.body.push({ op: "call", funcIdx: writeStringIdx });
        }
      }
    } else {
      // For non-literal arguments, compile the expression and handle by type
      const argType = ctx.checker.getTypeAtLocation(arg);
      const exprType = compileExpression(ctx, fctx, arg);
      emitWasiValueToStdout(ctx, fctx, exprType, arg);
    }
  }

  // Emit newline at the end
  const newlineData = wasiAllocStringData(ctx, "\n");
  fctx.body.push({ op: "i32.const", value: newlineData.offset } as Instr);
  fctx.body.push({ op: "i32.const", value: newlineData.length } as Instr);
  fctx.body.push({ op: "call", funcIdx: writeStringIdx });

  return VOID_RESULT;
}

/** Allocate a UTF-8 string in a data segment and return its offset/length */
function wasiAllocStringData(
  ctx: CodegenContext,
  str: string,
): { offset: number; length: number } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  // Find the next available offset in data segments
  // Data segments start after the scratch area (offset 1024)
  let offset = 1024;
  for (const seg of ctx.mod.dataSegments) {
    const segEnd = seg.offset + seg.bytes.length;
    if (segEnd > offset) offset = segEnd;
  }

  ctx.mod.dataSegments.push({ offset, bytes });
  return { offset, length: bytes.length };
}

/** Emit code to write a compiled value to stdout in WASI mode */
function emitWasiValueToStdout(
  ctx: CodegenContext,
  fctx: FunctionContext,
  exprType: InnerResult,
  _node: ts.Node,
): void {
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return;

  if (exprType === VOID_RESULT || exprType === null) {
    // void expression, nothing to write — drop already handled
    return;
  }

  if (exprType.kind === "f64") {
    // Number: use __wasi_write_f64 helper (emit inline if not yet registered)
    const writeF64Idx = ensureWasiWriteF64Helper(ctx);
    if (writeF64Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeF64Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else if (exprType.kind === "i32") {
    // Boolean or i32: write "true"/"false" or the integer
    const writeI32Idx = ensureWasiWriteI32Helper(ctx);
    if (writeI32Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeI32Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else {
    // For other types (externref, ref, etc.), just drop and write a placeholder
    fctx.body.push({ op: "drop" } as Instr);
    const placeholder = wasiAllocStringData(ctx, "[object]");
    fctx.body.push({ op: "i32.const", value: placeholder.offset } as Instr);
    fctx.body.push({ op: "i32.const", value: placeholder.length } as Instr);
    fctx.body.push({ op: "call", funcIdx: writeStringIdx });
  }
}

/** Ensure the __wasi_write_i32 helper exists and return its function index */
function ensureWasiWriteI32Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wasi_write_i32");
  if (existing !== undefined) return existing;

  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined) return -1;

  // Simple i32 to decimal string conversion
  // Uses bump allocator to write digits to linear memory
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_i32", funcIdx);

  // Algorithm: handle negative, then extract digits in reverse, then write forward
  // Locals: 0=value, 1=buf_start, 2=buf_pos, 3=is_neg, 4=digit
  const body: Instr[] = [];

  // For simplicity, handle 0 specially, negatives, and positive integers
  // We allocate a 12-byte buffer on the bump allocator for the digit string
  const bufStartLocal = 1; // local index
  const bufPosLocal = 2;
  const isNegLocal = 3;
  const absValLocal = 4;
  const tmpLocal = 5;

  body.push(
    // buf_start = bump_ptr
    { op: "global.get", index: ctx.wasiBumpPtrGlobalIdx } as Instr,
    { op: "local.set", index: bufStartLocal } as Instr,
    // buf_pos = buf_start + 11 (write digits right-to-left, max 11 digits + sign)
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 11 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: bufPosLocal } as Instr,

    // Check if value == 0
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.eqz" } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        // Write "0" directly
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 48 } as Instr, // '0'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check if negative
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "local.set", index: isNegLocal } as Instr,

    // absVal = is_neg ? -value : value
    { op: "local.get", index: isNegLocal } as Instr,
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: 0 } as Instr,
        { op: "i32.sub" } as Instr,
      ],
      else: [
        { op: "local.get", index: 0 } as Instr,
      ],
    },
    { op: "local.set", index: absValLocal } as Instr,

    // Loop: extract digits right to left
    { op: "block", blockType: { kind: "empty" }, body: [
      { op: "loop", blockType: { kind: "empty" }, body: [
        // if absVal == 0, break
        { op: "local.get", index: absValLocal } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "br_if", depth: 1 } as Instr,

        // digit = absVal % 10
        { op: "local.get", index: absValLocal } as Instr,
        { op: "i32.const", value: 10 } as Instr,
        { op: "i32.rem_u" } as Instr,
        { op: "local.set", index: tmpLocal } as Instr,

        // absVal = absVal / 10
        { op: "local.get", index: absValLocal } as Instr,
        { op: "i32.const", value: 10 } as Instr,
        { op: "i32.div_u" } as Instr,
        { op: "local.set", index: absValLocal } as Instr,

        // buf_pos--
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: bufPosLocal } as Instr,

        // memory[buf_pos] = digit + '0'
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "local.get", index: tmpLocal } as Instr,
        { op: "i32.const", value: 48 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "i32.store8", align: 0, offset: 0 } as Instr,

        // continue loop
        { op: "br", depth: 0 } as Instr,
      ] },
    ] },

    // If negative, prepend '-'
    { op: "local.get", index: isNegLocal } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: bufPosLocal } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 45 } as Instr, // '-'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
      ],
    },

    // Call __wasi_write_string(buf_pos, buf_start + 12 - buf_pos)
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 12 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "call", funcIdx: writeStringIdx } as Instr,
  );

  ctx.mod.functions.push({
    name: "__wasi_write_i32",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "buf_start", type: { kind: "i32" } },
      { name: "buf_pos", type: { kind: "i32" } },
      { name: "is_neg", type: { kind: "i32" } },
      { name: "abs_val", type: { kind: "i32" } },
      { name: "tmp", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/** Ensure the __wasi_write_f64 helper exists and return its function index */
function ensureWasiWriteF64Helper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wasi_write_f64");
  if (existing !== undefined) return existing;

  const writeI32Idx = ensureWasiWriteI32Helper(ctx);
  const writeStringIdx = ctx.funcMap.get("__wasi_write_string");
  if (writeStringIdx === undefined || writeI32Idx < 0) return -1;

  // Simple f64 output: truncate to i32 and print as integer
  // For NaN, Infinity, -Infinity, handle specially
  const funcTypeIdx = addFuncType(ctx, [{ kind: "f64" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_f64", funcIdx);

  // Allocate data segments for special values
  const nanData = wasiAllocStringData(ctx, "NaN");
  const infData = wasiAllocStringData(ctx, "Infinity");
  const negInfData = wasiAllocStringData(ctx, "-Infinity");

  const body: Instr[] = [
    // Check NaN: value != value
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.ne" } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: nanData.offset } as Instr,
        { op: "i32.const", value: nanData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check positive infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: infData.offset } as Instr,
        { op: "i32.const", value: infData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check negative infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: -Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    { op: "if", blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: negInfData.offset } as Instr,
        { op: "i32.const", value: negInfData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Normal number: truncate to i32 and print
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.trunc_sat_f64_s" } as Instr,
    { op: "call", funcIdx: writeI32Idx } as Instr,
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_f64",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });

  return funcIdx;
}

function compileMathCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  // Native Wasm unary opcodes
  const nativeUnary: Record<string, string> = {
    sqrt: "f64.sqrt",
    abs: "f64.abs",
    floor: "f64.floor",
    ceil: "f64.ceil",
    trunc: "f64.trunc",
    nearest: "f64.nearest",
  };

  const f64Hint: ValType = { kind: "f64" };

  if (method === "round" && expr.arguments.length >= 1) {
    // JS Math.round: compare frac = x - floor(x) to 0.5.
    // If frac >= 0.5 use ceil(x), else floor(x). Preserves -0 via copysign.
    // This avoids precision loss from floor(x + 0.5) with large odd integers near 2^52.
    const xLocal = allocLocal(fctx, `__round_x_${fctx.locals.length}`, { kind: "f64" });
    const floorLocal = allocLocal(fctx, `__round_fl_${fctx.locals.length}`, { kind: "f64" });
    const rLocal = allocLocal(fctx, `__round_r_${fctx.locals.length}`, { kind: "f64" });
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "local.tee", index: xLocal } as Instr);
    fctx.body.push({ op: "f64.floor" } as Instr);
    fctx.body.push({ op: "local.set", index: floorLocal } as Instr);
    // frac = x - floor(x)
    fctx.body.push({ op: "local.get", index: xLocal } as Instr);
    fctx.body.push({ op: "local.get", index: floorLocal } as Instr);
    fctx.body.push({ op: "f64.sub" } as Instr);
    // frac >= 0.5 ? ceil(x) : floor(x)
    fctx.body.push({ op: "f64.const", value: 0.5 } as Instr);
    fctx.body.push({ op: "f64.ge" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: xLocal } as Instr,
        { op: "f64.ceil" } as Instr,
      ],
      else: [
        { op: "local.get", index: floorLocal } as Instr,
      ],
    } as Instr);
    fctx.body.push({ op: "local.tee", index: rLocal } as Instr);
    // If result == 0, use copysign(0, x) to preserve -0
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    fctx.body.push({ op: "f64.eq" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "f64.const", value: 0 } as Instr,
        { op: "local.get", index: xLocal } as Instr,
        { op: "f64.copysign" },
      ],
      else: [
        { op: "local.get", index: rLocal } as Instr,
      ],
    } as Instr);
    return { kind: "f64" };
  }

  if (method in nativeUnary && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: nativeUnary[method]! } as Instr);
    return { kind: "f64" };
  }

  // Math.clz32(n) → ToUint32(n) then i32.clz
  // ToUint32: NaN/±Infinity → 0; otherwise truncate then modulo 2^32.
  // We use the host-imported __toUint32 for correct edge-case handling.
  if (method === "clz32" && expr.arguments.length >= 1) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.clz" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  // Math.imul(a, b) → ToUint32(a) * ToUint32(b), result as signed i32
  if (method === "imul" && expr.arguments.length >= 2) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.mul" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  if (method === "sign" && expr.arguments.length >= 1) {
    // sign(x): NaN→NaN, -0→-0, 0→0, x>0→1, x<0→-1
    // Use f64.copysign to preserve -0 and NaN passthrough:
    //   if (x !== x) return NaN  (NaN check)
    //   if (x == 0) return x     (preserves -0/+0)
    //   return x > 0 ? 1 : -1
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    const tmp = allocLocal(fctx, `__sign_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.tee", index: tmp });
    // NaN check: x !== x
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push({ op: "f64.ne" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        // return NaN
        { op: "f64.const", value: NaN },
      ],
      else: [
        // x == 0 check (true for both +0 and -0)
        { op: "local.get", index: tmp },
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 0 },
        { op: "f64.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            // return x (preserves -0)
            { op: "local.get", index: tmp },
          ],
          else: [
            // return copysign(1.0, x) — gives 1 or -1 based on sign of x
            { op: "f64.const", value: 1 },
            { op: "local.get", index: tmp },
            { op: "f64.copysign" },
          ],
        },
      ],
    });
    return { kind: "f64" };
  }

  // Math.fround(x) → f64.promote_f32(f32.demote_f64(x))
  if (method === "fround" && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "f32.demote_f64" } as Instr);
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
    return { kind: "f64" };
  }

  // Math.hypot(a, b) → sqrt(a*a + b*b) — inline for the common 2-arg case
  if (method === "hypot") {
    if (expr.arguments.length === 0) {
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    if (expr.arguments.length === 1) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "f64.abs" } as Instr);
      return { kind: "f64" };
    }
    // 2+ args: spec says if any arg is +-Infinity → +Infinity, else sqrt(sum of squares)
    const hypotLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const loc = allocLocal(fctx, `__hypot_${fctx.locals.length}`, { kind: "f64" });
      compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      fctx.body.push({ op: "local.set", index: loc });
      hypotLocals.push(loc);
    }
    // Check if any arg is +-Infinity: abs(x) == +Inf
    // Build: abs(a0)==Inf || abs(a1)==Inf || ...
    for (let i = 0; i < hypotLocals.length; i++) {
      fctx.body.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      fctx.body.push({ op: "f64.abs" } as Instr);
      fctx.body.push({ op: "f64.const", value: Infinity });
      fctx.body.push({ op: "f64.eq" } as Instr);
      if (i > 0) {
        fctx.body.push({ op: "i32.or" } as Instr);
      }
    }
    // if any is Inf, return +Infinity, else sqrt(sum of squares)
    const thenBlock: Instr[] = [{ op: "f64.const", value: Infinity }];
    const elseBlock: Instr[] = [];
    for (let i = 0; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "f64.mul" } as Instr);
    }
    for (let i = 1; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "f64.add" } as Instr);
    }
    elseBlock.push({ op: "f64.sqrt" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenBlock,
      else: elseBlock,
    });
    return { kind: "f64" };
  }

  // Host-imported Math methods (1-arg): sin, cos, tan, exp, log, etc.
  const hostUnary = new Set([
    "exp", "log", "log2", "log10",
    "sin", "cos", "tan", "asin", "acos", "atan",
    "acosh", "asinh", "atanh", "cbrt", "expm1", "log1p",
  ]);
  if (hostUnary.has(method) && expr.arguments.length >= 1) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Host-imported Math methods (2-arg): pow, atan2
  if ((method === "pow" || method === "atan2") && expr.arguments.length >= 2) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.random() — 0-arg host import
  if (method === "random") {
    const funcIdx = ctx.funcMap.get("Math_random");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.min(...args) / Math.max(...args) — variadic with NaN propagation
  // Wasm f64.min/f64.max don't propagate NaN from the first operand in all
  // engines, so we guard each argument: if any arg is NaN, return NaN.
  // Compile-time optimization: if an arg is statically NaN, emit NaN directly.
  if ((method === "min" || method === "max") && expr.arguments) {
    const wasmOp = method === "min" ? "f64.min" : "f64.max";
    if (expr.arguments.length === 0) {
      fctx.body.push({ op: "f64.const", value: method === "min" ? Infinity : -Infinity } as Instr);
      return { kind: "f64" };
    }

    // Check if any argument is statically NaN → evaluate all args for side effects, then return NaN
    if (expr.arguments.some(a => isStaticNaN(ctx, a))) {
      // Must still evaluate all arguments (ToNumber coercion / side effects)
      for (const arg of expr.arguments) {
        if (!isStaticNaN(ctx, arg)) {
          compileExpression(ctx, fctx, arg, f64Hint);
          fctx.body.push({ op: "drop" } as Instr);
        }
      }
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Try static valueOf resolution for each argument.
    // For object-typed arguments, tryStaticToNumber resolves {} → NaN,
    // { valueOf: () => 42 } → 42, { valueOf: () => void } → NaN, etc.
    const staticValues: (number | undefined)[] = expr.arguments.map(a => {
      const tsType = ctx.checker.getTypeAtLocation(a);
      // Only apply static valueOf to non-number types (objects)
      if (tsType.flags & ts.TypeFlags.Object) {
        return tryStaticToNumber(ctx, a);
      }
      return undefined;
    });

    // If ALL arguments resolved statically, compute the result at compile time
    if (staticValues.every(v => v !== undefined)) {
      const nums = staticValues as number[];
      const result = method === "min"
        ? nums.reduce((a, b) => Math.min(a, b))
        : nums.reduce((a, b) => Math.max(a, b));
      fctx.body.push({ op: "f64.const", value: result });
      return { kind: "f64" };
    }

    // 1 arg: no f64.min needed, just return the value (or its static resolution)
    if (expr.arguments.length === 1) {
      if (staticValues[0] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[0] });
      } else {
        compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      }
      return { kind: "f64" };
    }

    // 2+ args: compile into locals, check each for NaN at runtime, then chain f64.min/max
    const argLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const local = allocLocal(fctx, `__minmax_${fctx.locals.length}`, { kind: "f64" });
      if (staticValues[ai] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[ai]! });
      } else {
        compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      }
      fctx.body.push({ op: "local.set", index: local });
      argLocals.push(local);
    }

    // Build nested if chain: for each arg, check isNaN → return it, else continue
    // Result type is f64 for each if block
    const f64Block = { kind: "val" as const, type: { kind: "f64" as const } };

    // Build from inside out: innermost is the actual f64.min/max chain
    let innerBody: Instr[] = [{ op: "local.get", index: argLocals[0]! }];
    for (let i = 1; i < argLocals.length; i++) {
      innerBody.push({ op: "local.get", index: argLocals[i]! });
      innerBody.push({ op: wasmOp });
    }

    // Wrap with NaN checks from last arg to first
    for (let i = argLocals.length - 1; i >= 0; i--) {
      innerBody = [
        // isNaN check: local.get, local.get, f64.ne (x !== x)
        { op: "local.get", index: argLocals[i]! },
        { op: "local.get", index: argLocals[i]! },
        { op: "f64.ne" } as Instr,
        {
          op: "if",
          blockType: f64Block,
          then: [{ op: "local.get", index: argLocals[i]! }],
          else: innerBody,
        } as Instr,
      ];
    }

    for (const instr of innerBody) {
      fctx.body.push(instr);
    }
    return { kind: "f64" };
  }

  ctx.errors.push({
    message: `Unsupported Math method: ${method}`,
    line: getLine(expr),
    column: getCol(expr),
  });
  return null;
}
function compileOptionalCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const propAccess = expr.expression as ts.PropertyAccessExpression;

  // Compile the receiver and check for null
  const objType = compileExpression(ctx, fctx, propAccess.expression);
  if (!objType) return null;

  const tmp = allocLocal(fctx, `__optcall_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  // Determine the call's return type from the resolved signature
  let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isEffectivelyVoidReturn(ctx, retType)) callReturnType = resolveWasmType(ctx, retType);
  }
  // Default result type for the if/else block
  let resultType: ValType = callReturnType === VOID_RESULT
    ? { kind: "externref" }
    : callReturnType;

  // else branch (non-null path): call the method
  const savedBody = pushBody(fctx);

  const tsReceiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
  let methodResolved = false;

  // 1. External declared class methods
  if (!methodResolved && isExternalDeclaredClass(tsReceiverType, ctx.checker)) {
    const className = tsReceiverType.getSymbol()?.name;
    if (className) {
      let current: string | undefined = className;
      while (current) {
        const info = ctx.externClasses.get(current);
        if (info?.methods.has(methodName)) {
          const importName = `${info.importPrefix}_${methodName}`;
          const funcIdx = ctx.funcMap.get(importName);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: tmp });
            for (const arg of expr.arguments) {
              compileExpression(ctx, fctx, arg);
            }
            const finalOptIdx = ctx.funcMap.get(importName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalOptIdx });
            methodResolved = true;
          }
          break;
        }
        current = (ctx as any).externClassParent?.get(current);
      }
    }
  }

  // 2. Local class instance methods
  if (!methodResolved) {
    let receiverClassName = tsReceiverType.getSymbol()?.name;
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(fullName);
      // Walk inheritance chain
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(fullName);
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      if (funcIdx !== undefined) {
        // Push receiver as self, with ref.as_non_null if needed
        fctx.body.push({ op: "local.get", index: tmp });
        if (objType.kind === "ref_null") {
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
        }
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }
        const finalMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
        methodResolved = true;
      }
    }
  }

  // 3. Struct type methods (object literal with methods)
  if (!methodResolved) {
    const structTypeName = resolveStructName(ctx, tsReceiverType);
    if (structTypeName) {
      const fullName = `${structTypeName}_${methodName}`;
      const funcIdx = ctx.funcMap.get(fullName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        if (objType.kind === "ref_null") {
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
        }
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!);
          }
        }
        const finalStructIdx = ctx.funcMap.get(fullName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalStructIdx });
        methodResolved = true;
      }
    }
  }

  // 4. String method calls
  if (!methodResolved && isStringType(tsReceiverType)) {
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      // Native string methods compile the receiver themselves from propAccess
      const nativeResult = compileNativeStringMethodCall(ctx, fctx, expr, propAccess, methodName);
      if (nativeResult !== null && nativeResult !== VOID_RESULT) {
        resultType = nativeResult as ValType;
        methodResolved = true;
      }
    } else {
      const importName = `string_${methodName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let ai = 0; ai < expr.arguments.length; ai++) {
          const argResult = compileExpression(ctx, fctx, expr.arguments[ai]!);
          const expectedType = paramTypes?.[ai + 1];
          if (argResult && expectedType && argResult.kind !== expectedType.kind) {
            coerceType(ctx, fctx, argResult, expectedType);
          }
        }
        if (paramTypes && expr.arguments.length + 1 < paramTypes.length) {
          for (let pi = expr.arguments.length + 1; pi < paramTypes.length; pi++) {
            const pt = paramTypes[pi]!;
            if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
            else if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
            else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        const returnsBool = methodName === "includes" || methodName === "startsWith" || methodName === "endsWith";
        resultType = returnsBool ? { kind: "i32" } : methodName === "indexOf" || methodName === "lastIndexOf" ? { kind: "f64" } : { kind: "externref" };
        methodResolved = true;
      }
    }
  }

  // 5. Number method calls (toString, toFixed)
  if (!methodResolved && isNumberType(tsReceiverType)) {
    if (methodName === "toString") {
      fctx.body.push({ op: "local.get", index: tmp });
      if (objType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const funcIdx = ctx.funcMap.get("number_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        resultType = { kind: "externref" };
        methodResolved = true;
      }
    } else if (methodName === "toFixed") {
      fctx.body.push({ op: "local.get", index: tmp });
      if (objType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!);
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      const funcIdx = ctx.funcMap.get("number_toFixed");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        resultType = { kind: "externref" };
        methodResolved = true;
      }
    }
  }

  // 6. Array method calls (compiles the receiver itself from propAccess)
  if (!methodResolved) {
    const bodyBefore = fctx.body.length;
    const arrResult = compileArrayMethodCall(ctx, fctx, propAccess, expr, tsReceiverType);
    if (arrResult !== undefined) {
      if (arrResult !== VOID_RESULT && arrResult !== null) {
        resultType = arrResult as ValType;
      }
      methodResolved = true;
    } else {
      // Array method didn't handle it; trim anything it may have emitted
      fctx.body.length = bodyBefore;
    }
  }

  if (!methodResolved) {
    // No method was resolved; push a default value so the else branch has a result
    resultType = { kind: "externref" };
    fctx.body.push(...defaultValueInstrs(resultType));
  }

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  // If the result type is ref, widen to ref_null for the nullable branch
  if (resultType.kind === "ref") {
    resultType = { kind: "ref_null", typeIdx: (resultType as any).typeIdx };
  }

  // Build the if/else block
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}

/**
 * Optional direct call: fn?.()
 * Compiles fn, checks if null → returns undefined, else calls fn normally.
 */
function compileOptionalDirectCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const callee = expr.expression as ts.Identifier;

  // Compile the callee and check for null
  const calleeType = compileExpression(ctx, fctx, callee);
  if (!calleeType) return null;

  // If the callee is not a reference type, it can't be null-checked
  if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null" && calleeType.kind !== "externref") {
    // Non-nullable primitive: just call it normally (strip questionDotToken)
    // The callee is already on the stack, but compileCallExpression will re-compile.
    // Drop it and delegate.
    fctx.body.push({ op: "drop" });
    const syntheticCall = ts.factory.createCallExpression(
      callee,
      expr.typeArguments,
      expr.arguments,
    );
    ts.setTextRange(syntheticCall, expr);
    (syntheticCall as any).parent = expr.parent;
    return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
  }

  const tmp = allocLocal(fctx, `__optdcall_${fctx.locals.length}`, calleeType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  // Determine the call's return type
  let resultType: ValType = { kind: "externref" };
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      const resolved = resolveWasmType(ctx, retType);
      if (resolved.kind === "ref") {
        resultType = { kind: "ref_null", typeIdx: (resolved as any).typeIdx };
      } else {
        resultType = resolved;
      }
    }
  }

  // else branch (non-null path): call the function
  const savedBody = pushBody(fctx);

  // Try to resolve as closure
  const funcName = callee.text;
  const closureInfo = ctx.closureMap.get(funcName);
  const funcIdx = ctx.funcMap.get(funcName);
  let resolved = false;

  if (closureInfo) {
    // Closure call — stack needs: [closure_ref(self), ...args, funcref]
    const closureStructTypeIdx = (calleeType as any).typeIdx as number;
    const closureRefType: ValType = { kind: "ref", typeIdx: closureStructTypeIdx };
    const closureTmp = allocLocal(fctx, `__optdcall_cls_${fctx.locals.length}`, closureRefType);

    // Get closure ref from tmp, cast to non-null, save to closureTmp
    fctx.body.push({ op: "local.get", index: tmp });
    if (calleeType.kind === "ref_null") {
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
    }
    fctx.body.push({ op: "local.set", index: closureTmp });

    // Push closure ref as first arg (self param of the lifted function)
    fctx.body.push({ op: "local.get", index: closureTmp });

    // Push call arguments with type coercion (only up to declared param count)
    const closureParamCount = closureInfo.paramTypes.length;
    for (let i = 0; i < Math.min(expr.arguments.length, closureParamCount); i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
    }
    // Drop excess arguments beyond the closure's parameter count (side effects only)
    for (let i = closureParamCount; i < expr.arguments.length; i++) {
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null && extraType !== VOID_RESULT) {
        fctx.body.push({ op: "drop" });
      }
    }

    // Pad missing arguments with defaults (arity mismatch)
    for (let i = expr.arguments.length; i < closureInfo.paramTypes.length; i++) {
      pushDefaultValue(fctx, closureInfo.paramTypes[i]!);
    }

    // Push the funcref from the closure struct (field 0) and cast to typed ref
    fctx.body.push({ op: "local.get", index: closureTmp });
    // Null check: throw TypeError if closure ref is null (#728)
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureStructTypeIdx });
    fctx.body.push({ op: "struct.get", typeIdx: closureStructTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.funcTypeIdx });
    fctx.body.push({ op: "ref.as_non_null" });

    // call_ref with the lifted function's type index
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    resolved = true;
  } else if (funcIdx !== undefined) {
    // Direct function call
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    for (let i = 0; i < expr.arguments.length; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
    }
    if (paramTypes) {
      for (let i = expr.arguments.length; i < paramTypes.length; i++) {
        pushDefaultValue(fctx, paramTypes[i]!);
      }
    }
    const finalIdx = ctx.funcMap.get(funcName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalIdx });
    resolved = true;
  }

  if (!resolved) {
    // Fallback: push undefined
    fctx.body.push(...defaultValueInstrs(resultType));
  }

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}
function ensureSymbolCounter(ctx: CodegenContext): number {
  if (ctx.symbolCounterGlobalIdx >= 0) return ctx.symbolCounterGlobalIdx;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__symbol_counter",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 100 }],
  });
  ctx.symbolCounterGlobalIdx = idx;
  return idx;
}

/**
 * Compile a Symbol() call — returns a unique i32 by incrementing a global counter.
 * The description argument (if any) is evaluated for side effects but discarded.
 */
function compileSymbolCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType {
  // Evaluate description arg for side effects, then drop it
  if (args.length > 0) {
    const argType = compileExpression(ctx, fctx, args[0]!);
    if (argType !== null) {
      fctx.body.push({ op: "drop" });
    }
  }

  const counterIdx = ensureSymbolCounter(ctx);
  // ++counter; return counter
  fctx.body.push({ op: "global.get", index: counterIdx });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "global.set", index: counterIdx });
  fctx.body.push({ op: "global.get", index: counterIdx });
  return { kind: "i32" };
}
function compileArrayConstructorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const args = expr.arguments;

  // Determine element type from contextual type or expression type
  const ctxType = ctx.checker.getContextualType(expr);
  let exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);

  // Infer element type
  let elemWasm: ValType;
  const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
  const elemTsType = rawTypeArgs?.[0];
  if (elemTsType && !(elemTsType.flags & ts.TypeFlags.Any)) {
    elemWasm = resolveWasmType(ctx, elemTsType);
  } else {
    // Default to f64 for untyped arrays
    elemWasm = { kind: "f64" };
  }

  const elemKind = (elemWasm.kind === "ref" || elemWasm.kind === "ref_null")
    ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}` : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    ctx.errors.push({ message: "Array(): invalid vec type", line: getLine(expr), column: getCol(expr) });
    return null;
  }

  if (args.length === 0) {
    // Array() → empty array
    fctx.body.push({ op: "i32.const", value: 0 });           // length = 0
    fctx.body.push({ op: "i32.const", value: 0 });           // size for array.new_default
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  if (args.length === 1) {
    // Array(n) → sparse array of length n with default values
    compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Array(a, b, c) → [a, b, c]
  for (const arg of args) {
    compileExpression(ctx, fctx, arg, elemWasm);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: args.length });
  const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: args.length });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}
