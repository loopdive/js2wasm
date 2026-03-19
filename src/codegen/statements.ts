import ts from "typescript";
import { isStringType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  coerceType,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileExpression,
  emitBoundsCheckedArrayGet,
  emitCoercedLocalSet,
  valTypesMatch,
} from "./expressions.js";
import type { CodegenContext, FunctionContext } from "./index.js";
import {
  addFuncType,
  addStringImports,
  addUnionImports,
  allocLocal,
  attachSourcePos,
  collectClassDeclaration,
  compileClassBodies,
  ensureExnTag,
  ensureI32Condition,
  ensureNativeStringHelpers,
  ensureStructForType,
  nativeStringType,
  getArrTypeIdxFromVec,
  getLocalType,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  getSourcePos,
  localGlobalIdx,
  reportError,
  resolveWasmType,
  pushBody,
  popBody,
} from "./index.js";

/**
 * Infer the element type of an `Array<any>` variable by scanning how it is used.
 * Walks the enclosing function for `arr[i] = value` and `arr.push(value)` patterns,
 * returns a concrete wasm vec type if a non-any element type is found.
 */
function inferArrayVecType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const varName = decl.name.text;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = decl;
  while (scope && !ts.isFunctionDeclaration(scope) && !ts.isFunctionExpression(scope)
         && !ts.isArrowFunction(scope) && !ts.isMethodDeclaration(scope)
         && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return;

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
  if (!inferredElemType) return null;

  // Resolve the inferred element type to a wasm type, then register the vec
  const elemWasm = resolveWasmType(ctx, inferredElemType);
  const elemKey =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Mark the first instruction emitted for a statement with its source position.
 * Captures body length before, then after the statement is compiled,
 * attaches the source position to the first new instruction (if any).
 */
function markStatementPos(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
  compile: () => void,
): void {
  const pos = getSourcePos(ctx, stmt);
  const bodyLenBefore = fctx.body.length;
  compile();
  if (pos && fctx.body.length > bodyLenBefore) {
    attachSourcePos(fctx.body[bodyLenBefore]!, pos);
  }
}

/** Compile a statement, appending instructions to the function body */
export function compileStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
): void {
  try {
    compileStatementInner(ctx, fctx, stmt);
  } catch (e) {
    // Defensive: catch any unhandled crash in statement compilation
    const msg = e instanceof Error ? e.message : String(e);
    ctx.errors.push({
      message: `Internal error compiling statement: ${msg}`,
      line: getLine(stmt),
      column: getCol(stmt),
    });
  }
}

function compileStatementInner(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
): void {
  // Skip import declarations — module imports not supported
  if (ts.isImportDeclaration(stmt)) return;

  if (ts.isVariableStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileVariableStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isReturnStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileReturnStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isIfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileIfStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isWhileStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileWhileStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isForStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileForStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
    return;
  }

  if (ts.isExpressionStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => {
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      // Drop the result if the expression left something on the stack
      if (resultType !== null) {
        fctx.body.push({ op: "drop" });
      }
    });
    return;
  }

  if (ts.isDoStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileDoWhileStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isSwitchStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileSwitchStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isForOfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileForOfStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isForInStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileForInStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isLabeledStatement(stmt)) {
    compileLabeledStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isBreakStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileBreakStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isContinueStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileContinueStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isThrowStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileThrowStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isTryStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () =>
      compileTryStatement(ctx, fctx, stmt),
    );
    return;
  }

  if (ts.isFunctionDeclaration(stmt)) {
    // Skip if already hoisted (pre-compiled in function hoisting pass)
    if (stmt.name && ctx.funcMap.has(stmt.name.text)) return;
    // Re-attempt compilation even if hoisting failed — the failure may have been
    // due to const/let captures not yet in scope during the hoisting pre-pass.
    // Now that we're in statement order, those locals should be available.
    compileNestedFunctionDeclaration(ctx, fctx, stmt);
    return;
  }

  // ClassDeclaration in statement position (e.g., inside for loops, if blocks,
  // switch cases, labeled statements, try/catch/finally, etc.)
  if (ts.isClassDeclaration(stmt)) {
    compileNestedClassDeclaration(ctx, stmt);
    return;
  }

  // Empty statement (`;`) — no-op
  if (stmt.kind === ts.SyntaxKind.EmptyStatement) {
    return;
  }

  ctx.errors.push({
    message: `Unsupported statement: ${ts.SyntaxKind[stmt.kind]}`,
    line: getLine(stmt),
    column: getCol(stmt),
  });
}

/** String methods that return a host array (externref) rather than a wasm GC array.
 *  Variables initialized from these calls use externref instead of the GC vec struct
 *  that resolveWasmType would produce for the TS return type (e.g. string[]). */
const HOST_ARRAY_STRING_METHODS = new Set(["split"]);

/** Check if an expression is a string method call that returns a host array (externref). */
function isStringMethodReturningHostArray(ctx: CodegenContext, expr: ts.Expression): boolean {
  // In fast mode with native strings, split returns a native string array, not externref
  if (ctx.fast && ctx.nativeStrTypeIdx >= 0) return false;
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  if (!HOST_ARRAY_STRING_METHODS.has(method)) return false;
  const receiverType = ctx.checker.getTypeAtLocation(expr.expression.expression);
  return isStringType(receiverType);
}

function compileVariableStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
): void {
  for (const decl of stmt.declarationList.declarations) {
    if (ts.isObjectBindingPattern(decl.name)) {
      compileObjectDestructuring(ctx, fctx, decl);
      continue;
    }

    if (ts.isArrayBindingPattern(decl.name)) {
      compileArrayDestructuring(ctx, fctx, decl);
      continue;
    }

    if (!ts.isIdentifier(decl.name)) {
      ctx.errors.push({
        message: "Destructuring not supported",
        line: getLine(decl),
        column: getCol(decl),
      });
      continue;
    }

    const name = decl.name.text;

    // Class expression: const C = class { ... } — skip, already handled as class declaration
    if (decl.initializer && ts.isClassExpression(decl.initializer)) {
      continue;
    }

    // For arrow/function expression initializers, compile the expression first
    // to get the actual closure struct ref type (resolveWasmType returns externref
    // for function types, but closures need ref $struct)
    if (
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) ||
        ts.isFunctionExpression(decl.initializer))
    ) {
      const actualType = compileExpression(ctx, fctx, decl.initializer);
      const closureType = actualType ?? { kind: "externref" as const };

      // If this is a module-level variable, also store in the module global
      // so other functions can access the closure via global.get.
      const modGlobalIdx = ctx.moduleGlobals.get(name);
      if (modGlobalIdx !== undefined) {
        // Update the global's type to match the actual closure ref type
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, modGlobalIdx)];
        if (globalDef) {
          const nullableType: ValType = closureType.kind === "ref"
            ? { kind: "ref_null", typeIdx: (closureType as { typeIdx: number }).typeIdx }
            : closureType;
          globalDef.type = nullableType;
          // Also fix the init expression to match the new type
          if (nullableType.kind === "ref_null") {
            globalDef.init = [{ op: "ref.null", typeIdx: (nullableType as { typeIdx: number }).typeIdx }];
          }
        }
        // Duplicate value on stack: one for the global, one for the local
        const localIdx = allocLocal(fctx, name, closureType);
        fctx.body.push({ op: "local.tee", index: localIdx });
        fctx.body.push({ op: "global.set", index: modGlobalIdx });
      } else {
        const localIdx = allocLocal(fctx, name, closureType);
        emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
      }
      continue;
    }

    // For object literal initializers with computed property names that TS
    // cannot resolve (resulting in 0 type properties), compile the expression
    // first to get the actual struct ref type. Similar to arrow function handling.
    if (
      decl.initializer &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      decl.initializer.properties.some(
        (p) => ts.isPropertyAssignment(p) && p.name && ts.isComputedPropertyName(p.name)
      )
    ) {
      const varType2 = ctx.checker.getTypeAtLocation(decl);
      const tsProps = varType2.getProperties();
      // Only use this path when TS cannot resolve any properties
      // (i.e. all properties are computed and non-resolvable)
      const hasUnresolvedComputed = tsProps.length < decl.initializer.properties.length;
      if (hasUnresolvedComputed) {
        const actualType = compileExpression(ctx, fctx, decl.initializer);
        const objType = actualType ?? { kind: "externref" as const };
        const localIdx = allocLocal(fctx, name, objType);
        fctx.body.push({ op: "local.set", index: localIdx });
        continue;
      }
    }

    // Check if this is a module-level global (already registered)
    const moduleGlobalIdx = ctx.moduleGlobals.get(name);
    if (moduleGlobalIdx !== undefined) {
      // Shape-inferred array-like: compile {} as empty vec struct
      const shapeInfo = ctx.shapeMap.get(name);
      if (shapeInfo && decl.initializer) {
        // Create an empty vec struct: struct.new(length=0, data=array.new_default(4))
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 4 }); // initial capacity
        fctx.body.push({ op: "array.new_default", typeIdx: shapeInfo.arrTypeIdx } as Instr);
        fctx.body.push({ op: "struct.new", typeIdx: shapeInfo.vecTypeIdx });
        fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        continue;
      }
      // Module global: compile initializer and set global
      if (decl.initializer) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        const wasmType =
          globalDef?.type ??
          resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
        compileExpression(ctx, fctx, decl.initializer, wasmType);
        fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
      }
      continue;
    }

    const varType = ctx.checker.getTypeAtLocation(decl);
    // If the variable is an untyped Array<any> (e.g. `var x = new Array()`),
    // infer the element type from how the variable is used in the function.
    let inferredVecType: ValType | null = null;
    if (varType.flags & ts.TypeFlags.Object) {
      const sym = (varType as ts.TypeReference).symbol ?? (varType as ts.Type).symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
        if (typeArgs?.[0] && (typeArgs[0].flags & ts.TypeFlags.Any)) {
          inferredVecType = inferArrayVecType(ctx, decl);
        }
      }
    }
    // Override type for string methods returning host arrays (e.g. split() returns
    // externref but TS types as string[] which resolveWasmType maps to GC vec struct)
    // Check if this variable has widened properties (empty obj with later prop assignments)
    const widenedStructName = ctx.widenedVarStructMap.get(name);
    const widenedTypeIdx = widenedStructName !== undefined ? ctx.structMap.get(widenedStructName) : undefined;
    const wasmType = widenedTypeIdx !== undefined
      ? { kind: "ref_null" as const, typeIdx: widenedTypeIdx }
      : inferredVecType
        ?? ((decl.initializer && isStringMethodReturningHostArray(ctx, decl.initializer))
          ? { kind: "externref" as const }
          : resolveWasmType(ctx, varType));

    // If this var was already pre-hoisted at function entry, reuse that slot.
    const existingIdx = fctx.localMap.get(name);
    const isVar = !(decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    const localIdx = (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length)
      ? existingIdx
      : allocLocal(fctx, name, wasmType);

    // If we reused a pre-hoisted slot but inference found a more precise type
    // (e.g. Array<any> hoisted as vec_externref, but inferred as vec_f64),
    // update the local's type so it matches what the initializer will produce.
    if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
      const localSlot = fctx.locals[existingIdx - fctx.params.length];
      if (localSlot
          && (wasmType.kind !== localSlot.type.kind
              || (wasmType as any).typeIdx !== (localSlot.type as any).typeIdx)) {
        localSlot.type = wasmType;
      }
    }

    if (decl.initializer) {
      // Check if the variable has a callable type (function reference).
      // If so, compile without an externref hint to preserve the closure ref type.
      const callSigs = varType.getCallSignatures?.();
      const isCallable = callSigs && callSigs.length > 0 && wasmType.kind === "externref";
      let stackType: ValType = wasmType;
      if (isCallable) {
        // Compile without type hint to get the actual closure/ref type
        const actualType = compileExpression(ctx, fctx, decl.initializer);
        const closureType = actualType ?? { kind: "externref" as const };
        // If the result is a closure ref, update the local's type
        if ((closureType.kind === "ref" || closureType.kind === "ref_null") &&
            ctx.closureInfoByTypeIdx.has((closureType as { typeIdx: number }).typeIdx)) {
          // Update the local slot type to the actual closure type
          if (localIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot) localSlot.type = closureType;
          }
          stackType = closureType;
        } else if (closureType.kind === "externref" && callSigs!.length > 0) {
          // The initializer returned externref but the type is callable.
          // This happens when a function returns a closure coerced to externref.
          // Find the matching closure info by comparing the TS call signature
          // against registered closure types and unbox (any.convert_extern + ref.cast).
          const sig = callSigs![0]!;
          const sigParamCount = sig.parameters.length;
          const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
          const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
          const sigParamWasmTypes: ValType[] = [];
          for (let i = 0; i < sigParamCount; i++) {
            const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
            sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
          }

          let matchedClosureInfo: { structTypeIdx: number; info: typeof ctx.closureInfoByTypeIdx extends Map<number, infer V> ? V : never } | undefined;
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
              matchedClosureInfo = { structTypeIdx: typeIdx, info };
              break;
            }
          }

          if (matchedClosureInfo) {
            // Convert externref back to closure struct ref
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            fctx.body.push({ op: "ref.cast", typeIdx: matchedClosureInfo.structTypeIdx } as Instr);
            const castType: ValType = { kind: "ref", typeIdx: matchedClosureInfo.structTypeIdx };
            if (localIdx >= fctx.params.length) {
              const localSlot = fctx.locals[localIdx - fctx.params.length];
              if (localSlot) localSlot.type = castType;
            }
            stackType = castType;
          } else {
            stackType = closureType;
          }
        } else {
          stackType = closureType;
        }
      } else {
        const resultType = compileExpression(ctx, fctx, decl.initializer, wasmType);
        stackType = resultType ?? wasmType;
        // Coerce if the expression produced a type that doesn't match the local
        if (resultType && !valTypesMatch(resultType, wasmType)) {
          coerceType(ctx, fctx, resultType, wasmType);
          stackType = wasmType; // after coercion, stack is wasmType
        }
      }
      emitCoercedLocalSet(ctx, fctx, localIdx, stackType);
    }
  }
}

