// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * Optional call expression compilation:
 * - obj?.method(args) — compileOptionalCallExpression
 */
import ts from "typescript";
import { isExternalDeclaredClass, isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveWasmType } from "../index.js";
import type { InnerResult } from "../shared.js";
import { compileExpression, VOID_RESULT } from "../shared.js";
import { compileNativeStringMethodCall } from "../string-ops.js";
import { defaultValueInstrs, pushDefaultValue } from "../type-coercion.js";
import { getFuncParamTypes } from "./helpers.js";
import { resolveStructName } from "./misc.js";

export function compileOptionalCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const objType = compileExpression(ctx, fctx, propAccess.expression);
  if (!objType) return null;

  const tmp = allocLocal(fctx, `__optcall_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) callReturnType = resolveWasmType(ctx, retType);
  }
  let resultType: ValType = callReturnType === VOID_RESULT ? { kind: "externref" } : callReturnType;

  const savedBody = pushBody(fctx);
  const tsReceiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
  let methodResolved = false;

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
            for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
            fctx.body.push({ op: "call", funcIdx });
            methodResolved = true;
          }
          break;
        }
        current = ctx.externClassParent.get(current);
      }
    }
  }

  if (!methodResolved) {
    let receiverClassName = tsReceiverType.getSymbol()?.name;
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(fullName);
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(fullName);
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        if (objType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        methodResolved = true;
      }
    }
  }

  if (!methodResolved) {
    const structTypeName = resolveStructName(ctx, tsReceiverType);
    if (structTypeName) {
      const fullName = `${structTypeName}_${methodName}`;
      const funcIdx = ctx.funcMap.get(fullName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        if (objType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        methodResolved = true;
      }
    }
  }

  if (!methodResolved && isStringType(tsReceiverType)) {
    if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
      const nativeResult = compileNativeStringMethodCall(ctx, fctx, expr, propAccess, methodName);
      if (nativeResult !== null) {
        resultType = nativeResult;
        methodResolved = true;
      }
    } else {
      const importName = `string_${methodName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
        fctx.body.push({ op: "call", funcIdx });
        methodResolved = true;
      }
    }
  }

  if (!methodResolved) fctx.body.push(...defaultValueInstrs(resultType));

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  if (resultType.kind === "ref") resultType = { kind: "ref_null", typeIdx: resultType.typeIdx };

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}
