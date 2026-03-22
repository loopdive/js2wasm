import ts from "typescript";
import type { CodegenContext, FunctionContext, ClosureInfo } from "./index.js";
import { allocLocal, resolveWasmType, getOrRegisterVecType, getArrTypeIdxFromVec, addFuncType, ensureStructForType, getOrRegisterRefCellType, nextModuleGlobalIdx, pushBody, localGlobalIdx } from "./index.js";
import {
  isVoidType,
} from "../checker/type-mapper.js";
import type { Instr, ValType, FieldDef, StructTypeDef } from "../ir/types.js";
import { compileExpression, valTypesMatch, coerceType, emitBoundsCheckedArrayGet, getLine, getCol, resolveEnclosingClassName } from "./expressions.js";
import { compileStatement } from "./statements.js";

/** Collect all identifiers referenced in a node */
export function collectReferencedIdentifiers(node: ts.Node, names: Set<string>): void {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
  }
  // Track `this` keyword references so arrow functions can capture the
  // enclosing scope's `this` through the normal closure mechanism.
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    names.add("this");
  }
  ts.forEachChild(node, (child) => collectReferencedIdentifiers(child, names));
}

/**
 * Collect identifiers that are WRITTEN to within a node tree.
 * Detects: assignment (=, +=, etc.), ++, --.
 */
export function collectWrittenIdentifiers(node: ts.Node, names: Set<string>): void {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    // Assignment operators
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken ||
      op === ts.SyntaxKind.PercentEqualsToken ||
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      if (ts.isIdentifier(node.left)) {
        names.add(node.left.text);
      }
    }
  } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const op = node.operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
      if (ts.isIdentifier(node.operand)) {
        names.add(node.operand.text);
      }
    }
  }
  ts.forEachChild(node, (child) => collectWrittenIdentifiers(child, names));
}

/**
 * Promote captured locals to globals for getter/setter accessor functions.
 *
 * When an object literal getter/setter references variables from the enclosing
 * function scope, those variables need to be accessible as Wasm globals (since
 * the getter/setter is compiled as a separate Wasm function).
 *
 * This function:
 * 1. Scans the accessor body for referenced identifiers
 * 2. For each that maps to a local in the enclosing fctx, creates a Wasm global
 * 3. Copies the local's current value into the global
 * 4. Removes the name from localMap so subsequent code uses the global
 * 5. Registers in ctx.capturedGlobals for resolution in the accessor body
 */