/**
 * Ensure all binding names in a destructuring pattern are allocated as locals.
 * This is a safety net: if the actual destructuring compilation fails, the
 * identifiers will still be in scope (initialized to their zero/null defaults).
 * For `var` declarations these are already hoisted, but `let`/`const` are not.
 */
export function ensureBindingLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      if (ctx.moduleGlobals.has(name)) continue;
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      allocLocal(fctx, name, wasmType);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      ensureBindingLocals(ctx, fctx, element.name);
    }
  }
}

function compileObjectDestructuring(
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
    for (const [sName, sIdx] of ctx.structMap) {
      if (sIdx === actualTypeIdx) {
        typeName = sName;
        structTypeIdx = sIdx;
        fields = ctx.structFields.get(sName);
        break;
      }
    }
  }

  // Fallback to TS checker resolution if resultType didn't give us a struct
  if (structTypeIdx === undefined || !fields) {
    const initType = ctx.checker.getTypeAtLocation(decl.initializer);
    const symName = initType.symbol?.name;
    typeName =
      symName &&
      symName !== "__type" &&
      symName !== "__object" &&
      ctx.structMap.has(symName)
        ? symName
        : (ctx.anonTypeMap.get(initType) ?? symName);

    // Auto-register anonymous object types (same as expression-level destructuring)
    if (
      typeName &&
      (typeName === "__type" || typeName === "__object") &&
      !ctx.anonTypeMap.has(initType) &&
      initType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, initType);
      typeName = ctx.anonTypeMap.get(initType) ?? typeName;
    }

    if (!typeName) {
      fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
      ensureBindingLocals(ctx, fctx, pattern);
      ctx.errors.push({
        message: "Cannot destructure: unknown type",
        line: getLine(decl),
        column: getCol(decl),
      });
      return;
    }

    structTypeIdx = ctx.structMap.get(typeName);
    fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) {
      fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
      ensureBindingLocals(ctx, fctx, pattern);
      ctx.errors.push({
        message: `Cannot destructure: not a known struct type: ${typeName}`,
        line: getLine(decl),
        column: getCol(decl),
      });
      return;
    }
  }

  // Save the struct ref into a temp local so we can access fields multiple times
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard: if the source is nullable (ref_null), skip destructuring when null
  const isNullableRef = resultType.kind === "ref_null";
  const savedBodyForGuard = fctx.body;
  const destructInstrs: Instr[] = [];
  fctx.body = destructInstrs;

  // For each binding element, create a local and extract the field
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    const propNameNode = element.propertyName ?? element.name;
    const propName = ts.isIdentifier(propNameNode) ? propNameNode
      : ts.isStringLiteral(propNameNode) ? propNameNode
      : ts.isNumericLiteral(propNameNode) ? propNameNode
      : undefined;

    // Handle nested binding patterns: const { b: { c, d } } = obj
    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      const nestedPropName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName : undefined;
      if (!nestedPropName) {
        ensureBindingLocals(ctx, fctx, element.name);
        continue;
      }
      const nFieldIdx = fields.findIndex((f) => f.name === nestedPropName.text);
      if (nFieldIdx === -1) {
        ensureBindingLocals(ctx, fctx, element.name);
        continue;
      }
      const nFieldType = fields[nFieldIdx]!.type;
      const nestedTmp = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, nFieldType);
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: nFieldIdx });
      fctx.body.push({ op: "local.set", index: nestedTmp });

      // Recursively destructure the nested value (with null guard for ref_null)
      if (ts.isObjectBindingPattern(element.name) && (nFieldType.kind === "ref" || nFieldType.kind === "ref_null")) {
        const nestedTypeIdx = (nFieldType as { typeIdx: number }).typeIdx;
        let nestedStructName: string | undefined;
        for (const [sName, sIdx] of ctx.structMap) {
          if (sIdx === nestedTypeIdx) { nestedStructName = sName; break; }
        }
        const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
        if (nestedFields) {
          const nestedInstrs: Instr[] = [];
          const savedNestedBody = fctx.body;
          fctx.body = nestedInstrs;
          for (const ne of element.name.elements) {
            if (!ts.isBindingElement(ne)) continue;
            if (!ts.isIdentifier(ne.name)) continue;
            const nePropNode = ne.propertyName ?? ne.name;
            const nePropText = ts.isIdentifier(nePropNode) ? nePropNode.text
              : ts.isStringLiteral(nePropNode) ? nePropNode.text
              : undefined;
            if (!nePropText) continue;
            const neLocalName = ne.name.text;
            const neFieldIdx = nestedFields.findIndex((f) => f.name === nePropText);
            if (neFieldIdx === -1) continue;
            const neFieldType = nestedFields[neFieldIdx]!.type;
            const neLocalIdx = allocLocal(fctx, neLocalName, neFieldType);
            fctx.body.push({ op: "local.get", index: nestedTmp });
            fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: neFieldIdx });
            fctx.body.push({ op: "local.set", index: neLocalIdx });
          }
          fctx.body = savedNestedBody;
          if (nFieldType.kind === "ref_null" && nestedInstrs.length > 0) {
            fctx.body.push({ op: "local.get", index: nestedTmp });
            fctx.body.push({ op: "ref.is_null" } as Instr);
            fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: nestedInstrs });
          } else {
            fctx.body.push(...nestedInstrs);
          }
        } else {
          ensureBindingLocals(ctx, fctx, element.name);
        }
      } else if (ts.isArrayBindingPattern(element.name) && (nFieldType.kind === "ref" || nFieldType.kind === "ref_null")) {
        const nestedVecTypeIdx = (nFieldType as { typeIdx: number }).typeIdx;
        const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
        const nestedArrDef = ctx.mod.types[nestedArrTypeIdx];
        if (nestedArrDef && nestedArrDef.kind === "array") {
          const nestedElemType = nestedArrDef.element;
          const nestedArrInstrs: Instr[] = [];
          const savedNestedArrBody = fctx.body;
          fctx.body = nestedArrInstrs;
          for (let j = 0; j < element.name.elements.length; j++) {
            const ne = element.name.elements[j]!;
            if (ts.isOmittedExpression(ne)) continue;
            if (!ts.isIdentifier((ne as ts.BindingElement).name)) continue;
            const neName = ((ne as ts.BindingElement).name as ts.Identifier).text;
            const neLocalIdx = allocLocal(fctx, neName, nestedElemType);
            fctx.body.push({ op: "local.get", index: nestedTmp });
            fctx.body.push({ op: "struct.get", typeIdx: nestedVecTypeIdx, fieldIdx: 1 });
            fctx.body.push({ op: "i32.const", value: j });
            fctx.body.push({ op: "array.get", typeIdx: nestedArrTypeIdx });
            fctx.body.push({ op: "local.set", index: neLocalIdx });
          }
          fctx.body = savedNestedArrBody;
          if (nFieldType.kind === "ref_null" && nestedArrInstrs.length > 0) {
            fctx.body.push({ op: "local.get", index: nestedTmp });
            fctx.body.push({ op: "ref.is_null" } as Instr);
            fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: nestedArrInstrs });
          } else {
            fctx.body.push(...nestedArrInstrs);
          }
        } else {
          ensureBindingLocals(ctx, fctx, element.name);
        }
      } else {
        ensureBindingLocals(ctx, fctx, element.name);
      }
      continue;
    }

    // Handle rest element: const { a, ...rest } = obj
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        const restName = element.name.text;
        if (!fctx.localMap.has(restName) && !ctx.moduleGlobals.has(restName)) {
          allocLocal(fctx, restName, { kind: "externref" });
        }
      }
      continue;
    }

    if (!ts.isIdentifier(element.name)) continue;
    const localName = element.name.text;

    if (!propName) continue;
    const propNameText = propName.text;
    const fieldIdx = fields.findIndex((f) => f.name === propNameText);
    if (fieldIdx === -1) {
      ctx.errors.push({
        message: `Unknown field in destructuring: ${propNameText}`,
        line: getLine(element),
        column: getCol(element),
      });
      continue;
    }

    const fieldType = fields[fieldIdx]!.type;
    const localIdx = allocLocal(fctx, localName, fieldType);

    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    // Handle default value: `const { x = defaultVal } = obj`
    if (element.initializer && fieldType.kind === "externref") {
      const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.tee", index: tmpField });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(() => {
            const saved = fctx.body;
            fctx.body = [];
            compileExpression(ctx, fctx, element.initializer!, fieldType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
            const instrs = fctx.body;
            fctx.body = saved;
            return instrs;
          })(),
        ],
        else: [
          { op: "local.get", index: tmpField } as Instr,
          { op: "local.set", index: localIdx } as Instr,
        ],
      });
    } else if (element.initializer && (fieldType.kind === "f64" || fieldType.kind === "i32")) {
      fctx.body.push({ op: "local.set", index: localIdx });
    } else {
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // Close null guard
  fctx.body = savedBodyForGuard;
  if (isNullableRef && destructInstrs.length > 0) {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: destructInstrs });
  } else {
    fctx.body.push(...destructInstrs);
  }
}

function compileArrayDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (!decl.initializer) return;

  const pattern = decl.name as ts.ArrayBindingPattern;
  const bodyLenBefore = fctx.body.length;

  const resultType = compileExpression(ctx, fctx, decl.initializer);
  if (!resultType) return;

  if (resultType.kind !== "ref" && resultType.kind !== "ref_null") {
    fctx.body.length = bodyLenBefore;
    ensureBindingLocals(ctx, fctx, pattern);
    ctx.errors.push({
      message: "Cannot destructure: not an array type",
      line: getLine(decl),
      column: getCol(decl),
    });
    return;
  }

  const typeIdx = (resultType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle vec struct (array wrapped in {length, data})
  if (!typeDef || typeDef.kind !== "struct") {
    fctx.body.length = bodyLenBefore;
    ensureBindingLocals(ctx, fctx, pattern);
    ctx.errors.push({
      message: "Cannot destructure: not an array type",
      line: getLine(decl),
      column: getCol(decl),
    });
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  const isVecArray = arrDef && arrDef.kind === "array";

  // Check if this is a tuple struct (fields named _0, _1, etc.)
  const isTupleStruct = !isVecArray && typeDef.kind === "struct" &&
    typeDef.fields.length > 0 &&
    typeDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

  // Check if this is a string type (AnyString, NativeString, ConsString)
  const isStringStruct = ctx.fast && ctx.anyStrTypeIdx >= 0 &&
    (typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx || typeIdx === ctx.consStrTypeIdx);

  if (!isVecArray && !isTupleStruct && !isStringStruct) {
    fctx.body.length = bodyLenBefore;
    ensureBindingLocals(ctx, fctx, pattern);
    ctx.errors.push({
      message: "Cannot destructure: vec data is not array",
      line: getLine(decl),
      column: getCol(decl),
    });
    return;
  }

  // String destructuring: use __str_charAt to extract individual characters
  if (isStringStruct) {
    compileStringDestructuring(ctx, fctx, pattern, resultType, bodyLenBefore);
    return;
  }

  // Store ref in temp local
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard: collect destructuring instrs and wrap for ref_null types
  const isNullableArr = resultType.kind === "ref_null";
  const savedBodyForArrGuard = fctx.body;
  const arrDestructInstrs: Instr[] = [];
  fctx.body = arrDestructInstrs;

  if (isTupleStruct) {
    // Tuple destructuring: extract fields directly from the struct by index
    const tupleFields = (typeDef as { fields: { name?: string; type: ValType }[] }).fields;

    // Pre-allocate all binding locals so they exist even when the tuple is
    // shorter than the pattern (e.g. `var [x] = []`) (#379)
    ensureBindingLocals(ctx, fctx, pattern);

    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue;

      if (i >= tupleFields.length) break; // more bindings than tuple fields

      const fieldType = tupleFields[i]!.type;

      // Handle rest element — skip for tuples (not meaningful)
      if (ts.isBindingElement(element) && element.dotDotDotToken) {
        const restName = ts.isIdentifier(element.name)
          ? element.name.text
          : `__rest_${fctx.locals.length}`;
        allocLocal(fctx, restName, { kind: "externref" });
        continue;
      }

      // Handle nested binding patterns
      if (ts.isBindingElement(element) &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
        const nestedLocal = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });
        fctx.body.push({ op: "local.set", index: nestedLocal });
        ensureBindingLocals(ctx, fctx, element.name);
        continue;
      }

      if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
      const localName = element.name.text;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });
      fctx.body.push({ op: "local.set", index: localIdx });
    }

    // Close null guard for tuple path
    fctx.body = savedBodyForArrGuard;
    if (isNullableArr && arrDestructInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: arrDestructInstrs });
    } else {
      fctx.body.push(...arrDestructInstrs);
    }
    return;
  }

  // Vec array destructuring (original path)
  const elemType = arrDef!.element;

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

            const innerRestArrLocal = allocLocal(fctx, `__inner_rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
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
    if (ts.isBindingElement(element) &&
        (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
      // Extract the element value into a temp local
      const nestedLocal = allocLocal(fctx, `__destruct_nested_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);
      fctx.body.push({ op: "local.set", index: nestedLocal });

      // Create a synthetic VariableDeclaration-like node for the nested pattern
      // Instead, just recursively ensure the binding locals are allocated
      ensureBindingLocals(ctx, fctx, element.name);
      // If the element type is a ref, try to destructure it properly
      if (elemType.kind === "ref" || elemType.kind === "ref_null") {
        if (ts.isObjectBindingPattern(element.name)) {
          // Find struct info for the nested element
          const nestedTypeIdx = (elemType as { typeIdx: number }).typeIdx;
          let nestedStructName: string | undefined;
          for (const [name, idx] of ctx.structMap) {
            if (idx === nestedTypeIdx) { nestedStructName = name; break; }
          }
          const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
          if (nestedFields) {
            for (const nestedElem of element.name.elements) {
              if (!ts.isBindingElement(nestedElem)) continue;
              const propNNode = nestedElem.propertyName ?? nestedElem.name;
              const propNText = ts.isIdentifier(propNNode) ? propNNode.text
                : ts.isStringLiteral(propNNode) ? propNNode.text
                : ts.isNumericLiteral(propNNode) ? propNNode.text
                : undefined;
              if (!ts.isIdentifier(nestedElem.name)) continue;
              if (!propNText) continue; // skip computed property names
              const nLocalName = nestedElem.name.text;
              const nFieldIdx = nestedFields.findIndex((f) => f.name === propNText);
              if (nFieldIdx === -1) continue;
              const nFieldType = nestedFields[nFieldIdx]!.type;
              const nLocalIdx = fctx.localMap.get(nLocalName);
              if (nLocalIdx === undefined) continue;
              fctx.body.push({ op: "local.get", index: nestedLocal });
              fctx.body.push({ op: "struct.get", typeIdx: nestedTypeIdx, fieldIdx: nFieldIdx });
              fctx.body.push({ op: "local.set", index: nLocalIdx });
            }
          }
        } else if (ts.isArrayBindingPattern(element.name)) {
          // Nested array destructuring — extract from the nested vec
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
    if (element.initializer && elemType.kind === "externref") {
      const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.tee", index: tmpElem });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(() => {
            const saved = fctx.body;
            fctx.body = [];
            compileExpression(ctx, fctx, element.initializer!, elemType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
            const instrs = fctx.body;
            fctx.body = saved;
            return instrs;
          })(),
        ],
        else: [
          { op: "local.get", index: tmpElem } as Instr,
          { op: "local.set", index: localIdx } as Instr,
        ],
      });
    } else {
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // Close null guard for vec array path
  fctx.body = savedBodyForArrGuard;
  if (isNullableArr && arrDestructInstrs.length > 0) {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: arrDestructInstrs });
  } else {
    fctx.body.push(...arrDestructInstrs);
  }
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
    ctx.errors.push({
      message: "Cannot destructure string: __str_charAt helper not available",
      line: 0,
      column: 0,
    });
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

    // Rest element: const [a, ...rest] = "hello" — rest is not supported for strings yet
    if (ts.isBindingElement(element) && element.dotDotDotToken) {
      // Allocate a local but leave it default-initialized
      if (ts.isIdentifier(element.name)) {
        allocLocal(fctx, element.name.text, { kind: "externref" });
      }
      continue;
    }

    // Nested patterns: skip for strings
    if (ts.isBindingElement(element) &&
        (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
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

function compileReturnStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ReturnStatement,
): void {
  // Inside a generator function, `return` should break out of the body block
  // (not use the wasm `return` opcode, which would skip __create_generator).
  if (ctx.generatorFunctions.has(fctx.name)) {
    // If there's a return expression, evaluate it for side effects but discard the value
    if (stmt.expression) {
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      if (resultType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Break out of the generator body block.
    // generatorReturnDepth tracks the correct br depth accounting for
    // nested loops/blocks that wrap the body instructions.
    const genReturnDepth = fctx.generatorReturnDepth ?? fctx.blockDepth;
    fctx.body.push({ op: "br", depth: genReturnDepth });
    return;
  }

  if (stmt.expression) {
    const exprType = compileExpression(ctx, fctx, stmt.expression, fctx.returnType ?? undefined);
    // Coerce expression result to match function return type if they differ
    if (exprType && fctx.returnType && !valTypesMatch(exprType, fctx.returnType)) {
      coerceType(ctx, fctx, exprType, fctx.returnType);
    }
  } else if (fctx.returnType) {
    // Bare `return;` in a value-returning function — push default value
    if (fctx.returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fctx.returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (fctx.returnType.kind === "externref") fctx.body.push({ op: "ref.null", refType: "extern" } as any);
  }
  fctx.body.push({ op: "return" });
}

/**
 * Detect null-comparison narrowing in an if-condition.
 * Returns the variable name narrowed to non-null and which branch benefits:
 *   - `x !== null` / `x != null` / `null !== x` / `null != x` → narrowed in THEN
 *   - `x === null` / `x == null` / `null === x` / `null == x` → narrowed in ELSE
 * Returns null if the condition is not a null comparison on a simple identifier.
 */
function detectNullNarrowing(
  expr: ts.Expression,
): { varName: string; narrowedBranch: "then" | "else" } | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isNeq =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  const isEq =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken;
  if (!isNeq && !isEq) return null;

  const rightIsNull =
    expr.right.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr.right) && expr.right.text === "undefined");
  const leftIsNull =
    expr.left.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr.left) && expr.left.text === "undefined");

  if (!rightIsNull && !leftIsNull) return null;

  const nonNullSide = rightIsNull ? expr.left : expr.right;
  if (!ts.isIdentifier(nonNullSide)) return null;

  return {
    varName: nonNullSide.text,
    narrowedBranch: isNeq ? "then" : "else",
  };
}

function compileIfStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.IfStatement,
): void {
  // Detect null-narrowing pattern before compiling the condition
  const narrowing = detectNullNarrowing(stmt.expression);

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);

  // The 'if' instruction adds one label level. Increment break/continue depths
  // so that br instructions emitted inside the if branches target the correct labels.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;

  // Save pre-existing narrowed set so we can restore it after each branch
  const savedNarrowedNonNull = fctx.narrowedNonNull
    ? new Set(fctx.narrowedNonNull)
    : undefined;

  // Apply narrowing for the then branch
  if (narrowing && narrowing.narrowedBranch === "then") {
    if (!fctx.narrowedNonNull) fctx.narrowedNonNull = new Set();
    fctx.narrowedNonNull.add(narrowing.varName);
  }

  // Compile then branch
  const savedBody = pushBody(fctx);
  if (ts.isBlock(stmt.thenStatement)) {
    for (const s of stmt.thenStatement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.thenStatement);
  }
  const thenInstrs = fctx.body;

  // Restore narrowing before compiling else branch
  fctx.narrowedNonNull = savedNarrowedNonNull
    ? new Set(savedNarrowedNonNull)
    : undefined;

  // Apply narrowing for the else branch
  if (narrowing && narrowing.narrowedBranch === "else") {
    if (!fctx.narrowedNonNull) fctx.narrowedNonNull = new Set();
    fctx.narrowedNonNull.add(narrowing.varName);
  }

  // Compile else branch
  let elseInstrs: Instr[] | undefined;
  if (stmt.elseStatement) {
    fctx.body = [];
    if (ts.isBlock(stmt.elseStatement)) {
      for (const s of stmt.elseStatement.statements) {
        compileStatement(ctx, fctx, s);
      }
    } else {
      compileStatement(ctx, fctx, stmt.elseStatement);
    }
    elseInstrs = fctx.body;
  }

  popBody(fctx, savedBody);

  // Restore original narrowing state (leaving the if block clears narrowing)
  fctx.narrowedNonNull = savedNarrowedNonNull;

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenInstrs,
    else: elseInstrs,
  });
}

function compileWhileStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.WhileStatement,
): void {
  // block $break
  //   loop $continue
  //     <condition>
  //     i32.eqz
  //     br_if $break (depth to block)
  //     <body>
  //     br $continue (depth to loop)
  //   end
  // end

  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;

  // Track break/continue depths
  // Inside the generated structure, br 1 = break, br 0 = continue
  fctx.breakStack.push(1); // break: exit the outer block
  fctx.continueStack.push(0); // continue: restart the loop

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break out of block

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop
  const loopBody = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

function compileForStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForStatement,
): void {
  // Compile initializer (outside the loop)
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      const isVar = !(stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
      for (const decl of stmt.initializer.declarations) {
        if (ts.isObjectBindingPattern(decl.name)) {
          compileObjectDestructuring(ctx, fctx, decl);
          continue;
        }
        if (ts.isArrayBindingPattern(decl.name)) {
          compileArrayDestructuring(ctx, fctx, decl);
          continue;
        }
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;

        // Check if this variable is a module-level global (e.g., for(var i...)
        // at the top level). If so, use global.set instead of local.set.
        const moduleGlobalIdx = ctx.moduleGlobals.get(name);
        if (moduleGlobalIdx !== undefined) {
          if (decl.initializer) {
            const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
            const wasmType =
              globalDef?.type ??
              resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
            compileExpression(ctx, fctx, decl.initializer, wasmType);
            fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
          }
          continue;
        }

        // Class expression: skip, already handled as class declaration
        if (decl.initializer && ts.isClassExpression(decl.initializer)) {
          continue;
        }

        // Arrow/function expression: compile first to get closure struct ref type
        if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const closureType = actualType ?? { kind: "externref" as const };
          // Reuse existing local for var re-declaration
          const existingIdx = fctx.localMap.get(name);
          const localIdx = (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length)
            ? existingIdx
            : allocLocal(fctx, name, closureType);
          // Update local type if hoisted slot has a less precise type
          if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot) localSlot.type = closureType;
          }
          emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
          continue;
        }

        const varType = ctx.checker.getTypeAtLocation(decl);
        const wasmType = resolveWasmType(ctx, varType);
        // Reuse existing local for var re-declaration
        const existingIdx = fctx.localMap.get(name);
        const localIdx = (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length)
          ? existingIdx
          : allocLocal(fctx, name, wasmType);
        // If reusing a pre-hoisted slot, update the local's type to match
        if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
          const localSlot = fctx.locals[localIdx - fctx.params.length];
          if (localSlot && !valTypesMatch(wasmType, localSlot.type)) {
            localSlot.type = wasmType;
          }
        }
        if (decl.initializer) {
          const forInitType = compileExpression(ctx, fctx, decl.initializer, wasmType);
          if (forInitType && !valTypesMatch(forInitType, wasmType)) {
            coerceType(ctx, fctx, forInitType, wasmType);
          }
          emitCoercedLocalSet(ctx, fctx, localIdx, forInitType ?? wasmType);
        }
      }
    } else {
      const resultType = compileExpression(ctx, fctx, stmt.initializer);
      if (resultType !== null) fctx.body.push({ op: "drop" });
    }
  }

  // Loop structure:
  // block $break {                    ; break target (depth 2 from body)
  //   loop $loop {                    ; loop restart (continue outer target)
  //     condition_check
  //     block $continue {             ; continue target (depth 0 from body)
  //       body
  //     }
  //     incrementor
  //     br $loop
  //   }
  // }
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to incrementor)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Condition (inside $loop, before $continue block)
  const condInstrs: Instr[] = [];
  if (stmt.condition) {
    const condBody = fctx.body;
    fctx.body = [];
    const condType = compileExpression(ctx, fctx, stmt.condition);
    ensureI32Condition(fctx, condType, ctx);
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "br_if", depth: 1 }); // break: exits $break (depth 1 from $loop body)
    condInstrs.push(...fctx.body);
    fctx.body = condBody;
  }

  // --- Bounds check elimination: detect `i < arr.length` pattern ---
  // When the condition is `indexVar < arrayVar.length` (or `arrayVar.length > indexVar`),
  // mark the pair so element accesses like `arrayVar[indexVar]` can skip bounds checks.
  const savedSafeIndexed = fctx.safeIndexedArrays;
  if (stmt.condition && ts.isBinaryExpression(stmt.condition)) {
    const cond = stmt.condition;
    const op = cond.operatorToken.kind;
    let indexExpr: ts.Expression | undefined;
    let lengthExpr: ts.Expression | undefined;
    // i < arr.length  OR  i <= arr.length - 1
    if (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) {
      indexExpr = cond.left;
      lengthExpr = cond.right;
    }
    // arr.length > i  OR  arr.length >= i + 1
    if (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) {
      indexExpr = cond.right;
      lengthExpr = cond.left;
    }
    if (indexExpr && lengthExpr && ts.isIdentifier(indexExpr) &&
        ts.isPropertyAccessExpression(lengthExpr) &&
        ts.isIdentifier(lengthExpr.name) && lengthExpr.name.text === "length" &&
        ts.isIdentifier(lengthExpr.expression)) {
      const indexVar = indexExpr.text;
      const arrayVar = lengthExpr.expression.text;
      if (!fctx.safeIndexedArrays) {
        fctx.safeIndexedArrays = new Set();
      }
      fctx.safeIndexedArrays.add(arrayVar + ":" + indexVar);
    }
  }

  // Body (inside $continue block)
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

  // Restore previous safeIndexedArrays (scoped to this loop)
  fctx.safeIndexedArrays = savedSafeIndexed;

  // Incrementor (inside $loop, after $continue block)
  fctx.body = [];
  if (stmt.incrementor) {
    const resultType = compileExpression(ctx, fctx, stmt.incrementor);
    if (resultType !== null) fctx.body.push({ op: "drop" });
  }
  const incrInstrs = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;

  popBody(fctx, savedBody);

  // Build the loop body: condition + block $continue { body } + incrementor + br $loop
  const loopBody: Instr[] = [
    ...condInstrs,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    },
    ...incrInstrs,
    { op: "br", depth: 0 }, // restart $loop
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

function compileDoWhileStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.DoStatement,
): void {
  // block $break {                    ; break target (depth 2 from body)
  //   loop $loop {                    ; loop restart
  //     block $continue {             ; continue target (depth 0 from body)
  //       <body>
  //     }
  //     <condition>
  //     br_if $loop                   ; true → restart loop (depth 0 from loop level)
  //   }
  // }

  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to condition)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

  // Compile condition — true means continue looping
  fctx.body = [];
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "br_if", depth: 0 }); // restart $loop if true
  const condInstrs = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;

  popBody(fctx, savedBody);

  // Build: block { loop { block { body } condition br_if } }
  const loopBody: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    },
    ...condInstrs,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

function compileSwitchStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.SwitchStatement,
): void {
  // Evaluate the switch expression and save it to a temp local
  const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
  let wasmType = resolveWasmType(ctx, exprType);

  // Detect if the switch discriminant or any case value involves strings (#245).
  // Check both the discriminant type and case expression types, since the
  // discriminant may be `any` while case values are string literals.
  let switchIsString = isStringType(exprType);
  if (!switchIsString) {
    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        const caseType = ctx.checker.getTypeAtLocation(clause.expression);
        if (isStringType(caseType)) {
          switchIsString = true;
          break;
        }
      }
    }
  }

  // For string switch: use the appropriate string type and comparison
  let strEqFuncIdx: number | undefined;
  if (switchIsString) {
    if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
      // Fast mode: native string comparison
      ensureNativeStringHelpers(ctx);
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
      strEqFuncIdx = equalsIdx;
      wasmType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
    } else {
      // Non-fast mode: externref string comparison via wasm:js-string equals
      addStringImports(ctx);
      strEqFuncIdx = ctx.funcMap.get("equals");
      wasmType = { kind: "externref" };
    }
  } else if (wasmType.kind === "externref") {
    // Externref discriminant (non-string): unbox to f64 for numeric comparison
    wasmType = { kind: "f64" };
  }

  const tmpLocalIdx = allocLocal(fctx, `__sw_${fctx.locals.length}`, wasmType);
  compileExpression(ctx, fctx, stmt.expression, wasmType);
  fctx.body.push({ op: "local.set", index: tmpLocalIdx });

  // Use a "target" local to track which clause index to start executing from.
  // Sentinel value = number of clauses means "no match yet".
  const clauses = stmt.caseBlock.clauses;
  const noMatchSentinel = clauses.length;

  const targetLocalIdx = allocLocal(
    fctx,
    `__sw_target_${fctx.locals.length}`,
    { kind: "i32" },
  );
  // Initialize target to sentinel (no match)
  fctx.body.push({ op: "i32.const", value: noMatchSentinel });
  fctx.body.push({ op: "local.set", index: targetLocalIdx });

  // Choose the equality opcode based on the switch expression type
  const eqOp: "f64.eq" | "i32.eq" =
    wasmType.kind === "i32" ? "i32.eq" : "f64.eq";

  // --- Phase 1: Evaluate all case expressions to find the target clause ---
  // Skip default clauses in this phase; just check case expressions.
  let defaultIdx = -1;
  for (let ci = 0; ci < clauses.length; ci++) {
    const clause = clauses[ci]!;
    if (ts.isDefaultClause(clause)) {
      defaultIdx = ci;
      continue;
    }
    const caseClause = clause as ts.CaseClause;

    // if (target == sentinel) { if (tmp == caseExpr) { target = ci; } }
    const checkBody: Instr[] = [];
    const outerBody = fctx.body;
    fctx.body = checkBody;

    fctx.body.push({ op: "local.get", index: tmpLocalIdx });
    if (switchIsString && ctx.fast && ctx.nativeStrTypeIdx >= 0) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
      fctx.body.push({ op: "call", funcIdx: flattenIdx });
    }
    compileExpression(ctx, fctx, caseClause.expression, wasmType);
    if (switchIsString && ctx.fast && ctx.nativeStrTypeIdx >= 0) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
      fctx.body.push({ op: "call", funcIdx: flattenIdx });
    }
    if (switchIsString && strEqFuncIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: strEqFuncIdx });
    } else {
      fctx.body.push({ op: eqOp });
    }
    // if (comparison result) { target = ci; }
    const setTarget: Instr[] = [
      { op: "i32.const", value: ci },
      { op: "local.set", index: targetLocalIdx },
    ];
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: setTarget,
    });

    fctx.body = outerBody;

    // Guard: only check if target is still sentinel (no match found yet)
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: noMatchSentinel });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: checkBody,
    });
  }

  // After checking all cases: if no case matched, fall to default (if present)
  if (defaultIdx >= 0) {
    const setDefault: Instr[] = [
      { op: "i32.const", value: defaultIdx },
      { op: "local.set", index: targetLocalIdx },
    ];
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: noMatchSentinel });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: setDefault,
    });
  }

  // --- Phase 2: Emit clause bodies with fall-through ---
  // A clause body executes if clauseIndex >= target.
  // We use a "running" local that gets set to 1 once we reach the target
  // and stays 1 for fall-through (until a break resets via br).
  const runningLocalIdx = allocLocal(
    fctx,
    `__sw_running_${fctx.locals.length}`,
    { kind: "i32" },
  );
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: runningLocalIdx });

  // Collect instructions for the switch block body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block adds 1 nesting level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;

  // break from switch => br to outer block (depth 0 from inside the block).
  // Each case body is wrapped in an if (+1 nesting), so break depth = 1.
  const switchBreakIdx = fctx.breakStack.length;
  fctx.breakStack.push(1);

  for (let ci = 0; ci < clauses.length; ci++) {
    const clause = clauses[ci]!;

    // Set running = 1 if this clause is the target
    // if (target == ci) { running = 1; }
    const activateBody: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: runningLocalIdx },
    ];
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: ci });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: activateBody,
    });

    // Emit body: if (running) { <statements> }
    if (clause.statements.length > 0) {
      const bodyInstrs: Instr[] = [];
      const outerBody = fctx.body;
      fctx.body = bodyInstrs;

      // Adjust outer entries for the if-wrapping (+1 nesting level).
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!++;
      for (let i = 0; i < fctx.continueStack.length; i++)
        fctx.continueStack[i]!++;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;

      for (const s of clause.statements) {
        compileStatement(ctx, fctx, s);
      }

      // Restore depths after case body compilation
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!--;
      for (let i = 0; i < fctx.continueStack.length; i++)
        fctx.continueStack[i]!--;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;

      fctx.body = outerBody;

      fctx.body.push({ op: "local.get", index: runningLocalIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: bodyInstrs,
      });
    }
  }

  fctx.breakStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;

  const switchBody = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: switchBody,
  });
}

