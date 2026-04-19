// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * new/super/class expression compilation.
 */
import ts from "typescript";
import type { FieldDef, Instr, ValType } from "../../ir/types.js";
import { collectReferencedIdentifiers, collectWrittenIdentifiers } from "../closures.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addStringConstantGlobal,
  ensureExnTag,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  resolveWasmType,
} from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import type { InnerResult } from "../shared.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  registerCompileSuperElementAccess,
  registerCompileSuperPropertyAccess,
  registerResolveEnclosingClassName,
} from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "../type-coercion.js";
import { ensureDateDaysFromCivilHelper, ensureDateStruct } from "./builtins.js";
import { compileSpreadCallArgs } from "./extern.js";
import {
  emitThrowString,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

function resolveEnclosingClassName(fctx: FunctionContext): string | undefined {
  if (fctx.enclosingClassName) return fctx.enclosingClassName;
  const underscoreIdx = fctx.name.indexOf("_");
  if (underscoreIdx > 0) return fctx.name.substring(0, underscoreIdx);
  return undefined;
}

/** Compile super.method(args) — resolve to ParentClass_method and call with this */
function compileSuperMethodCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super.method() in object literal — evaluate args for side effects, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const wasmType = resolveWasmType(ctx, retType);
      if (wasmType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (wasmType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return wasmType;
    }
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // super.method() in class without extends — no parent to resolve.
    // Evaluate args for side effects, return default value.
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const wasmType = resolveWasmType(ctx, retType);
      if (wasmType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (wasmType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return wasmType;
    }
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
    reportError(ctx, expr, `Cannot find method '${methodName}' on parent class '${parentClassName}'`);
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes self (param 0)
  const superParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
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
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
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
  if (!currentClassName) {
    // super['method']() in object literal — evaluate args, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // super['method']() in class without extends — evaluate args, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
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
    reportError(ctx, expr, `Cannot find method '${methodName}' on parent class '${parentClassName}'`);
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes self (param 0)
  const superElemParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superElemParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
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
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
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
    // super in object literal method — cannot resolve prototype chain at compile time.
    // Emit a default value based on the access type.
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

  // Find parent class — if none, super resolves to Object.prototype (most props undefined)
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // In a base class, super.prop resolves to Object.prototype[prop] — usually undefined.
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
    // super in object literal method — emit default value
    const accessType2 = ctx.checker.getTypeAtLocation(expr);
    const wasmType2 = resolveWasmType(ctx, accessType2);
    if (wasmType2.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType2.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType2;
  }

  // Find parent class — if none, super resolves to Object.prototype
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    const accessType2 = ctx.checker.getTypeAtLocation(expr);
    const wasmType2 = resolveWasmType(ctx, accessType2);
    if (wasmType2.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType2.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType2;
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
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    varName = parent.left.text;
  }
  if (!varName) return null;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = expr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return; // already found

    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      node.arguments.length >= 1
    ) {
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
 * Check if a node tree references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
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
 * Compile `new FuncDecl(args)` where FuncDecl is a function declaration used
 * as a constructor (e.g. `function Foo() { this.x = 1; }; new Foo()`).
 *
 * Strategy:
 * 1. Analyze the function body for `this.prop = value` assignments to determine struct fields.
 * 2. Create a WasmGC struct type with those fields.
 * 3. Create a constructor function that allocates the struct, binds `this`, runs the body, returns the struct.
 * 4. Cache the struct type and constructor so subsequent `new Foo()` calls reuse them.
 */
function compileNewFunctionDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcName: string,
  funcDecl: ts.FunctionDeclaration,
): ValType | null {
  const body = funcDecl.body;
  if (!body) return null;

  // 1. Analyze the function body for `this.prop = value` assignments
  const fields: FieldDef[] = [];
  function collectThisAssignments(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const fieldName = stmt.expression.left.name.text;
        if (!fields.some((f) => f.name === fieldName)) {
          // Prefer the RHS type — when `this` is `any`, the LHS type is also `any`
          // (externref), but the RHS has concrete type info (e.g., number → f64).
          const lhsType = ctx.checker.getTypeAtLocation(stmt.expression.left);
          const rhsType = ctx.checker.getTypeAtLocation(stmt.expression.right);
          const lhsWasm = resolveWasmType(ctx, lhsType);
          const rhsWasm = resolveWasmType(ctx, rhsType);
          // Use RHS type if LHS resolved to externref (i.e., `any`)
          const fieldType = lhsWasm.kind === "externref" ? rhsWasm : lhsWasm;
          fields.push({ name: fieldName, type: fieldType, mutable: true });
        }
      }
      // Recurse into if/else blocks
      if (ts.isIfStatement(stmt)) {
        if (ts.isBlock(stmt.thenStatement)) {
          collectThisAssignments(stmt.thenStatement.statements);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          collectThisAssignments(stmt.elseStatement.statements);
        }
      }
      // Recurse into for/while/do blocks
      if (
        (ts.isForStatement(stmt) ||
          ts.isForInStatement(stmt) ||
          ts.isForOfStatement(stmt) ||
          ts.isWhileStatement(stmt) ||
          ts.isDoStatement(stmt)) &&
        ts.isBlock(stmt.statement)
      ) {
        collectThisAssignments(stmt.statement.statements);
      }
    }
  }
  collectThisAssignments(body.statements);

  // Empty constructors (no this.prop assignments) — create an empty struct.
  // Many test262 tests define `var Con = function() {}; new Con()` to test
  // prototype-based inheritance. We emit a minimal struct + constructor.

  // Widen non-null ref fields to ref_null so struct.new can use ref.null defaults
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = { kind: "ref_null", typeIdx: (field.type as { typeIdx: number }).typeIdx };
    }
  }

  // 2. Create a struct type for the function constructor
  const structName = `__fnctor_${funcName}`;
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  });
  ctx.structMap.set(structName, structTypeIdx);
  ctx.typeIdxToStructName.set(structTypeIdx, structName);
  ctx.structFields.set(structName, fields);

  // 3. Build the constructor function
  // Constructor params match the function declaration params
  const ctorParams: ValType[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const param = funcDecl.parameters[i]!;
    const paramType = ctx.checker.getTypeAtLocation(param);
    ctorParams.push(resolveWasmType(ctx, paramType));
  }

  const ctorName = `${structName}_new`;
  const ctorResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
  const ctorTypeIdx = addFuncType(ctx, ctorParams, ctorResults, `${ctorName}_type`);
  const ctorFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(ctorName, ctorFuncIdx);

  const ctorFunc = {
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [] as { name: string; type: ValType }[],
    body: [] as Instr[],
    exported: false,
  };
  ctx.mod.functions.push(ctorFunc);

  // Cache the mapping
  ctx.funcConstructorMap.set(funcName, { structTypeIdx, ctorFuncName: ctorName });

  // 4. Compile the constructor body
  const paramDefs: { name: string; type: ValType }[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const p = funcDecl.parameters[i]!;
    paramDefs.push({
      name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
      type: ctorParams[i] ?? { kind: "f64" },
    });
  }

  const ctorFctx: FunctionContext = {
    name: ctorName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: { kind: "ref", typeIdx: structTypeIdx },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // Set up param locals
  for (let i = 0; i < ctorFctx.params.length; i++) {
    ctorFctx.localMap.set(ctorFctx.params[i]!.name, i);
  }

  // Allocate the struct instance with default values
  for (const field of fields) {
    if (field.type.kind === "f64") {
      ctorFctx.body.push({ op: "f64.const", value: 0 });
    } else if (field.type.kind === "i32") {
      ctorFctx.body.push({ op: "i32.const", value: 0 });
    } else if (field.type.kind === "i64") {
      ctorFctx.body.push({ op: "i64.const", value: 0n } as unknown as Instr);
    } else if (field.type.kind === "externref") {
      ctorFctx.body.push({ op: "ref.null.extern" });
    } else if (field.type.kind === "ref_null") {
      ctorFctx.body.push({ op: "ref.null", typeIdx: (field.type as { typeIdx: number }).typeIdx } as Instr);
    } else if (field.type.kind === "ref") {
      ctorFctx.body.push({ op: "ref.null", typeIdx: (field.type as { typeIdx: number }).typeIdx } as Instr);
    } else {
      ctorFctx.body.push({ op: "i32.const", value: 0 });
    }
  }
  ctorFctx.body.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);

  // Store in __self local
  const selfLocal = allocLocal(ctorFctx, "__self", { kind: "ref", typeIdx: structTypeIdx });
  ctorFctx.body.push({ op: "local.set", index: selfLocal });

  // Bind `this` to the struct
  ctorFctx.localMap.set("this", selfLocal);

  // Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = ctorFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, ctorFctx, stmt);
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Return the struct instance
  ctorFctx.body.push({ op: "local.get", index: selfLocal });

  // Finalize the constructor function
  ctorFunc.locals = ctorFctx.locals;
  ctorFunc.body = ctorFctx.body;

  // 5. Emit the call to the constructor at the call site
  const args = expr.arguments ?? [];
  const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx);
  for (let i = 0; i < args.length; i++) {
    compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
  }
  if (paramTypes) {
    for (let i = args.length; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx in case addUnionImports shifted indices
  const finalCtorIdx = ctx.funcMap.get(ctorName) ?? ctorFuncIdx;
  fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
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
    reportError(ctx, expr, "new FunctionExpression with non-literal spread not supported");
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

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
  }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const isOwnParam = funcExpr.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (isOwnParam) continue;
    if (name === "arguments") continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
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
  const liftedParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }, ...formalParams];

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
      const refCellType: ValType = {
        kind: "ref_null",
        typeIdx: refCellTypeIdx,
      };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: 0 });
      liftedFctx.body.push({
        op: "struct.get",
        typeIdx: structTypeIdx,
        fieldIdx: i + 1,
      });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType: cap.type,
      });
    } else {
      // Check if this capture is an already-boxed ref cell from the outer scope
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        const refCellType: ValType = { kind: "ref_null", typeIdx: outerBoxed.refCellTypeIdx };
        const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, {
          refCellTypeIdx: outerBoxed.refCellTypeIdx,
          valType: outerBoxed.valType,
        });
      } else {
        const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }

  // Set up `arguments` if the body references it
  if (needsArguments) {
    // Ensure __box_number is available for boxing numeric params
    const hasNumericFormal = formalParams.some((pt) => pt.kind === "f64" || pt.kind === "i32");
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const numArgs = formalParams.length;
    const elemType: ValType = { kind: "externref" };
    const vti = getOrRegisterVecType(ctx, "externref", elemType);
    const ati = getArrTypeIdxFromVec(ctx, vti);
    const vecRef: ValType = { kind: "ref", typeIdx: vti };
    const argsLocal = allocLocal(liftedFctx, "arguments", vecRef);
    const arrTmp = allocLocal(liftedFctx, "__args_arr_tmp", {
      kind: "ref",
      typeIdx: ati,
    });

    // Ensure __unbox_number is available for reverse sync
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, liftedFctx);
    }

    // Set up mapped arguments info (#849) — params start at index 1 (skip __self)
    liftedFctx.mappedArgsInfo = {
      argsLocalIdx: argsLocal,
      arrTypeIdx: ati,
      vecTypeIdx: vti,
      paramCount: numArgs,
      paramOffset: 1, // skip __self capture param
      paramTypes: formalParams.slice(),
    };

    // Push each param coerced to externref
    for (let i = 0; i < numArgs; i++) {
      liftedFctx.body.push({ op: "local.get", index: i + 1 }); // skip __self
      const pt = formalParams[i]!;
      if (pt.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "i32") {
        liftedFctx.body.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "ref" || pt.kind === "ref_null") {
        liftedFctx.body.push({ op: "extern.convert_any" });
      }
      // externref params are already externref — no conversion needed
    }
    liftedFctx.body.push({
      op: "array.new_fixed",
      typeIdx: ati,
      length: numArgs,
    });
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
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref_null",
          typeIdx: refCellTypeIdx,
        });
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
  const closureLocal = allocLocal(fctx, `__ctor_closure_${closureId}`, {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
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
function compileClassExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.ClassExpression): ValType | null {
  // Look up the synthetic name assigned during the collection phase
  const syntheticName = ctx.anonClassExprNames.get(expr);
  const classNameForCheck = syntheticName ?? expr.name?.text;

  // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
  if (classNameForCheck && ctx.classThrowsOnEval.has(classNameForCheck)) {
    emitThrowString(ctx, fctx, "TypeError: Classes may not have a static property named 'prototype'");
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "externref" };
  }

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

function compileNewExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.NewExpression): ValType | null {
  // Handle `new function() { ... }(args)` — constructor with function expression
  if (ts.isFunctionExpression(expr.expression)) {
    return compileNewFunctionExpression(ctx, fctx, expr, expr.expression);
  }

  // Arrow functions are NOT constructors — `new (() => {})` throws TypeError (#730)
  {
    let unwrappedNew: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrappedNew)) {
      unwrappedNew = unwrappedNew.expression;
    }
    if (ts.isArrowFunction(unwrappedNew)) {
      emitThrowString(ctx, fctx, "TypeError: is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
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
          reportError(ctx, expr, `Missing constructor for anonymous class`);
          return null;
        }

        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }

        fctx.body.push({ op: "call", funcIdx });
        const structTypeIdx = ctx.structMap.get(syntheticName)!;
        return { kind: "ref", typeIdx: structTypeIdx };
      }
    }
  }

  // Non-identifier constructor: detect non-constructable functions.
  if (!ts.isIdentifier(expr.expression) && !ts.isFunctionExpression(expr.expression)) {
    // Pattern 1: `new X.prototype.Y()` — prototype methods are NEVER constructors.
    // This covers both ES2022 (forEach) and ES2023 (with, toSorted) methods,
    // even when TypeScript lib doesn't know about the method (type resolves to `any`).
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const obj = expr.expression.expression; // e.g. Array.prototype
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") {
        emitThrowString(ctx, fctx, "TypeError: is not a constructor");
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Pattern 2: TypeScript knows the expression has call sigs but no construct sigs.
    // e.g. `new decodeURIComponent()`, `new Math.abs()`, `new Array.from()`.
    const exprType = ctx.checker.getTypeAtLocation(expr.expression);
    const constructSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Construct);
    const callSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Call);
    if (callSigs.length > 0 && constructSigs.length === 0) {
      emitThrowString(ctx, fctx, "TypeError: is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle `new Promise(executor)` — delegate to host import
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    let funcIdx =
      ctx.funcMap.get("Promise_new") ??
      ensureLateImport(ctx, "Promise_new", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    funcIdx = ctx.funcMap.get("Promise_new") ?? funcIdx;
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
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
        // new Number(x) → create real JS Number wrapper object via __new_Number host import
        // (typeof new Number(0) === "object", not "number")
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newNumIdx = ensureLateImport(ctx, "__new_Number", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalNumIdx = ctx.funcMap.get("__new_Number") ?? newNumIdx;
        if (finalNumIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalNumIdx });
        return { kind: "externref" };
      }

      if (ctorName === "String") {
        // new String(x) → create real JS String wrapper object via __new_String host import
        // (typeof new String("") === "object", not "string")
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        } else {
          const emptyStrResult = compileStringLiteral(ctx, fctx, "");
          if (!emptyStrResult) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        const newStrIdx = ensureLateImport(ctx, "__new_String", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalStrIdx = ctx.funcMap.get("__new_String") ?? newStrIdx;
        if (finalStrIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalStrIdx });
        return { kind: "externref" };
      }

      if (ctorName === "Boolean") {
        // new Boolean(x) → create real JS Boolean wrapper object via __new_Boolean host import
        // (typeof new Boolean(false) === "object", not "boolean")
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newBoolIdx = ensureLateImport(ctx, "__new_Boolean", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalBoolIdx = ctx.funcMap.get("__new_Boolean") ?? newBoolIdx;
        if (finalBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalBoolIdx });
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Error(msg)`, `new TypeError(msg)`, `new RangeError(msg)` — create real Error objects
  // via host import so .name, .message, .stack are correct and instanceof works.
  // Standalone fallback: the thrown value is just the message string (as before).
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (
      ctorName === "Error" ||
      ctorName === "TypeError" ||
      ctorName === "RangeError" ||
      ctorName === "SyntaxError" ||
      ctorName === "URIError" ||
      ctorName === "EvalError" ||
      ctorName === "ReferenceError" ||
      ctorName === "Test262Error"
    ) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        // Compile the message argument to externref
        const resultType = compileExpression(ctx, fctx, args[0]!, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          coerceType(ctx, fctx, resultType, { kind: "externref" });
        }
      } else {
        // No message — push null externref (undefined message)
        fctx.body.push({ op: "ref.null.extern" });
      }
      // Use host import to create a real Error object with correct .name/.message/.stack
      const importName = `__new_${ctorName}`;
      const funcIdx = ensureLateImport(
        ctx,
        importName,
        [{ kind: "externref" }], // message param
        [{ kind: "externref" }], // returns Error object
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      // If import not available (standalone), value is already on stack as externref message
      return { kind: "externref" };
    }
  }

  // Handle `new AggregateError(errors, message, options?)` (#844)
  // AggregateError takes (iterable, message, options?) — pass errors and message as externref
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "AggregateError") {
    const args = expr.arguments ?? [];
    // Compile errors argument (iterable) as externref
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile message argument as externref
    if (args.length >= 2) {
      const msgType = compileExpression(ctx, fctx, args[1]!, { kind: "externref" });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile options argument as externref (for cause property)
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, { kind: "externref" });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_AggregateError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new Object()` — create an empty struct (equivalent to {})
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Object") {
    // Look for an empty struct type, or create an externref null as empty object
    // In non-fast mode, an empty object is just an externref null
    // In fast mode or when we have struct types, emit a minimal struct
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Proxy(target, handler)` — delegate to __proxy_create host import.
  // The host wraps the target in a real JS Proxy with the given handler object.
  // In standalone (no-JS) mode, falls back to pass-through (target returned as-is).
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy") {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      // Compile target argument and coerce to externref
      const bodyBefore = fctx.body.length;
      const targetResult = compileExpression(ctx, fctx, args[0]!);
      if (targetResult && targetResult.kind !== "externref") {
        if (targetResult.kind === "ref" || targetResult.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else {
          coerceTypeImpl(ctx, fctx, targetResult, { kind: "externref" });
        }
      }

      // Compile handler argument and coerce to externref (or push null if missing)
      if (args.length >= 2) {
        const handlerResult = compileExpression(ctx, fctx, args[1]!);
        if (handlerResult && handlerResult.kind !== "externref") {
          if (handlerResult.kind === "ref" || handlerResult.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, handlerResult, { kind: "externref" });
          }
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Emit call to __proxy_create(target, handler) -> externref
      const proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      }

      return { kind: "externref" };
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
      const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
      if (dateNowIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: dateNowIdx } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n } as unknown as Instr);
      }
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
        {
          op: "if",
          blockType: { kind: "empty" },
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
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (TYPED_ARRAY_NAMES.has(expr.expression.text)) {
      const elemWasm: ValType = { kind: "f64" };
      const vecTypeIdx = getOrRegisterVecType(ctx, "f64", elemWasm);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new TypedArray() → empty array, length 0
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
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
        const isArrayLike =
          argSym?.name === "Array" ||
          ((argType.flags & ts.TypeFlags.Object) !== 0 &&
            argSym?.name !== undefined &&
            TYPED_ARRAY_NAMES.has(argSym.name));

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
          if (
            srcTypeDef?.kind === "struct" &&
            srcTypeDef.fields[0]?.name === "length" &&
            srcTypeDef.fields[1]?.name === "data"
          ) {
            const srcVecLocal = allocLocal(fctx, `__ta_src_${fctx.locals.length}`, srcResult);
            fctx.body.push({ op: "local.set", index: srcVecLocal });
            // Get source length
            fctx.body.push({ op: "local.get", index: srcVecLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: srcTypeIdx,
              fieldIdx: 0,
            });
            const lenLocal = allocLocal(fctx, `__ta_len_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.tee", index: lenLocal });
            // Create new array of that length
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            const dstDataLocal = allocLocal(fctx, `__ta_dst_${fctx.locals.length}`, {
              kind: "ref",
              typeIdx: arrTypeIdx,
            });
            fctx.body.push({ op: "local.set", index: dstDataLocal });

            // If source and dest have the same array type, use array.copy
            const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
            if (srcArrTypeIdx === arrTypeIdx) {
              fctx.body.push({ op: "local.get", index: dstDataLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: srcVecLocal });
              fctx.body.push({
                op: "struct.get",
                typeIdx: srcTypeIdx,
                fieldIdx: 1,
              });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: lenLocal });
              fctx.body.push({
                op: "array.copy",
                dstTypeIdx: arrTypeIdx,
                srcTypeIdx: arrTypeIdx,
              } as Instr);
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

  // Check if the identifier resolves to a function declaration used as constructor
  // (e.g. `function Foo() { this.x = 1; }; new Foo()`)
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const fnName = expr.expression.text;
    // Check cache first — if we already built a constructor for this function
    const cachedFnCtor = ctx.funcConstructorMap.get(fnName);
    if (cachedFnCtor) {
      const ctorFuncIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName);
      if (ctorFuncIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        const finalIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName) ?? ctorFuncIdx;
        fctx.body.push({ op: "call", funcIdx: finalIdx });
        return { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
      }
    }
    // Resolve via type checker to find the function declaration
    if (!cachedFnCtor) {
      const exprSymbol = ctx.checker.getSymbolAtLocation(expr.expression);
      const decls = exprSymbol?.getDeclarations();
      if (decls) {
        for (const decl of decls) {
          if (ts.isFunctionDeclaration(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(ctx, fctx, expr, fnName, decl);
            if (result) return result;
            break;
          }
          // Handle `var Con = function() { this.x = 1; }; new Con()`
          // The declaration is a VariableDeclaration whose initializer is a FunctionExpression
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            let init: ts.Expression = decl.initializer;
            // Unwrap parenthesized expressions
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            if (ts.isFunctionExpression(init) && init.body) {
              // Synthesize a FunctionDeclaration-like node for compileNewFunctionDeclaration
              const result = compileNewFunctionDeclaration(
                ctx,
                fctx,
                expr,
                fnName,
                init as unknown as ts.FunctionDeclaration,
              );
              if (result) return result;
              break;
            }
          }
        }
      }
    }
  }

  if (!className) {
    // Unknown constructor (e.g. Test262Error) — call an imported constructor
    // registered upfront by collectUnknownConstructorImports.
    const ctorName = ts.isIdentifier(expr.expression) ? expr.expression.text : "__unknown";

    // RangeError validation for built-in constructors (type resolves to any
    // when lib declarations are not loaded, so className is undefined here)
    const args = expr.arguments ?? [];

    // new ArrayBuffer(byteLength) — validate non-negative integer length
    if (ctorName === "ArrayBuffer" && args.length >= 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: lenF64 });
      // Check: len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check: len < 0
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }
    }

    // new DataView(buffer, byteOffset, byteLength) — validate offset and length
    if (ctorName === "DataView") {
      // Validate byteOffset (2nd arg) if provided
      if (args.length >= 2) {
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // Check: offset < 0
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: offset != floor(offset) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      }
      // Validate byteLength (3rd arg) if provided
      if (args.length >= 3) {
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // Check: len < 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: len != floor(len) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      }
    }

    // new Array(n) — validate non-negative integer length < 2^32
    if (ctorName === "Array" && args.length === 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const nF64 = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: nF64 });
      // Check: n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check: n < 0
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check: n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }
    }

    const importName = `__new_${ctorName}`;
    const funcIdx = ctx.funcMap.get(importName);

    if (funcIdx !== undefined) {
      // Compile arguments as externref
      for (const arg of args) {
        const resultType = compileExpression(ctx, fctx, arg, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Pad missing arguments with ref.null extern (the import may have
      // more params than this particular call site provides, since the
      // import is registered with the *max* arg count across all sites).
      const importParamTypes = getFuncParamTypes(ctx, funcIdx);
      if (importParamTypes) {
        for (let i = args.length; i < importParamTypes.length; i++) {
          pushDefaultValue(fctx, importParamTypes[i]!, ctx);
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
      reportError(ctx, expr, `Missing constructor for class: ${className}`);
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
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
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
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, args.length - ctorRestInfo.restIndex);
      fctx.body.push({ op: "i32.const", value: restArgCount });
      for (let i = ctorRestInfo.restIndex; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, ctorRestInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: ctorRestInfo.arrayTypeIdx,
        length: restArgCount,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctorRestInfo.vecTypeIdx });
    } else {
      for (let i = 0; i < args.length; i++) {
        compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
      }
      // Pad missing constructor arguments with defaults (arity mismatch)
      if (paramTypes) {
        for (let i = args.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
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
      pushDefaultValue(fctx, externInfo.constructorParams[i]!, ctx);
    }

    const importName = `${externInfo.importPrefix}_new`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      reportError(ctx, expr, `Missing import for constructor: ${importName}`);
      return null;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // new Uint8Array(n), new Int32Array(n), new Float64Array(n), etc. → vec struct with f64 elements
  {
    const TYPED_ARRAY_CTORS = new Set([
      "Int8Array",
      "Uint8Array",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
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
        const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, {
          kind: "i32",
        });
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

      // RangeError validation: byteLength must be a non-negative integer < 2^31
      // (We use i32 internally so cap at i32 max)
      const lenF64Local = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64Local });
      // Check len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check len < 0
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) / new DataView(buffer, byteOffset) / new DataView(buffer, byteOffset, byteLength)
  if (className === "DataView") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // Compile buffer arg first
      const resultType = compileExpression(ctx, fctx, args[0]!);
      const isStructBuf = resultType !== null && (resultType.kind === "ref" || resultType.kind === "ref_null");

      // Always stash the buffer in a local so we can validate, register the
      // view window via __dv_register_view (#1064), and restore it on stack.
      const bufLocalType: ValType = isStructBuf ? resultType! : { kind: "externref" };
      const bufLocal = allocLocal(fctx, `__dv_buf_${fctx.locals.length}`, bufLocalType);
      fctx.body.push({ op: "local.set", index: bufLocal });

      // Offset and length f64 locals (used for validation AND view-metadata
      // registration). Defaults: offset=0, length=bufferByteLength-offset.
      const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, { kind: "f64" });

      if (args.length >= 2) {
        // Validate byteOffset
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: offsetF64 });
        // Check: offset < 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: offset != floor(offset) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });

        // If buffer is a vec struct, also check offset > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // buffer length
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      } else {
        // No explicit byteOffset — default to 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "local.set", index: offsetF64 });
      }

      if (args.length >= 3) {
        // Validate byteLength
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: lenF64 });
        // Check: len < 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check: len != floor(len) (NaN/non-integer)
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.floor" } as unknown as Instr);
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });

        // Check: offset + length > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      } else if (isStructBuf) {
        // Default byteLength = bufferByteLength - offset
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "local.set", index: lenF64 });
      } else {
        // externref buffer — we can't read length at compile time. Use a
        // NaN sentinel; the runtime __dv_register_view handler treats NaN as
        // "compute from __dv_byte_len(buf) - offset" at dispatch time.
        fctx.body.push({ op: "f64.const", value: NaN });
        fctx.body.push({ op: "local.set", index: lenF64 });
      }

      // #1064: register view metadata with host so the runtime bridge can
      // reconstruct a correctly-windowed native DataView on method dispatch.
      // Always register, even for externref buffers — ArrayBuffer variables
      // in user code are lowered to externref (see checker/type-mapper.ts),
      // but the actual wasmGC struct is what the bridge dispatches on.
      {
        const regIdx = ensureLateImport(
          ctx,
          "__dv_register_view",
          [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }],
          [],
        );
        flushLateImportShifts(ctx, fctx);
        if (regIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: bufLocal });
          if (isStructBuf) {
            fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
          }
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "call", funcIdx: regIdx });
        }
      }

      // Restore buffer on stack
      fctx.body.push({ op: "local.get", index: bufLocal });
      if (isStructBuf) return resultType!;
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
    const exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);
    // If element type is `any` (no contextual type, no explicit type arg),
    // infer from how the array variable is used: scan element assignments
    // like arr[i] = value and arr.push(value) to determine the element type.
    let inferredElemWasm: ValType | null = null;
    const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
    if (rawTypeArgs?.[0] && rawTypeArgs[0].flags & ts.TypeFlags.Any) {
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
      // Fallback: use externref vec type for Array<any> or unresolvable element types
      vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = { kind: "externref" };
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
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

      // RangeError validation: n must be a non-negative integer < 2^32
      // Check: n != floor(n) || n < 0 || n >= 2^32 → throw RangeError
      const nF64Local = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: nF64Local });
      // Check n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.floor" } as unknown as Instr);
      fctx.body.push({ op: "f64.ne" });
      // Check n < 0
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      // If any check true, throw RangeError
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, {
        kind: "i32",
      });
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
    fctx.body.push({
      op: "array.new_fixed",
      typeIdx: arrTypeIdx,
      length: args.length,
    });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: args.length });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  reportError(ctx, expr, `Unsupported new expression for class: ${className}`);
  return null;
}

export {
  compileClassExpression,
  compileNewExpression,
  compileSuperElementMethodCall,
  compileSuperMethodCall,
  resolveEnclosingClassName,
};

// Register the resolveEnclosingClassName delegate so closures.ts (and others)
// can call it via shared.ts without creating an import cycle.
registerResolveEnclosingClassName(resolveEnclosingClassName);
registerCompileSuperPropertyAccess(compileSuperPropertyAccess);
registerCompileSuperElementAccess(compileSuperElementAccess);