export function promoteAccessorCapturesToGlobals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  accessorBody: ts.Block | undefined,
): void {
  if (!accessorBody) return;

  const referencedNames = new Set<string>();
  for (const stmt of accessorBody.statements) {
    collectReferencedIdentifiers(stmt, referencedNames);
  }

  for (const name of referencedNames) {
    // Skip if already a captured global or module global
    if (ctx.capturedGlobals.has(name)) continue;
    if (ctx.moduleGlobals.has(name)) continue;

    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;

    // Skip 'this' — it's passed as param 0 to the accessor
    if (name === "this") continue;

    // Skip if it's a known function name (not a variable capture)
    if (ctx.funcMap.has(name)) continue;

    // Get the local's type
    const localType = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" as const };

    // Widen non-nullable ref to ref_null for global init
    const globalType: ValType = localType.kind === "ref"
      ? { kind: "ref_null", typeIdx: (localType as { typeIdx: number }).typeIdx }
      : localType;

    // Create default init for the global
    const init: Instr[] =
      globalType.kind === "f64"
        ? [{ op: "f64.const", value: 0 }]
        : globalType.kind === "i32"
          ? [{ op: "i32.const", value: 0 }]
          : globalType.kind === "externref"
            ? [{ op: "ref.null.extern" }]
            : globalType.kind === "ref_null"
              ? [{ op: "ref.null", typeIdx: (globalType as { typeIdx: number }).typeIdx }]
              : [{ op: "i32.const", value: 0 }];

    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__captured_${name}`,
      type: globalType,
      mutable: true,
      init,
    });

    // Copy current local value into the new global
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "global.set", index: globalIdx });

    // Register as captured global so accessor body resolves via global.get
    ctx.capturedGlobals.set(name, globalIdx);
    if (localType.kind === "ref") {
      ctx.capturedGlobalsWidened.add(name);
    }

    // If this variable has a local TDZ flag, also promote it to a global TDZ flag
    const tdzFlagLocalIdx = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagLocalIdx !== undefined) {
      const tdzGlobalIdx = nextModuleGlobalIdx(ctx);
      ctx.mod.globals.push({
        name: `__tdz_${name}`,
        type: { kind: "i32" },
        mutable: true,
        init: [{ op: "i32.const", value: 0 }],
      });
      // Copy current TDZ flag value to the global
      fctx.body.push({ op: "local.get", index: tdzFlagLocalIdx });
      fctx.body.push({ op: "global.set", index: tdzGlobalIdx });
      ctx.tdzGlobals.set(name, tdzGlobalIdx);
    }

    // Remove from localMap so subsequent code in the enclosing function
    // also uses the global (maintaining shared state with the accessor)
    fctx.localMap.delete(name);
  }
}

/** Collect all identifier names from a binding pattern (destructuring parameter) */
function collectBindingPatternNames(pattern: ts.BindingPattern, names: Set<string>): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      names.add(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      collectBindingPatternNames(element.name, names);
    }
  }
}

/** Check if a name is defined in any of the arrow's own parameters (including destructuring) */
function isOwnParamName(arrow: ts.ArrowFunction | ts.FunctionExpression, name: string): boolean {
  for (const p of arrow.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text === name) return true;
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      const names = new Set<string>();
      collectBindingPatternNames(p.name, names);
      if (names.has(name)) return true;
    }
  }
  return false;
}

/**
 * Emit destructuring code for an arrow function parameter that uses a binding pattern.
 * The parameter value is already in a local at `paramIdx`; this emits instructions to
 * extract fields/elements into new locals in the lifted function context.
 */
function emitArrowParamDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  param: ts.ParameterDeclaration,
  paramIdx: number,
  paramType: ValType,
): void {
  if (ts.isObjectBindingPattern(param.name)) {
    // Object destructuring: const { a, b } = param
    const pattern = param.name;

    // Resolve struct type from the parameter's TS type
    const tsParamType = ctx.checker.getTypeAtLocation(param);
    ensureStructForType(ctx, tsParamType);

    const symName = tsParamType.symbol?.name;
    let typeName =
      symName &&
      symName !== "__type" &&
      symName !== "__object" &&
      ctx.structMap.has(symName)
        ? symName
        : (ctx.anonTypeMap.get(tsParamType) ?? symName);

    if (
      typeName &&
      (typeName === "__type" || typeName === "__object") &&
      !ctx.anonTypeMap.has(tsParamType) &&
      tsParamType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, tsParamType);
      typeName = ctx.anonTypeMap.get(tsParamType) ?? typeName;
    }

    if (!typeName) return;
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) return;

    // Null guard for ref_null param types
    const savedBodyAPD = fctx.body;
    const apdInstrs: Instr[] = [];
    fctx.body = apdInstrs;

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (ts.isOmittedExpression(element as any)) continue;
      const propNameNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      // propName must be an identifier or string literal to extract field name
      if (!ts.isIdentifier(propNameNode) && !ts.isStringLiteral(propNameNode)) {
        continue;
      }
      const propName = propNameNode as ts.Identifier;
      const localName = element.name.text;

      const fieldIdx = fields.findIndex((f) => f.name === propName.text);
      if (fieldIdx === -1) continue;

      const fieldType = fields[fieldIdx]!.type;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      if (element.initializer) {
        if (fieldType.kind === "externref") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField } as Instr,
              { op: "local.set", index: localIdx } as Instr,
            ],
          });
        } else if (fieldType.kind === "f64") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "local.get", index: tmpField });
          fctx.body.push({ op: "f64.ne" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField } as Instr,
              { op: "local.set", index: localIdx } as Instr,
            ],
          });
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }

    // Close null guard
    fctx.body = savedBodyAPD;
    if (paramType.kind === "ref_null" && apdInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: apdInstrs });
    } else {
      fctx.body.push(...apdInstrs);
    }
  } else if (ts.isArrayBindingPattern(param.name)) {
    // Array destructuring: const [a, b] = param
    const pattern = param.name;

    if (paramType.kind !== "ref" && paramType.kind !== "ref_null") return;

    const vecTypeIdx = (paramType as { typeIdx: number }).typeIdx;
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") return;

    const innerElemType = arrDef.element;

    // Null guard for ref_null param types
    const savedBodyAPDA = fctx.body;
    const apdaInstrs: Instr[] = [];
    fctx.body = apdaInstrs;

    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue;
      if (!ts.isIdentifier((element as ts.BindingElement).name)) continue;

      const localName = ((element as ts.BindingElement).name as ts.Identifier).text;
      const bindingTsType = ctx.checker.getTypeAtLocation(element);
      const bindingWasmType = resolveWasmType(ctx, bindingTsType);
      const localIdx = allocLocal(fctx, localName, bindingWasmType);

      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

      if (!valTypesMatch(innerElemType, bindingWasmType)) {
        coerceType(ctx, fctx, innerElemType, bindingWasmType);
      }

      fctx.body.push({ op: "local.set", index: localIdx });
    }

    // Close null guard
    fctx.body = savedBodyAPDA;
    if (paramType.kind === "ref_null" && apdaInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: apdaInstrs });
    } else {
      fctx.body.push(...apdaInstrs);
    }
  }
}

/**
 * Emit default-value initialization for arrow/closure function parameters.
 * Similar to the logic in compileFunctionBody but operates on the lifted fctx.
 */
function emitArrowParamDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  paramOffset: number, // offset in liftedFctx.params (usually 1 for __self)
): void {
  for (let i = 0; i < arrow.parameters.length; i++) {
    const param = arrow.parameters[i]!;
    if (!param.initializer) continue;
    // Only for simple identifier params (destructuring defaults handled separately)
    if (!ts.isIdentifier(param.name)) continue;

    const paramIdx = paramOffset + i;
    const paramType = fctx.params[paramIdx]?.type;
    if (!paramType) continue;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    compileExpression(ctx, fctx, param.initializer, paramType);
    fctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = fctx.body;
    fctx.body = savedBody;

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "f64") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    }
  }
}

/**
 * Emit default-value initialization for method/setter parameters with initializers.
 * For each param with a default value, check if the caller omitted it
 * (externref -> ref.is_null, i32 -> i32.eqz, f64 -> f64.eq 0.0) and if so
 * compile the initializer expression and assign it to the param local.
 */
export function emitMethodParamDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  paramOffset: number, // offset in fctx.params (usually 1 for 'this')
): void {
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (!param.initializer) continue;
    if (!ts.isIdentifier(param.name)) continue;

    const paramIdx = paramOffset + i;
    const paramType = fctx.params[paramIdx]?.type;
    if (!paramType) continue;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    compileExpression(ctx, fctx, param.initializer, paramType);
    fctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = fctx.body;
    fctx.body = savedBody;

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "i32") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    } else if (paramType.kind === "f64") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
    }
  }
}

/** Check if an arrow/function expression is used as a callback argument to a call
 *  that targets a HOST import (not a user-defined function). User-defined functions
 *  should receive closures via the GC struct path, not the __make_callback host path. */
export function isHostCallbackArgument(node: ts.Node, ctx: CodegenContext): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    if (!parent.arguments.some((arg) => arg === node)) return false;
    // Check if the callee is a user-defined function — if so, NOT a host callback
    if (ts.isIdentifier(parent.expression)) {
      const calleeName = parent.expression.text;
      const funcIdx = ctx.funcMap.get(calleeName);
      if (funcIdx !== undefined && funcIdx >= ctx.numImportFuncs) {
        // User-defined function — use closure path, not host callback
        return false;
      }
    }
    // For method calls (property access), check if the method is known array HOF
    // (filter, map, etc.) — those have dedicated inline compilation and ARE handled
    // as closure calls. For other property accesses, treat as host callback.
    return true;
  }
  return false;
}

export function compileArrowFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  // If used as callback argument to a host call, use the __make_callback path
  if (isHostCallbackArgument(arrow, ctx)) {
    return compileArrowAsCallback(ctx, fctx, arrow);
  }
  // Otherwise, compile as a first-class closure value
  return compileArrowAsClosure(ctx, fctx, arrow);
}

/** Compile an arrow function as a first-class closure value (Wasm GC struct + funcref) */
export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__closure_${closureId}`;
  const body = arrow.body;

  // Check if this is a generator function expression (function*() { ... })
  const isGenerator = ts.isFunctionExpression(arrow) && arrow.asteriskToken !== undefined;
  if (isGenerator) {
    ctx.generatorFunctions.add(closureName);
  }

  // 1. Determine arrow parameter types and return type
  const arrowParams: ValType[] = [];
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    let wasmType = resolveWasmType(ctx, paramType);
    // If the parameter has a default value and is a non-null ref type,
    // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
    if (p.initializer && wasmType.kind === "ref") {
      wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
    }
    arrowParams.push(wasmType);
  }

  const sig = ctx.checker.getSignatureFromDeclaration(arrow);
  let closureReturnType: ValType | null = null;
  if (isGenerator) {
    // Generator function expressions always return externref (JS Generator object)
    closureReturnType = { kind: "externref" };
  } else if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    // Treat `never` the same as `void` — a function returning `never` (e.g.
    // always throws) never produces a value, so it should have no Wasm result.
    // Without this, `never` resolves to externref and creates a mismatched
    // closure wrapper type vs. the `() => void` signature expected by callers.
    if (!isVoidType(retType) && !(retType.flags & ts.TypeFlags.Never)) {
      closureReturnType = resolveWasmType(ctx, retType);
    }
  }

  // (#585) Check the contextual type (e.g., a parameter type like `() => void`).
  // If the contextual type expects a void-returning callable but the closure's
  // actual return type is non-void, override to void so the closure uses the
  // same wrapper struct type that callers will ref.cast against.
  if (closureReturnType !== null) {
    const ctxType = ctx.checker.getContextualType(arrow);
    if (ctxType) {
      const ctxCallSigs = ctxType.getCallSignatures?.();
      if (ctxCallSigs && ctxCallSigs.length > 0) {
        const ctxRetType = ctx.checker.getReturnTypeOfSignature(ctxCallSigs[0]!);
        if (isVoidType(ctxRetType)) {
          closureReturnType = null;
        }
      }
    }
  }

  // 2. Analyze captured variables
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Detect which captured variables are written inside the closure body
  const writtenInClosure = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInClosure);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInClosure);
  }

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean; alreadyBoxed: boolean }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
    // Skip if the name is a named function expression's own name (self-reference)
    if (ts.isFunctionExpression(arrow) && arrow.name && arrow.name.text === name) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    // A capture is mutable if the closure writes to it
    const isMutable = writtenInClosure.has(name);
    // Check if the variable is already boxed from a previous closure capture.
    // If so, the local already holds a ref cell — don't wrap it again.
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable, alreadyBoxed });
  }

  // 3. Create struct type: field 0 = funcref, fields 1..N = captured vars
  //    For mutable captures, the field type is a ref cell (struct { value: T })
  const closureResults: ValType[] = closureReturnType ? [closureReturnType] : [];

  // For closures with no captures, reuse the shared wrapper struct type from
  // getOrCreateFuncRefWrapperTypes. This ensures all no-capture closures with
  // the same signature share the same struct type, enabling consistent call_ref
  // dispatch when closures are passed as callable parameters (externref).
  let structTypeIdx: number;
  let liftedFuncTypeIdx: number;
  let liftedParams: ValType[];
  const isNamedFuncExpr = ts.isFunctionExpression(arrow) && arrow.name;

  if (captures.length === 0 && !isNamedFuncExpr) {
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
    if (wrapperTypes) {
      structTypeIdx = wrapperTypes.structTypeIdx;
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [
        { kind: "ref", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
    } else {
      // Fallback: create a unique struct type
      const structFields = [
        { name: "func", type: { kind: "funcref" as const }, mutable: false },
      ];
      structTypeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      liftedParams = [
        { kind: "ref", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  } else {
    const structFields = [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      ...captures.map((c) => {
        if (c.mutable && !c.alreadyBoxed) {
          // First time boxing: create ref cell type for the capture value type
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
          return {
            name: c.name,
            type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
            mutable: false,
          };
        }
        if (c.mutable && c.alreadyBoxed) {
          // Already boxed: the capture's type IS the ref cell type already
          return {
            name: c.name,
            type: c.type,
            mutable: false,
          };
        }
        return {
          name: c.name,
          type: c.type,
          mutable: false,
        };
      }),
    ];

    // For closures with captures (but not named func exprs), make the struct
    // a subtype of the shared wrapper struct so ref.cast at call sites succeeds.
    // Named func exprs need ref_null __self (for var hoisting), so they can't
    // share the wrapper's lifted func type which uses non-null ref.
    const wrapperTypes = !isNamedFuncExpr
      ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults)
      : null;

    structTypeIdx = ctx.mod.types.length;
    if (wrapperTypes) {
      // Subtype of the wrapper struct — inherits field 0 (funcref), adds captures
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
        superTypeIdx: wrapperTypes.structTypeIdx,
      });
      // Share the wrapper's lifted func type so call_ref dispatches correctly.
      // The __self param is (ref $wrapperStruct), and the lifted body will
      // ref.cast to the specific subtype to access captures.
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [
        { kind: "ref_null", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
    } else {
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      // 4. Create the lifted function type: (ref_null $closure_struct, ...arrowParams) → results
      // Use ref_null for __self so that var-hoisted variables shadowing the function name
      // (e.g. `var g` inside `function g()`) can be default-initialized to null.
      liftedParams = [
        { kind: "ref_null", typeIdx: structTypeIdx },
        ...arrowParams,
      ];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  }

  // 5. Build the lifted function body
  // For no-capture closures using wrapper types, self param is non-null ref.
  // For captured closures sharing wrapper types, self param uses the WRAPPER struct
  // type (non-null ref) — captures are accessed via ref.cast to the subtype.
  // For named func exprs, self param is ref_null (var hoisting support).
  const usesWrapperFuncType = captures.length > 0 && !isNamedFuncExpr && !!getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
  const selfParamKind = isNamedFuncExpr ? "ref_null" as const : "ref" as const;
  const selfTypeIdx = usesWrapperFuncType
    ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults)!.structTypeIdx
    : structTypeIdx;
  const liftedFctx: FunctionContext = {
    name: closureName,
    params: [
      { name: "__self", type: { kind: selfParamKind, typeIdx: selfTypeIdx } },
      ...arrow.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: arrowParams[i] ?? { kind: "f64" as const },
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: closureReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    enclosingClassName: fctx.enclosingClassName ?? resolveEnclosingClassName(fctx),
    isGenerator,
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields.
  // When using wrapper func types, __self is typed as the wrapper base struct —
  // cast it to the specific subtype to access capture fields.
  let selfLocalForCaptures = 0; // default: param 0 (__self)
  if (usesWrapperFuncType && captures.length > 0) {
    const castLocal = allocLocal(liftedFctx, "__self_cast", { kind: "ref", typeIdx: structTypeIdx });
    liftedFctx.body.push({ op: "local.get", index: 0 }); // __self (wrapper base type)
    liftedFctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
    liftedFctx.body.push({ op: "local.set", index: castLocal });
    selfLocalForCaptures = castLocal;
  }
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      // Mutable capture: store the ref cell reference itself.
      // If already boxed, cap.type IS the ref cell type — extract the existing
      // ref cell type index instead of creating a new wrapper.
      let refCellTypeIdx: number;
      let valType: ValType;
      if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        // Already boxed: the field stores the ref cell directly
        refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
        // Look up the original value type from the outer scope's boxed capture info
        const outerBoxed = fctx.boxedCaptures?.get(cap.name);
        valType = outerBoxed?.valType ?? { kind: "f64" };
      } else {
        refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        valType = cap.type;
      }
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      // Register as boxed so identifier read/write uses struct.get/set
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType });
    } else {
      const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // For named function expressions, register the name in the lifted
  // function's local scope so recursive calls resolve to __self (the
  // closure struct).  Also register in closureMap so the call-site
  // compiler emits call_ref instead of a direct call.
  let funcExprName: string | undefined;
  if (ts.isFunctionExpression(arrow) && arrow.name) {
    funcExprName = arrow.name.text;
    // Map the name to the __self param (index 0) inside the lifted body
    liftedFctx.localMap.set(funcExprName, 0);
    // The function name binding is read-only (assignments are silently ignored)
    if (!liftedFctx.readOnlyBindings) liftedFctx.readOnlyBindings = new Set();
    liftedFctx.readOnlyBindings.add(funcExprName);
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  // Temporarily register closure info for named function expressions so
  // recursive calls inside the body are compiled as closure calls.
  const closureInfoForSelf: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
  };
  if (funcExprName) {
    ctx.closureMap.set(funcExprName, closureInfoForSelf);
  }

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, liftedFctx, arrow, 1 /* skip __self */);

  // Destructuring parameter initialization: for parameters with binding patterns
  // (e.g. function([x, y]) or function({a, b})), extract values from the parameter
  // and assign them to local variables.
  for (let pi = 0; pi < arrow.parameters.length; pi++) {
    const param = arrow.parameters[pi]!;
    if (ts.isIdentifier(param.name)) continue; // simple param, already handled

    const paramIdx = pi + 1; // +1 for __self
    const paramType = arrowParams[pi]!;

    // Helper: allocate locals for all identifiers in a binding pattern
    // using TS type inference for each element. This is a fallback for when
    // the Wasm type doesn't provide enough info to extract values.
    const allocBindingLocals = (pattern: ts.BindingPattern) => {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isIdentifier(element.name)) {
          const localName = element.name.text;
          if (!liftedFctx.localMap.has(localName)) {
            const elemTsType = ctx.checker.getTypeAtLocation(element);
            const elemWasmType = resolveWasmType(ctx, elemTsType);
            allocLocal(liftedFctx, localName, elemWasmType);
          }
        } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
          allocBindingLocals(element.name);
        }
      }
    };

    if (ts.isArrayBindingPattern(param.name)) {
      // Array destructuring: function([a, b, c]) { ... }
      let handled = false;

      // Resolve the vec type — for externref params, try to infer the
      // concrete array type from TS so we can any.convert_extern + ref.cast.
      // First try the TS checker, then fall back to the default f64 vec type.
      let resolvedParamType = paramType;
      let srcParamIdx = paramIdx;
      if (paramType.kind === "externref") {
        // Infer the actual array type from TS checker
        const tsParamType = ctx.checker.getTypeAtLocation(param);
        let inferred = resolveWasmType(ctx, tsParamType);
        // If TS returns externref (e.g. any), fall back to the default f64 vec type
        if (inferred.kind === "externref") {
          const elemKey = ctx.fast ? "i32" : "f64";
          const elemType2: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
          const vecIdx = getOrRegisterVecType(ctx, elemKey, elemType2);
          inferred = { kind: "ref_null", typeIdx: vecIdx };
        }
        if (inferred.kind === "ref" || inferred.kind === "ref_null") {
          // Convert externref to the concrete vec type via any.convert_extern + ref.cast
          const castLocal = allocLocal(liftedFctx, `__cast_arr_${liftedFctx.locals.length}`, { kind: "ref_null", typeIdx: inferred.typeIdx });
          liftedFctx.body.push({ op: "local.get", index: paramIdx });
          liftedFctx.body.push({ op: "ref.is_null" } as Instr);
          liftedFctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: paramIdx } as Instr,
              { op: "any.convert_extern" },
              { op: "ref.cast_null", typeIdx: inferred.typeIdx },
              { op: "local.set", index: castLocal } as Instr,
            ],
          });
          resolvedParamType = { kind: "ref_null", typeIdx: inferred.typeIdx };
          srcParamIdx = castLocal;
        }
      }

      if (resolvedParamType.kind === "ref" || resolvedParamType.kind === "ref_null") {
        const typeIdx = resolvedParamType.typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef && typeDef.kind === "struct") {
          const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
          const arrDef = ctx.mod.types[arrTypeIdx];
          if (arrDef && arrDef.kind === "array") {
            const elemType = arrDef.element;
            const savedBodyFPAD = liftedFctx.body;
            const fpadInstrs: Instr[] = [];
            liftedFctx.body = fpadInstrs;
            for (let ei = 0; ei < param.name.elements.length; ei++) {
              const element = param.name.elements[ei]!;
              if (ts.isOmittedExpression(element)) continue;
              if (!ts.isBindingElement(element)) continue;

              // Handle rest element: function([a, ...rest])
              if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
                const restName = element.name.text;
                const restLenLocal = allocLocal(liftedFctx, `__rest_len_${liftedFctx.locals.length}`, { kind: "i32" });
                // Compute rest length: max(0, param.length - ei)
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "i32.sub" } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });
                // Clamp to 0 if negative
                liftedFctx.body.push({ op: "i32.const", value: 0 } as Instr);
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 } as Instr);
                liftedFctx.body.push({ op: "i32.lt_s" } as Instr);
                liftedFctx.body.push({ op: "select" } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });

                // Create new data array
                const restArrLocal = allocLocal(liftedFctx, `__rest_arr_${liftedFctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restArrLocal });

                // array.copy(restArr, 0, srcData, ei, restLen)
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 });
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // src data
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

                // Create new vec struct: struct.new(restLen, restArr)
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "struct.new", typeIdx } as Instr);

                const vecType: ValType = { kind: "ref_null", typeIdx };
                const restLocal = allocLocal(liftedFctx, restName, vecType);
                liftedFctx.body.push({ op: "local.set", index: restLocal });
                continue;
              }

              if (!ts.isIdentifier(element.name)) continue;
              const localName = element.name.text;
              const localIdx = allocLocal(liftedFctx, localName, elemType);
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
              liftedFctx.body.push({ op: "i32.const", value: ei });
              emitBoundsCheckedArrayGet(liftedFctx, arrTypeIdx, elemType);
              liftedFctx.body.push({ op: "local.set", index: localIdx });
            }
            liftedFctx.body = savedBodyFPAD;
            if ((resolvedParamType.kind === "ref_null") && fpadInstrs.length > 0) {
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "ref.is_null" } as Instr);
              liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpadInstrs });
            } else {
              liftedFctx.body.push(...fpadInstrs);
            }
            handled = true;
          } else if (typeDef.fields.length > 0 && typeDef.fields[0]!.name === "_0") {
            // Tuple struct destructuring: extract positional fields via struct.get
            const savedBodyFPAD = liftedFctx.body;
            const fpadInstrs: Instr[] = [];
            liftedFctx.body = fpadInstrs;
            for (let ei = 0; ei < param.name.elements.length; ei++) {
              const element = param.name.elements[ei]!;
              if (ts.isOmittedExpression(element)) continue;
              if (!ts.isBindingElement(element)) continue;
              if (ei >= typeDef.fields.length) break;

              const fieldType = typeDef.fields[ei]!.type;
              if (!ts.isIdentifier(element.name)) continue;
              const localName = element.name.text;
              const localIdx = allocLocal(liftedFctx, localName, fieldType);
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: ei });
              liftedFctx.body.push({ op: "local.set", index: localIdx });
            }
            liftedFctx.body = savedBodyFPAD;
            if ((resolvedParamType.kind === "ref_null") && fpadInstrs.length > 0) {
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "ref.is_null" } as Instr);
              liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpadInstrs });
            } else {
              liftedFctx.body.push(...fpadInstrs);
            }
            handled = true;
          }
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
    } else if (ts.isObjectBindingPattern(param.name)) {
      // Object destructuring: function({a, b}) { ... }
      let handled = false;
      if (paramType.kind === "ref" || paramType.kind === "ref_null") {
        const typeIdx = paramType.typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef && typeDef.kind === "struct") {
          let allFound = true;
          const savedBodyFPOD = liftedFctx.body;
          const fpodInstrs: Instr[] = [];
          liftedFctx.body = fpodInstrs;
          for (const element of param.name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (!ts.isIdentifier(element.name)) continue;
            const localName = element.name.text;
            const propName = element.propertyName
              ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : localName)
              : localName;
            const fieldIdx = typeDef.fields.findIndex((f: any) => f.name === propName);
            if (fieldIdx < 0) { allFound = false; continue; }
            const fieldType = typeDef.fields[fieldIdx]!.type;
            const localIdx = allocLocal(liftedFctx, localName, fieldType);
            liftedFctx.body.push({ op: "local.get", index: paramIdx });
            liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            liftedFctx.body.push({ op: "local.set", index: localIdx });
          }
          liftedFctx.body = savedBodyFPOD;
          if (paramType.kind === "ref_null" && fpodInstrs.length > 0) {
            liftedFctx.body.push({ op: "local.get", index: paramIdx });
            liftedFctx.body.push({ op: "ref.is_null" } as Instr);
            liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpodInstrs });
          } else {
            liftedFctx.body.push(...fpodInstrs);
          }
          handled = allFound;
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
    }
  }

  let conciseBodyHasValue = false;

  if (isGenerator && ts.isBlock(body)) {
    // Generator function expression: eagerly evaluate body, collect yields
    // into a buffer, then wrap with __create_generator.
    const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
    const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
    liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
    liftedFctx.body.push({ op: "local.set", index: bufferLocal });

    // Wrap body in a block so return can br out
    const bodyInstrs: Instr[] = [];
    const outerBody = liftedFctx.body;
    liftedFctx.body = bodyInstrs;

    liftedFctx.generatorReturnDepth = 0;
    liftedFctx.blockDepth++;
    for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
    for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }

    liftedFctx.blockDepth--;
    for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!--;
    for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!--;
    liftedFctx.generatorReturnDepth = undefined;

    liftedFctx.body = outerBody;
    liftedFctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    });

    // Return __create_generator(__gen_buffer)
    const createGenIdx = ctx.funcMap.get("__create_generator")!;
    liftedFctx.body.push({ op: "local.get", index: bufferLocal });
    liftedFctx.body.push({ op: "call", funcIdx: createGenIdx });
    conciseBodyHasValue = true; // generator return value is already on stack
  } else if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType !== null && closureReturnType) {
      // Expression result is the return value - already on stack
      conciseBodyHasValue = true;

      // The actual expression type may differ from the declared return type
      // (e.g. TS infers `any`->externref but codegen produces f64 for arithmetic).
      // Coerce the expression result to match the declared return type.
      if (exprType.kind !== closureReturnType.kind) {
        if (closureReturnType.kind === "externref" && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
          // Upcast struct ref to externref via extern.convert_any
          liftedFctx.body.push({ op: "extern.convert_any" });
        } else if (closureReturnType.kind === "externref" && exprType.kind === "f64") {
          // f64 cannot be converted to externref; fix the return type instead
          closureReturnType = exprType;
          liftedFctx.returnType = exprType;
          closureResults[0] = exprType;
          liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
          closureInfoForSelf.returnType = exprType;
          closureInfoForSelf.funcTypeIdx = liftedFuncTypeIdx;
        }
      }
    } else if (exprType !== null) {
      liftedFctx.body.push({ op: "drop" });
    }
  }

  // Clean up the temporary closure map entry for named function expressions
  if (funcExprName) {
    ctx.closureMap.delete(funcExprName);
  }

  // Ensure return value for non-void functions (skip if concise body already left a value)
  if (closureReturnType && !conciseBodyHasValue) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (closureReturnType.kind === "f64") {
        liftedFctx.body.push({ op: "f64.const", value: 0 });
      } else if (closureReturnType.kind === "i32") {
        liftedFctx.body.push({ op: "i32.const", value: 0 });
      } else if (closureReturnType.kind === "externref") {
        liftedFctx.body.push({ op: "ref.null.extern" });
      }
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 6. Register the lifted function
  const liftedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(closureName, liftedFuncIdx);

  // 7. At the creation site, emit struct.new with funcref + captured values
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      // Check if the outer scope already has this variable boxed (nested closure case)
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass the ref cell reference directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Wrap the current value in a ref cell
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref_null", typeIdx: refCellTypeIdx });
        // Duplicate: we need the ref cell for the closure struct AND for the outer local
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
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // 8. Register closure info so call sites can emit call_ref
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
  };

  // Always register by struct type index (for valueOf coercion and anonymous closures)
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);

  const parent = arrow.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    ctx.closureMap.set(parent.name.text, closureInfo);
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    // Assignment expression: f = function() { ... }
    // Only register if the target variable is a local in the current function context
    // and not a boxed (mutable) capture, which stores values as externref.
    const assignName = parent.left.text;
    const currentFctx = ctx.currentFunc;
    const localIdx = currentFctx.localMap.get(assignName);
    if (localIdx !== undefined && !currentFctx.boxedCaptures?.has(assignName)) {
      // It's a local variable (not a boxed capture) — safe to register as closure
      ctx.closureMap.set(assignName, closureInfo);
    }
  } else if (
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    // Object literal: { fn: function() { ... } }
    // Don't register in closureMap (property, not variable)
  }

  return { kind: "ref", typeIdx: structTypeIdx };
}

/** Compile an arrow function as a host callback via __make_callback.
 *  Captures are bundled into a per-instance GC struct (not shared globals). */
export function compileArrowAsCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const cbId = ctx.callbackCounter++;
  const cbName = `__cb_${cbId}`;
  const body = arrow.body;

  // 1. Analyze captured variables
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  const captures: { name: string; type: ValType; localIdx: number }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
    const type = localIdx < fctx.params.length
      ? fctx.params[localIdx]!.type
      : fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" };
    captures.push({ name, type, localIdx });
  }

  // 2. Create capture struct type (if captures exist)
  let capStructTypeIdx = -1;
  if (captures.length > 0) {
    capStructTypeIdx = ctx.mod.types.length;
    const fields: FieldDef[] = captures.map((cap) => ({
      name: cap.name,
      type: cap.type,
      mutable: false, // captures are immutable snapshots
    }));
    ctx.mod.types.push({
      kind: "struct",
      name: `__cb_cap_${cbId}`,
      fields,
    } as StructTypeDef);
  }

  // 3. Build the __cb_N function — first param is externref captures
  const cbParams: ValType[] = [{ kind: "externref" }]; // captures param
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    cbParams.push(resolveWasmType(ctx, paramType));
  }

  const sig = ctx.checker.getSignatureFromDeclaration(arrow);
  let cbReturnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      cbReturnType = resolveWasmType(ctx, retType);
    }
  }

  const cbResults: ValType[] = cbReturnType ? [cbReturnType] : [];
  const cbTypeIdx = addFuncType(ctx, cbParams, cbResults, `${cbName}_type`);

  const cbFctx: FunctionContext = {
    name: cbName,
    params: [
      { name: "__captures", type: { kind: "externref" } },
      ...arrow.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: cbParams[i + 1] ?? { kind: "f64" as const },
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: cbReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    enclosingClassName: fctx.enclosingClassName ?? resolveEnclosingClassName(fctx),
  };

  // Register params as locals (param 0 = __captures, then arrow params)
  for (let i = 0; i < cbFctx.params.length; i++) {
    cbFctx.localMap.set(cbFctx.params[i]!.name, i);
  }

  // 4. Extract captures from struct into locals at start of __cb_N body
  if (captures.length > 0) {
    // Convert externref captures → anyref → ref $__cb_cap_N
    const capLocal = allocLocal(cbFctx, `__cap_ref`, { kind: "ref", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.get", index: 0 }); // __captures externref
    cbFctx.body.push({ op: "any.convert_extern" });
    cbFctx.body.push({ op: "ref.cast", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.set", index: capLocal });

    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i]!;
      const localIdx = allocLocal(cbFctx, cap.name, cap.type);
      cbFctx.body.push({ op: "local.get", index: capLocal });
      cbFctx.body.push({ op: "struct.get", typeIdx: capStructTypeIdx, fieldIdx: i });
      cbFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // 5. Compile the callback body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = cbFctx;

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, cbFctx, arrow, 1 /* skip __captures */);

  // Emit destructuring code for binding pattern parameters
  for (let i = 0; i < arrow.parameters.length; i++) {
    const param = arrow.parameters[i]!;
    if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
      emitArrowParamDestructuring(ctx, cbFctx, param, 1 + i, cbParams[i + 1] ?? { kind: "f64" });
    }
  }

  let exprBodyHasReturnValue = false;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, cbFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, cbFctx, body);
    if (exprType !== null && cbReturnType) {
      // Expression result is the return value — already on stack
      exprBodyHasReturnValue = true;
    } else if (exprType !== null) {
      cbFctx.body.push({ op: "drop" });
    }
  }

  if (cbReturnType && !exprBodyHasReturnValue) {
    const lastInstr = cbFctx.body[cbFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (cbReturnType.kind === "f64") {
        cbFctx.body.push({ op: "f64.const", value: 0 });
      } else if (cbReturnType.kind === "i32") {
        cbFctx.body.push({ op: "i32.const", value: 0 });
      } else if (cbReturnType.kind === "externref") {
        cbFctx.body.push({ op: "ref.null.extern" });
      }
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 6. Register and export the callback function
  const cbFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: cbName,
    typeIdx: cbTypeIdx,
    locals: cbFctx.locals,
    body: cbFctx.body,
    exported: true,
  });
  ctx.funcMap.set(cbName, cbFuncIdx);
  ctx.mod.exports.push({
    name: cbName,
    desc: { kind: "func", index: cbFuncIdx },
  });

  // 7. At creation site: push cbId + captures externref, call __make_callback
  const makeCallbackIdx = ctx.funcMap.get("__make_callback");
  if (makeCallbackIdx === undefined) {
    ctx.errors.push({
      message: "Missing __make_callback import",
      line: getLine(arrow),
      column: getCol(arrow),
    });
    return null;
  }

  fctx.body.push({ op: "i32.const", value: cbId });

  if (captures.length > 0) {
    // Push captured locals and create struct
    for (const cap of captures) {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
    fctx.body.push({ op: "struct.new", typeIdx: capStructTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: makeCallbackIdx });
  return { kind: "externref" };
}

/**
 * Look up a function's parameter and result types from its index.
 */
export function getFuncSignature(ctx: CodegenContext, funcIdx: number): { params: ValType[]; results: ValType[] } | null {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func") return { params: typeDef.params, results: typeDef.results };
          return null;
        }
        importFuncCount++;
      }
    }
  } else {
    const localIdx = funcIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) {
      const typeDef = ctx.mod.types[func.typeIdx];
      if (typeDef?.kind === "func") return { params: typeDef.params, results: typeDef.results };
    }
  }
  return null;
}

/**
 * Get or create the closure struct type and lifted func type for wrapping
 * plain functions with a given signature. Struct type and func type are shared
 * across all functions with the same signature, but each function gets its own
 * trampoline.
 */
export function getOrCreateFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
): { structTypeIdx: number; liftedFuncTypeIdx: number; closureInfo: ClosureInfo } | null {
  // Build cache key from param types and result types
  const sigKey = `${userParams.map(p => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map(r => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;

  const cached = ctx.funcRefWrapperCache.get(sigKey);
  if (cached) {
    return { structTypeIdx: cached.structTypeIdx, liftedFuncTypeIdx: cached.funcTypeIdx, closureInfo: cached };
  }

  // Create the closure struct type: just (field $func funcref), no captures.
  // Mark as non-final (superTypeIdx = -1) so closures with captures can be
  // subtypes of this wrapper struct, enabling ref.cast to succeed at call sites.
  const closureName = `__fn_wrap_${ctx.closureCounter++}`;
  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
  ];
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
    superTypeIdx: -1, // non-final, no parent — allows subtypes
  });

  // Create the lifted function type: (ref $struct, ...userParams) -> results
  const liftedParams: ValType[] = [
    { kind: "ref", typeIdx: structTypeIdx },
    ...userParams,
  ];
  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, resultTypes, `${closureName}_type`);

  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.funcRefWrapperCache.set(sigKey, closureInfo);

  return { structTypeIdx, liftedFuncTypeIdx, closureInfo };
}