/**
 * Destructure a for-of element stored in `elemLocal` into the bindings of a
 * destructuring pattern. Handles both object and array binding patterns with
 * default values.
 */
function compileForOfDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
  elemLocal: number,
  elemType: ValType,
  stmt: ts.ForOfStatement,
): void {
  if (ts.isObjectBindingPattern(pattern)) {
    // Resolve the struct type from the element type
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty binding pattern `for (let {} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults
      // or the appropriate undefined sentinel.
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const saved = fctx.body;
          fctx.body = [];
          compileExpression(ctx, fctx, element.initializer, bindingType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const instrs = fctx.body;
          fctx.body = saved;
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx } as unknown as Instr);
          } else {
            fctx.body.push({ op: "ref.null", typeIdx: "extern" } as unknown as Instr);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") {
      ctx.errors.push({
        message: "for-of destructuring: element type is not a struct",
        line: getLine(stmt),
        column: getCol(stmt),
      });
      return;
    }

    // Find the struct fields by looking up the struct name from structMap
    let structName: string | undefined;
    for (const [name, idx] of ctx.structMap) {
      if (idx === structTypeIdx) { structName = name; break; }
    }
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) {
      ctx.errors.push({
        message: "for-of destructuring: cannot find struct fields",
        line: getLine(stmt),
        column: getCol(stmt),
      });
      return;
    }

    // Null guard: collect field extractions for ref_null types
    const savedBodyFOD = fctx.body;
    const fodInstrs: Instr[] = [];
    fctx.body = fodInstrs;

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const propNameNode = element.propertyName ?? element.name;
      const propNameText = ts.isIdentifier(propNameNode) ? propNameNode.text
        : ts.isStringLiteral(propNameNode) ? propNameNode.text
        : ts.isNumericLiteral(propNameNode) ? propNameNode.text
        : undefined;
      if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
      const localName = element.name.text;
      if (!propNameText) continue; // skip computed property names

      const fieldIdx = fields.findIndex((f) => f.name === propNameText);
      if (fieldIdx === -1) {
        // Field not found in struct — property is "undefined" at runtime.
        // Use the default value if one is provided, otherwise use the
        // appropriate "undefined" sentinel for the target type.
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const saved = fctx.body;
          fctx.body = [];
          compileExpression(ctx, fctx, element.initializer, bindingType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const instrs = fctx.body;
          fctx.body = saved;
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx } as unknown as Instr);
          } else {
            fctx.body.push({ op: "ref.null", typeIdx: "extern" } as unknown as Instr);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
        continue;
      }

      const fieldType = fields[fieldIdx]!.type;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Handle default value
      if (element.initializer && fieldType.kind === "externref") {
        const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.tee", index: tmpField });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(() => {
              const saved = fctx.body;
              fctx.body = [];
              compileExpression(ctx, fctx, element.initializer!, fieldType);
              fctx.body.push({ op: "local.set", index: localIdx } as Instr);
              const instrs = fctx.body;
              fctx.body = saved;
              return instrs;
            })(),
          ],
          else: [
            { op: "local.get", index: tmpField } as Instr,
            { op: "local.set", index: localIdx } as Instr,
          ],
        });
      } else if (element.initializer && (fieldType.kind === "f64" || fieldType.kind === "i32")) {
        // For f64/i32 fields, check if value equals the "undefined" sentinel
        // undefined fields in structs are initialized to NaN for f64, 0 for i32
        if (fieldType.kind === "f64") {
          // Check if field value is NaN (undefined marker) — use default if so
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          // NaN !== NaN, so f64.ne with itself detects NaN
          fctx.body.push({ op: "local.get", index: tmpField });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(ctx, fctx, element.initializer!, fieldType);
                fctx.body.push({ op: "local.set", index: localIdx } as Instr);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
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

    // Close null guard for for-of object destructuring
    fctx.body = savedBodyFOD;
    if (elemType.kind === "ref_null" && fodInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fodInstrs });
    } else {
      fctx.body.push(...fodInstrs);
    }
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring in for-of: for (var [a, b] of arr)
    // Element may be a vec struct (array wrapper) OR a tuple struct.

    // Handle externref elements: we cannot destructure opaque references at the
    // Wasm level, so assign "undefined" sentinels or default values to each binding.
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const saved = fctx.body;
          fctx.body = [];
          compileExpression(ctx, fctx, element.initializer, bindingType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const instrs = fctx.body;
          fctx.body = saved;
          fctx.body.push(...instrs);
        } else {
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx } as unknown as Instr);
          } else {
            fctx.body.push({ op: "ref.null", typeIdx: "extern" } as unknown as Instr);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const structDef = ctx.mod.types[structTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTupleStruct = structDef && structDef.kind === "struct" &&
      structDef.fields.length > 0 &&
      structDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    if (isTupleStruct) {
      // Tuple destructuring: extract fields directly from the struct by index
      const tupleFields = (structDef as { fields: { name?: string; type: ValType }[] }).fields;

      // Null guard for for-of tuple destructuring
      const savedBodyFOTD = fctx.body;
      const fotdInstrs: Instr[] = [];
      fctx.body = fotdInstrs;

      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;

        if (i >= tupleFields.length) break; // more bindings than tuple fields

        const fieldType = tupleFields[i]!.type;

        // Handle rest element — skip for tuples
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          const restName = ts.isIdentifier(element.name)
            ? element.name.text
            : `__rest_${fctx.locals.length}`;
          allocLocal(fctx, restName, { kind: "externref" });
          continue;
        }

        // Handle nested binding patterns: for (const [{ a, b }] of arr)
        if (ts.isBindingElement(element) &&
            (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i });
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, fieldType, stmt);
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingWasmType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingWasmType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i });

        if (!valTypesMatch(fieldType, bindingWasmType)) {
          coerceType(ctx, fctx, fieldType, bindingWasmType);
        }

        if (element.initializer && bindingWasmType.kind === "externref") {
          const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, bindingWasmType);
          fctx.body.push({ op: "local.tee", index: tmpElem });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(ctx, fctx, element.initializer!, bindingWasmType);
                fctx.body.push({ op: "local.set", index: localIdx } as Instr);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
            else: [
              { op: "local.get", index: tmpElem } as Instr,
              { op: "local.set", index: localIdx } as Instr,
            ],
          });
        } else if (element.initializer && (bindingWasmType.kind === "f64" || bindingWasmType.kind === "i32")) {
          if (bindingWasmType.kind === "f64") {
            const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, bindingWasmType);
            fctx.body.push({ op: "local.tee", index: tmpField });
            fctx.body.push({ op: "local.get", index: tmpField });
            fctx.body.push({ op: "f64.ne" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...(() => {
                  const saved = fctx.body;
                  fctx.body = [];
                  compileExpression(ctx, fctx, element.initializer!, bindingWasmType);
                  fctx.body.push({ op: "local.set", index: localIdx } as Instr);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                })(),
              ],
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

      // Close null guard for for-of tuple destructuring
      fctx.body = savedBodyFOTD;
      if (elemType.kind === "ref_null" && fotdInstrs.length > 0) {
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fotdInstrs });
      } else {
        fctx.body.push(...fotdInstrs);
      }
      return;
    }

    // Vec array destructuring: element is a vec struct { length, data }
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, structTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      ctx.errors.push({
        message: "for-of array destructuring: element is not an array type",
        line: getLine(stmt),
        column: getCol(stmt),
      });
      return;
    }

    const innerElemType = arrDef.element;

    // Null guard for for-of array destructuring
    const savedBodyFOAD = fctx.body;
    const foadInstrs: Instr[] = [];
    fctx.body = foadInstrs;

    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue;

      // Handle nested binding patterns: for (const [{ a, b }] of arr)
      if (ts.isBindingElement(element) &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
        const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
        fctx.body.push({ op: "local.set", index: nestedLocal });
        compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, innerElemType, stmt);
        continue;
      }

      if (!ts.isIdentifier(element.name)) continue;
      const localName = element.name.text;
      const bindingTsType = ctx.checker.getTypeAtLocation(element);
      const bindingWasmType = resolveWasmType(ctx, bindingTsType);
      const localIdx = allocLocal(fctx, localName, bindingWasmType);

      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

      if (!valTypesMatch(innerElemType, bindingWasmType)) {
        coerceType(ctx, fctx, innerElemType, bindingWasmType);
      }

      if (element.initializer && bindingWasmType.kind === "externref") {
        const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, bindingWasmType);
        fctx.body.push({ op: "local.tee", index: tmpElem });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(() => {
              const saved = fctx.body;
              fctx.body = [];
              compileExpression(ctx, fctx, element.initializer!, bindingWasmType);
              fctx.body.push({ op: "local.set", index: localIdx } as Instr);
              const instrs = fctx.body;
              fctx.body = saved;
              return instrs;
            })(),
          ],
          else: [
            { op: "local.get", index: tmpElem } as Instr,
            { op: "local.set", index: localIdx } as Instr,
          ],
        });
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }

    // Close null guard for for-of array destructuring
    fctx.body = savedBodyFOAD;
    if (elemType.kind === "ref_null" && foadInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: foadInstrs });
    } else {
      fctx.body.push(...foadInstrs);
    }
  }
}

/**
 * Handle assignment destructuring in for-of expression form:
 *   for ({a, b} of arr) — assigns to already-declared variables
 *   for ([x, y] of arr) — assigns to already-declared variables
 */
function compileForOfAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  stmt: ts.ForOfStatement,
): void {
  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of arr) — elem is a struct ref, extract fields
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty destructuring `for ({} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults.
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) continue;
        if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
        const targetName = ts.isShorthandPropertyAssignment(prop)
          ? prop.name.text
          : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer) ? prop.initializer.text
          : ts.isIdentifier(prop.name) ? prop.name.text
          : undefined;
        if (!targetName) continue; // skip computed property names
        const targetLocal = fctx.localMap.get(targetName);
        if (targetLocal === undefined) continue;

        // Property doesn't exist on primitive — use default if provided
        const init = ts.isShorthandPropertyAssignment(prop) ? prop.objectAssignmentInitializer
          : ts.isPropertyAssignment(prop) && prop.initializer && ts.isAssignmentExpression
            ? undefined : undefined;
        if (init) {
          const targetType = getLocalType(fctx, targetLocal);
          const saved = fctx.body;
          fctx.body = [];
          compileExpression(ctx, fctx, init, targetType ?? { kind: "externref" });
          fctx.body.push({ op: "local.set", index: targetLocal } as Instr);
          const instrs = fctx.body;
          fctx.body = saved;
          fctx.body.push(...instrs);
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") return;

    let structName: string | undefined;
    for (const [name, idx] of ctx.structMap) {
      if (idx === structTypeIdx) { structName = name; break; }
    }
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) return;

    for (const prop of expr.properties) {
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
      const propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text
        : undefined;
      if (!propName) continue; // skip computed property names
      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer) ? prop.initializer.text : propName;

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;

      const targetLocal = fctx.localMap.get(targetName);
      if (targetLocal === undefined) continue;

      const fieldType = fields[fieldIdx]!.type;
      const targetType = getLocalType(fctx, targetLocal);
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
      if (targetType && !valTypesMatch(fieldType, targetType)) {
        coerceType(ctx, fctx, fieldType, targetType);
      }
      emitCoercedLocalSet(ctx, fctx, targetLocal, fieldType);
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of arr) — elem is a vec struct or tuple struct, extract by index
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Externref elements: cannot destructure — just skip assignments
      return;
    }

    const innerVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const innerStructDef = ctx.mod.types[innerVecTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTuple = innerStructDef && innerStructDef.kind === "struct" &&
      innerStructDef.fields.length > 0 &&
      innerStructDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    if (isTuple) {
      // Tuple assignment destructuring: extract fields directly
      const tupleFields = (innerStructDef as { fields: { name?: string; type: ValType }[] }).fields;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;
        if (!ts.isIdentifier(el)) continue;
        if (i >= tupleFields.length) break;

        const targetLocal = fctx.localMap.get(el.text);
        if (targetLocal === undefined) continue;

        const fieldType = tupleFields[i]!.type;
        const targetType = getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });
        if (targetType && !valTypesMatch(fieldType, targetType)) {
          coerceType(ctx, fctx, fieldType, targetType);
        }
        fctx.body.push({ op: "local.set", index: targetLocal });
      }
    } else {
      // Vec array assignment destructuring
      const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, innerVecTypeIdx);
      const innerArrDef = ctx.mod.types[innerArrTypeIdx];
      if (!innerArrDef || innerArrDef.kind !== "array") return;

      const innerElemType = innerArrDef.element;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;
        if (!ts.isIdentifier(el)) continue;

        const targetLocal = fctx.localMap.get(el.text);
        if (targetLocal === undefined) continue;

        const targetType = getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
        if (targetType && !valTypesMatch(innerElemType, targetType)) {
          coerceType(ctx, fctx, innerElemType, targetType);
        }
        fctx.body.push({ op: "local.set", index: targetLocal });
      }
      emitCoercedLocalSet(ctx, fctx, targetLocal, innerElemType);
    }
  }
}

function compileForOfStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): void {
  // Check the TS type of the iterable to decide compilation strategy
  const exprTsType = ctx.checker.getTypeAtLocation(stmt.expression);

  // String iteration: for (const c of "hello") iterates characters
  // In fast mode, use native string struct iteration (pure Wasm)
  if (isStringType(exprTsType) && ctx.fast && ctx.anyStrTypeIdx >= 0) {
    compileForOfString(ctx, fctx, stmt);
    return;
  }

  const sym =
    (exprTsType as ts.TypeReference).symbol ??
    (exprTsType as ts.Type).symbol;
  const isArray = sym?.name === "Array";

  if (isArray) {
    compileForOfArray(ctx, fctx, stmt);
  } else {
    compileForOfIterator(ctx, fctx, stmt);
  }
}

/** Compile for...of over a string — iterate characters using __str_charAt */
function compileForOfString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): void {
  // Ensure native string helpers are available (provides __str_charAt)
  ensureNativeStringHelpers(ctx);

  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (charAtIdx === undefined) {
    ctx.errors.push({
      message: "for-of on string: __str_charAt helper not available",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  const strType = nativeStringType(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // Compile the iterable expression (string ref)
  const bodyLenBefore = fctx.body.length;
  const compiledType = compileExpression(ctx, fctx, stmt.expression);
  if (!compiledType) {
    fctx.body.length = bodyLenBefore;
    ctx.errors.push({
      message: "for-of: failed to compile string expression",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Save string ref to temp local
  const strLocal = allocLocal(fctx, `__forof_str_${fctx.locals.length}`, strType);
  fctx.body.push({ op: "local.set", index: strLocal });

  // Extract length from string (field 0 of AnyString struct)
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: strLocal });
  fctx.body.push({ op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Element type is string (each character is a single-char string)
  const elemType = strType;

  // Declare the loop variable
  let elemLocal: number;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
    elemLocal = allocLocal(fctx, varName, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of str) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Condition: i >= length -> break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // Get character: c = charAt(str, i)
  fctx.body.push({ op: "local.get", index: strLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "call", funcIdx: charAtIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Increment i
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

/** Compile for...of over an array using index-based loop (existing behavior) */
function compileForOfArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): void {
  // Compile the iterable expression (vec struct ref)
  const bodyLenBefore = fctx.body.length;
  const vecType = compileExpression(ctx, fctx, stmt.expression);
  if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) {
    fctx.body.length = bodyLenBefore;
    ctx.errors.push({
      message: "for-of requires an array expression",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Expect a vec struct type {length: i32, data: (ref $__arr_T)}
  const vecTypeIdx = vecType.typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") {
    fctx.body.length = bodyLenBefore;
    ctx.errors.push({
      message: "for-of requires an array type",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    fctx.body.length = bodyLenBefore;
    ctx.errors.push({
      message: "for-of requires an array type",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }
  const elemType = arrDef.element;

  // Save vec ref to temp local
  const vecLocal = allocLocal(
    fctx,
    `__forof_vec_${fctx.locals.length}`,
    vecType,
  );
  fctx.body.push({ op: "local.tee", index: vecLocal });

  // Extract data array from vec into a local
  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });

  // Extract length from vec into a local
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Declare the loop variable (may be a simple identifier or a destructuring pattern)
  let elemLocal: number;
  let destructPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExpr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPattern = decl.name;
      // Allocate a temp local to hold the element for destructuring
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    // Expression form with destructuring: for ({a, b} of arr) or for ([x, y] of arr)
    // These assign to already-declared variables
    assignDestructExpr = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Condition: i >= length → break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // Get element: x = data[i]
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
  // Coerce from Wasm array element type to the local's declared type
  const elemLocalType = getLocalType(fctx, elemLocal);
  if (elemLocalType && !valTypesMatch(elemType, elemLocalType)) {
    coerceType(ctx, fctx, elemType, elemLocalType);
  }
  emitCoercedLocalSet(ctx, fctx, elemLocal, elemType);

  // If destructuring pattern (binding form), destructure from the element
  if (destructPattern) {
    compileForOfDestructuring(ctx, fctx, destructPattern, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals
  if (assignDestructExpr) {
    compileForOfAssignDestructuring(ctx, fctx, assignDestructExpr, elemLocal, elemType, vecTypeIdx, arrTypeIdx, stmt);
  }

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Increment i
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

/**
 * Compile for...of over a non-array iterable using the host-delegated
 * iterator protocol. Works with strings, Maps, Sets, and any object
 * implementing [Symbol.iterator]().
 *
 * Generated Wasm pseudo-code:
 *   iter = __iterator(obj)
 *   loop:
 *     result = __iterator_next(iter)
 *     if __iterator_done(result) → break
 *     elem = __iterator_value(result)
 *     <body>
 *     br loop
 */
function compileForOfIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): void {
  // Compile the iterable expression — should produce an externref
  const iterableType = compileExpression(ctx, fctx, stmt.expression);
  if (!iterableType) {
    ctx.errors.push({
      message: "for-of: failed to compile iterable expression",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Look up the iterator host import function indices
  const iteratorIdx = ctx.funcMap.get("__iterator");
  const nextIdx = ctx.funcMap.get("__iterator_next");
  const doneIdx = ctx.funcMap.get("__iterator_done");
  const valueIdx = ctx.funcMap.get("__iterator_value");
  if (
    iteratorIdx === undefined ||
    nextIdx === undefined ||
    doneIdx === undefined ||
    valueIdx === undefined
  ) {
    ctx.errors.push({
      message: "for-of on non-array type requires iterator imports",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Call __iterator(obj) → externref (the iterator)
  fctx.body.push({ op: "call", funcIdx: iteratorIdx });
  const iterLocal = allocLocal(
    fctx,
    `__forof_iter_${fctx.locals.length}`,
    { kind: "externref" },
  );
  fctx.body.push({ op: "local.set", index: iterLocal });

  // Allocate locals for iterator result and loop element
  const resultLocal = allocLocal(
    fctx,
    `__forof_result_${fctx.locals.length}`,
    { kind: "externref" },
  );

  // Declare the loop variable (element type is externref for iterator protocol)
  const elemType: ValType = { kind: "externref" };
  let elemLocal: number;
  let destructPatternIter: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExprIter: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    // Expression form with destructuring: for ({a, b} of arr) or for ([x, y] of arr)
    assignDestructExprIter = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Call __iterator_next(iter) → result
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "call", funcIdx: nextIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: __iterator_done(result) → i32, break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "call", funcIdx: doneIdx });
  fctx.body.push({ op: "br_if", depth: 1 }); // break out of block

  // Get value: elem = __iterator_value(result)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "call", funcIdx: valueIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring pattern, destructure from the element
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals
  // Note: for iterator path, elemType is externref, so no vecTypeIdx/arrTypeIdx available;
  // assignment destructuring for non-array iterables is not yet supported.
  if (assignDestructExprIter) {
    // For non-array iterables, elem is externref — assignment destructuring
    // would need host unboxing which is not supported. Emit error.
    ctx.errors.push({
      message: "for-of assignment destructuring on non-array iterable is not supported",
      line: getLine(stmt),
      column: getCol(stmt),
    });
  }

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}

function compileForInStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForInStatement,
): void {
  // Get property names from the type checker
  const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
  const props = exprType.getProperties();
  if (props.length === 0) return;

  // Get the loop variable name
  const init = stmt.initializer;
  let varName: string;
  let keyLocal: number;
  if (ts.isVariableDeclarationList(init)) {
    const decl = init.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      // Destructuring patterns in for-in (e.g. `for (var [a] in obj)`)
      // are exotic — the key is a string, destructuring it gives characters.
      // For now, skip gracefully rather than crash.
      ctx.errors.push({
        message: "for-in variable must be an identifier",
        line: getLine(decl),
        column: getCol(decl),
      });
      return;
    }
    varName = decl.name.text;
    // Allocate a local for the loop variable (string / externref)
    keyLocal = allocLocal(fctx, varName, { kind: "externref" });
  } else if (ts.isIdentifier(init)) {
    // Bare identifier: `for (x in obj)` — look up existing local
    varName = init.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      // Variable might be a global or not yet declared — allocate as local
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
  } else if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(init.left)) {
    // Assignment expression: `for (x = defaultVal in obj)` — compile assignment, use the target
    varName = init.left.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
    // Compile the initializer assignment (default value)
    compileExpression(ctx, fctx, init.right);
    fctx.body.push({ op: "local.set", index: keyLocal });
  } else {
    ctx.errors.push({
      message: "for-in requires a variable declaration or identifier",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Unroll: emit one copy of the loop body per property
  for (const prop of props) {
    const globalIdx = ctx.stringGlobalMap.get(prop.name);
    if (globalIdx === undefined) continue;

    // Set the key variable to this property's name
    fctx.body.push({ op: "global.get", index: globalIdx });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Compile the loop body
    compileStatement(ctx, fctx, stmt.statement);
  }
}

function compileLabeledStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.LabeledStatement,
): void {
  const labelName = stmt.label.text;
  const innerStmt = stmt.statement;

  // If the inner statement is a loop, we just record the label and let the
  // loop push its own break/continue entries. But if the inner statement is
  // a block (e.g. `label: { ... break label; ... }`), we need to wrap it in
  // a Wasm block so that `break label` can exit the entire labeled block.
  const isLoop = ts.isWhileStatement(innerStmt) || ts.isDoStatement(innerStmt) ||
                 ts.isForStatement(innerStmt) || ts.isForInStatement(innerStmt) ||
                 ts.isForOfStatement(innerStmt);

  if (isLoop) {
    // Record the label with the current break/continue stack indices.
    // The inner loop statement will push its own entries, so the label
    // points to the index that will be pushed by the labeled loop.
    const breakIdx = fctx.breakStack.length;
    const continueIdx = fctx.continueStack.length;
    fctx.labelMap.set(labelName, { breakIdx, continueIdx });

    compileStatement(ctx, fctx, innerStmt);

    fctx.labelMap.delete(labelName);
  } else {
    // Non-loop labeled statement: wrap in a Wasm block for break support.
    // Structure:
    //   block $label {
    //     body
    //   }
    const savedBody = pushBody(fctx);

    // Adjust existing break/continue depths: block adds 1 nesting level
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;

    // Push break entry for this labeled block: br 0 exits the block
    const breakIdx = fctx.breakStack.length;
    const continueIdx = fctx.continueStack.length;
    fctx.breakStack.push(0);
    fctx.labelMap.set(labelName, { breakIdx, continueIdx });

    compileStatement(ctx, fctx, innerStmt);

    const bodyInstrs = fctx.body;

    fctx.breakStack.pop();
    fctx.labelMap.delete(labelName);

    // Restore existing break/continue depths
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;

    popBody(fctx, savedBody);
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    });
  }
}

function compileBreakStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.BreakStatement,
): void {
  if (stmt.label) {
    // Labeled break: look up the label to find the correct depth
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo !== undefined) {
      const depth = fctx.breakStack[labelInfo.breakIdx];
      if (depth !== undefined) {
        fctx.body.push({ op: "br", depth });
      }
    }
  } else {
    // Unlabeled break: use the innermost (top of stack)
    const depth = fctx.breakStack[fctx.breakStack.length - 1];
    if (depth !== undefined) {
      fctx.body.push({ op: "br", depth });
    }
  }
}

function compileContinueStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ContinueStatement,
): void {
  if (stmt.label) {
    // Labeled continue: look up the label to find the correct depth
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo !== undefined) {
      const depth = fctx.continueStack[labelInfo.continueIdx];
      if (depth !== undefined) {
        fctx.body.push({ op: "br", depth });
      }
    }
  } else {
    // Unlabeled continue: use the innermost (top of stack)
    const depth = fctx.continueStack[fctx.continueStack.length - 1];
    if (depth !== undefined) {
      fctx.body.push({ op: "br", depth });
    }
  }
}

function compileThrowStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ThrowStatement,
): void {
  const tagIdx = ensureExnTag(ctx);

  if (stmt.expression) {
    // Compile the thrown expression — coerce to externref
    const resultType = compileExpression(ctx, fctx, stmt.expression, {
      kind: "externref",
    });
    // If the expression didn't produce externref, we need to ensure it's externref
    if (resultType && resultType.kind !== "externref") {
      // Drop whatever was produced, push null extern as fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    // throw with no expression (unusual but syntactically valid in some contexts)
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "throw", tagIdx });
}

function compileTryStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.TryStatement,
): void {
  const tagIdx = ensureExnTag(ctx);

  // Compile the try block body
  const savedBody = pushBody(fctx);

  // Adjust break/continue depths: the try block adds one label level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;

  for (const s of stmt.tryBlock.statements) {
    compileStatement(ctx, fctx, s);
  }

  // If there's a finally block, inline it at the end of the try body (normal path)
  if (stmt.finallyBlock) {
    for (const s of stmt.finallyBlock.statements) {
      compileStatement(ctx, fctx, s);
    }
  }

  const tryBody = fctx.body;

  // Compile catch clause (if present)
  let catches: { tagIdx: number; body: Instr[] }[] = [];
  let catchAllBody: Instr[] | undefined;

  // If there's a finally block but no catch clause, we need a catch_all
  // that runs the finally block and then rethrows the exception.
  if (stmt.finallyBlock && !stmt.catchClause) {
    fctx.body = [];
    for (const s of stmt.finallyBlock.statements) {
      compileStatement(ctx, fctx, s);
    }
    fctx.body.push({ op: "rethrow", depth: 0 } as any);
    catchAllBody = fctx.body;
  }

  if (stmt.catchClause) {
    // Allocate the catch variable local (if any) before compiling catch bodies
    // so it's available in both catch $tag and catch_all bodies.
    let exnLocalIdx: number | null = null;
    if (
      stmt.catchClause.variableDeclaration &&
      ts.isIdentifier(stmt.catchClause.variableDeclaration.name)
    ) {
      const varName = stmt.catchClause.variableDeclaration.name.text;
      exnLocalIdx = allocLocal(fctx, varName, { kind: "externref" });
    } else if (
      stmt.catchClause.variableDeclaration &&
      (ts.isObjectBindingPattern(stmt.catchClause.variableDeclaration.name) ||
       ts.isArrayBindingPattern(stmt.catchClause.variableDeclaration.name))
    ) {
      // Destructuring in catch: `catch ({message})` or `catch ([a, b])`
      // Allocate locals for all binding names so they are in scope
      ensureBindingLocals(ctx, fctx, stmt.catchClause.variableDeclaration.name);
      // Store the exception value in a temp so catch body can reference it
      exnLocalIdx = allocLocal(fctx, `__catch_destruct_${fctx.locals.length}`, { kind: "externref" });
    }

    // Build "catch $exn" body: receives the externref value on the stack
    {
      fctx.body = [];
      if (exnLocalIdx !== null) {
        fctx.body.push({ op: "local.set", index: exnLocalIdx });
      } else {
        fctx.body.push({ op: "drop" });
      }

      if (stmt.finallyBlock) {
        // Wrap catch body in inner try/catch_all so that if the catch body
        // throws, the finally block still executes before the exception
        // propagates.
        const catchSavedBody = fctx.body;
        fctx.body = [];
        // The inner try adds one label level for break/continue
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

        for (const s of stmt.catchClause.block.statements) {
          compileStatement(ctx, fctx, s);
        }
        const innerTryBody = fctx.body;

        // Build inner catch_all: run finally then rethrow
        fctx.body = [];
        for (const s of stmt.finallyBlock.statements) {
          compileStatement(ctx, fctx, s);
        }
        // rethrow depth 0 = rethrow exception from this catch_all's try
        fctx.body.push({ op: "rethrow", depth: 0 } as any);
        const innerCatchAllBody = fctx.body;

        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;

        fctx.body = catchSavedBody;
        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: innerTryBody,
          catches: [],
          catchAll: innerCatchAllBody,
        } as any);

        // Finally on normal exit path (no exception in catch body)
        for (const s of stmt.finallyBlock.statements) {
          compileStatement(ctx, fctx, s);
        }
      } else {
        for (const s of stmt.catchClause.block.statements) {
          compileStatement(ctx, fctx, s);
        }
      }
      catches = [{ tagIdx, body: fctx.body }];
    }

    // Build "catch_all" body: no value on stack; set catch var to null extern
    {
      fctx.body = [];
      if (exnLocalIdx !== null) {
        fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: exnLocalIdx });
      }

      if (stmt.finallyBlock) {
        // Same wrapping as catch $exn body above
        const catchAllSavedBody = fctx.body;
        fctx.body = [];
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

        for (const s of stmt.catchClause.block.statements) {
          compileStatement(ctx, fctx, s);
        }
        const innerTryBody = fctx.body;

        fctx.body = [];
        for (const s of stmt.finallyBlock.statements) {
          compileStatement(ctx, fctx, s);
        }
        fctx.body.push({ op: "rethrow", depth: 0 } as any);
        const innerCatchAllBody = fctx.body;

        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;

        fctx.body = catchAllSavedBody;
        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: innerTryBody,
          catches: [],
          catchAll: innerCatchAllBody,
        } as any);

        for (const s of stmt.finallyBlock.statements) {
          compileStatement(ctx, fctx, s);
        }
      } else {
        for (const s of stmt.catchClause.block.statements) {
          compileStatement(ctx, fctx, s);
        }
      }
      catchAllBody = fctx.body;
    }
  }

  popBody(fctx, savedBody);

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;

  // Emit the try instruction with catch $tag + catch_all
  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches,
    catchAll: catchAllBody,
  });
}

/** Compile a function declaration nested inside another function.
 *  Lifts the function to module level. If it captures outer-scope variables,
 *  uses a closure struct (like arrow closures). Otherwise uses a direct call. */
/**
 * Handle a ClassDeclaration in statement position (inside for loops, if blocks, etc.).
 * Collects the class struct/methods and compiles their bodies immediately.
 */
function compileNestedClassDeclaration(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration,
): void {
  if (!decl.name) return;
  const className = decl.name.text;

  // Skip if already collected (e.g., hoisted or duplicate)
  if (ctx.structMap.has(className)) return;

  try {
    // Collect struct type, constructor, and method stubs
    collectClassDeclaration(ctx, decl);

    // Build funcByName map for compileClassBodies
    const funcByName = new Map<string, number>();
    for (let i = 0; i < ctx.mod.functions.length; i++) {
      funcByName.set(ctx.mod.functions[i]!.name, i);
    }

    // Compile constructor and method bodies
    compileClassBodies(ctx, decl, funcByName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reportError(ctx, decl, `Internal error compiling nested class '${className}': ${msg}`);
  }
}

function compileNestedFunctionDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
): void {
  if (!stmt.name || !stmt.body) return;
  const funcName = stmt.name.text;

  // Determine parameter types and return type
  const paramTypes: ValType[] = [];
  for (const p of stmt.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    let wasmType = resolveWasmType(ctx, paramType);
    // If the parameter has a default value and is a non-null ref type,
    // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
    if (p.initializer && wasmType.kind === "ref") {
      wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
    }
    paramTypes.push(wasmType);
  }


  // Check if this is a generator function declaration (function* name() { ... })
  const isGenerator = stmt.asteriskToken !== undefined;
  if (isGenerator) {
    ctx.generatorFunctions.add(funcName);
  }
  const sig = ctx.checker.getSignatureFromDeclaration(stmt);
  let returnType: ValType | null = null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope
  const referencedNames = new Set<string>();
  for (const s of stmt.body.statements) {
    collectReferencedIdentifiers(s, referencedNames);
  }

  // Detect which captured variables are written inside the function body
  const writtenInBody = new Set<string>();
  for (const s of stmt.body.statements) {
    collectWrittenIdentifiers(s, writtenInBody);
  }

  const ownParamNames = new Set(
    stmt.parameters
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
    const isMutable = writtenInBody.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  const results: ValType[] = returnType ? [returnType] : [];

  // Register optional/default parameters so call sites can supply defaults
  const optionalParams: { index: number; type: ValType }[] = [];
  for (let i = 0; i < stmt.parameters.length; i++) {
    const param = stmt.parameters[i]!;
    if (param.questionToken || param.initializer) {
      optionalParams.push({ index: i, type: paramTypes[i]! });
    }
  }
  if (optionalParams.length > 0) {
    ctx.funcOptionalParams.set(funcName, optionalParams);
  }

  if (captures.length === 0) {
    // No captures — compile as a regular module-level function
    const funcTypeIdx = addFuncType(
      ctx,
      paramTypes,
      results,
      `${funcName}_type`,
    );
    const liftedFctx: FunctionContext = {
      name: funcName,
      params: stmt.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i]!,
      })),
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

    const savedFunc = ctx.currentFunc;
    if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
    ctx.currentFunc = liftedFctx;

    // Emit default-value initialization for parameters with initializers
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, 0);

    // Set up `arguments` object if the function body references it
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      emitArgumentsObject(ctx, liftedFctx, paramTypes, 0);
    }

    if (isGenerator) {
      // Generator function: eagerly evaluate body, collect yields into a JS array,
      // then wrap it with __create_generator to return a Generator-like object.
      const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
      liftedFctx.body.push({ op: "local.set", index: bufferLocal });

      const bodyInstrs: Instr[] = [];
      const outerBody = liftedFctx.body;
      liftedFctx.body = bodyInstrs;

      liftedFctx.generatorReturnDepth = 0;
      liftedFctx.blockDepth++;
      for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
      for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
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
    } else {
      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
      }
      appendDefaultReturn(liftedFctx, returnType);
    }
    if (savedFunc) ctx.parentBodiesStack.pop();
    ctx.currentFunc = savedFunc;

    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: funcName,
      typeIdx: funcTypeIdx,
      locals: liftedFctx.locals,
      body: liftedFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);
  } else {
    // Has captures — lift with captures as leading parameters, use direct call
    // For mutable captures, use ref cell types so writes propagate back
    const captureParamTypes = captures.map((c) => {
      if (c.mutable) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
        return { kind: "ref" as const, typeIdx: refCellTypeIdx };
      }
      return c.type;
    });
    const allParamTypes = [...captureParamTypes, ...paramTypes];
    const funcTypeIdx = addFuncType(
      ctx,
      allParamTypes,
      results,
      `${funcName}_type`,
    );
    const liftedFctx: FunctionContext = {
      name: funcName,
      params: [
        ...captures.map((c, i) => ({ name: c.name, type: captureParamTypes[i]! })),
        ...stmt.parameters.map((p, i) => ({
          name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
          type: paramTypes[i]!,
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

    // Register mutable captures as boxed so reads/writes use struct.get/set
    for (const cap of captures) {
      if (cap.mutable) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    }

    const savedFunc = ctx.currentFunc;
    if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
    ctx.currentFunc = liftedFctx;

    // Emit default-value initialization for parameters with initializers
    // (offset by number of captures since they are prepended as leading params)
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, captures.length);

    // Set up `arguments` object if the function body references it
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      emitArgumentsObject(ctx, liftedFctx, paramTypes, captures.length);
    }

    if (isGenerator) {
      // Generator function: eagerly evaluate body, collect yields into a JS array,
      // then wrap it with __create_generator to return a Generator-like object.
      const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
      liftedFctx.body.push({ op: "local.set", index: bufferLocal });

      const bodyInstrs: Instr[] = [];
      const outerBody = liftedFctx.body;
      liftedFctx.body = bodyInstrs;

      liftedFctx.generatorReturnDepth = 0;
      liftedFctx.blockDepth++;
      for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
      for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
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
    } else {
      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
      }
      appendDefaultReturn(liftedFctx, returnType);
    }
    if (savedFunc) ctx.parentBodiesStack.pop();
    ctx.currentFunc = savedFunc;

    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: funcName,
      typeIdx: funcTypeIdx,
      locals: liftedFctx.locals,
      body: liftedFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);

    // Store capture info so call sites prepend captured values
    ctx.nestedFuncCaptures.set(
      funcName,
      captures.map((c) => ({
        name: c.name,
        outerLocalIdx: c.localIdx,
        mutable: c.mutable,
        valType: c.type,
      })),
    );
  }
}

/**
 * Pre-pass: hoist function declarations inside a function body.
 * JavaScript semantics require function declarations to be available
 * before their textual position in the enclosing scope.
 * This pre-compiles them so they are in funcMap before other statements run.
 *
 * If a function fails to compile during hoisting (e.g., uses unsupported features),
 * it is rolled back and will be re-attempted during normal statement compilation.
 */
export function hoistFunctionDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      if (!ctx.funcMap.has(stmt.name.text)) {
        // Save state so we can roll back if compilation fails
        const errorsBefore = ctx.errors.length;
        const funcsBefore = ctx.mod.functions.length;
        const funcName = stmt.name.text;

        compileNestedFunctionDeclaration(ctx, fctx, stmt);

        // If new errors were added during hoisting, roll back
        if (ctx.errors.length > errorsBefore) {
          ctx.errors.length = errorsBefore;
          ctx.mod.functions.length = funcsBefore;
          ctx.funcMap.delete(funcName);
          ctx.nestedFuncCaptures.delete(funcName);
          ctx.funcOptionalParams.delete(funcName);
          // Track failed hoist so compileStatement doesn't re-attempt
          if (!ctx.hoistFailedFuncs) ctx.hoistFailedFuncs = new Set();
          ctx.hoistFailedFuncs.add(funcName);
        }
      }
    }
    // Recurse into block-like structures to find nested function declarations.
    // In JS, function declarations are hoisted to the enclosing function scope,
    // even when inside if-branches, try/catch blocks, etc.
    if (ts.isIfStatement(stmt)) {
      if (ts.isBlock(stmt.thenStatement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.thenStatement.statements);
      }
      if (stmt.elseStatement) {
        if (ts.isBlock(stmt.elseStatement)) {
          hoistFunctionDeclarations(ctx, fctx, stmt.elseStatement.statements);
        } else if (ts.isIfStatement(stmt.elseStatement)) {
          hoistFunctionDeclarations(ctx, fctx, [stmt.elseStatement]);
        }
      }
    }
    if (ts.isTryStatement(stmt)) {
      hoistFunctionDeclarations(ctx, fctx, stmt.tryBlock.statements);
      if (stmt.catchClause) {
        hoistFunctionDeclarations(ctx, fctx, stmt.catchClause.block.statements);
      }
      if (stmt.finallyBlock) {
        hoistFunctionDeclarations(ctx, fctx, stmt.finallyBlock.statements);
      }
    }
    if (ts.isBlock(stmt)) {
      hoistFunctionDeclarations(ctx, fctx, stmt.statements);
    }
    // Recurse into loop bodies — function declarations inside loops are hoisted
    // to the enclosing function scope in JS semantics.
    if (ts.isForStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement]);
      }
    }
    if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement]);
      }
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        hoistFunctionDeclarations(ctx, fctx, clause.statements);
      }
    }
    if (ts.isLabeledStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement]);
      }
    }
  }
}