/**
 * Emit a closure struct wrapping a plain function. Creates a per-function
 * trampoline that delegates to the original function.  Struct types are shared
 * across functions with the same signature so they can be reassigned.
 * Pushes the closure struct ref onto the stack and returns its type.
 */
export function emitFuncRefAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
): ValType | null {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return null;

  // Skip functions with nested-func captures (their first N params are capture values
  // from the enclosing scope, which can't be threaded through a generic trampoline)
  const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
  if (nestedCaptures && nestedCaptures.length > 0) return null;

  const userParams = sig.params;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, sig.results);
  if (!wrapperTypes) return null;

  const { structTypeIdx, liftedFuncTypeIdx, closureInfo } = wrapperTypes;

  // Create a trampoline function for THIS specific function.
  // The trampoline takes (self, ...userParams) and calls the original function.
  const trampolineName = `__fn_tramp_${funcName}_${ctx.closureCounter++}`;
  const trampolineBody: Instr[] = [];

  // Push the user-visible params (skip self at param 0)
  for (let i = 0; i < userParams.length; i++) {
    trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
  }
  trampolineBody.push({ op: "call", funcIdx } as Instr);

  const trampolineFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: trampolineName,
    typeIdx: liftedFuncTypeIdx,
    locals: [],
    body: trampolineBody,
    exported: false,
  });
  ctx.funcMap.set(trampolineName, trampolineFuncIdx);

  // Emit: ref.func $trampoline, struct.new $closure_struct
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  return { kind: "ref", typeIdx: structTypeIdx };
}