/**
 * Emit default-value initialization for parameters with initializers.
 * For each param with a default value, check if the caller passed the sentinel
 * (0 for f64/i32, ref.null for ref types) and if so compile the initializer.
 * @param paramOffset - number of prepended params (captures) before the user params
 */
function emitDefaultParamInit(
  ctx: CodegenContext,
  liftedFctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  paramTypes: ValType[],
  paramOffset: number,
): void {
  for (let i = 0; i < stmt.parameters.length; i++) {
    const param = stmt.parameters[i]!;
    if (!param.initializer) continue;

    const paramIdx = paramOffset + i;
    const paramType = paramTypes[i]!;

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(liftedFctx);
    compileExpression(ctx, liftedFctx, param.initializer, paramType);
    liftedFctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = liftedFctx.body;
    popBody(liftedFctx, savedBody);

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref" || paramType.kind === "ref_null" || paramType.kind === "ref") {
      liftedFctx.body.push({ op: "local.get", index: paramIdx });
      liftedFctx.body.push({ op: "ref.is_null" });
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "i32") {
      liftedFctx.body.push({ op: "local.get", index: paramIdx });
      liftedFctx.body.push({ op: "i32.eqz" });
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "f64") {
      liftedFctx.body.push({ op: "local.get", index: paramIdx });
      liftedFctx.body.push({ op: "f64.const", value: 0 });
      liftedFctx.body.push({ op: "f64.eq" });
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    }
  }
}

/** Append a default return value if the function body doesn't end with a return */
function appendDefaultReturn(
  fctx: FunctionContext,
  returnType: ValType | null,
): void {
  if (!returnType) return;
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (lastInstr && lastInstr.op === "return") return;
  if (returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
  else if (returnType.kind === "i32")
    fctx.body.push({ op: "i32.const", value: 0 });
  else if (returnType.kind === "externref")
    fctx.body.push({ op: "ref.null.extern" });
}

function getLine(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return line + 1;
  } catch {
    return 0;
  }
}

function getCol(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
    return character + 1;
  } catch {
    return 0;
  }
}

/**
 * Check if a node tree references the `arguments` identifier
 * (skipping nested functions/arrows which have their own scope).
 */
function bodyUsesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return false;
  }
  return ts.forEachChild(node, bodyUsesArguments) ?? false;
}

/**
 * Emit code to create an `arguments` vec struct from function parameters.
 * paramOffset is the number of leading params to skip (e.g. captures).
 */
function emitArgumentsObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
): void {
  const numArgs = paramTypes.length;
  const elemType: ValType = { kind: "f64" };
  const vti = getOrRegisterVecType(ctx, "f64", elemType);
  const ati = getArrTypeIdxFromVec(ctx, vti);
  const vecRef: ValType = { kind: "ref", typeIdx: vti };
  const argsLocal = allocLocal(fctx, "arguments", vecRef);
  const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: ati });

  // Push each param coerced to f64
  for (let i = 0; i < numArgs; i++) {
    fctx.body.push({ op: "local.get", index: i + paramOffset });
    const pt = paramTypes[i]!;
    if (pt.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (pt.kind === "externref" || pt.kind === "ref" || pt.kind === "ref_null") {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: 0 });
    }
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: numArgs });
  fctx.body.push({ op: "local.set", index: arrTmp });
  fctx.body.push({ op: "i32.const", value: numArgs });
  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "struct.new", typeIdx: vti });
  fctx.body.push({ op: "local.set", index: argsLocal });
}
