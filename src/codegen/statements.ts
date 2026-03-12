import ts from "typescript";
import { isStringType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  collectReferencedIdentifiers,
  compileExpression,
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
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  getSourcePos,
  localGlobalIdx,
  reportError,
  resolveWasmType,
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
    // Skip if hoisting was attempted but failed (avoid re-emitting errors)
    if (stmt.name && ctx.hoistFailedFuncs?.has(stmt.name.text)) return;
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
      const localIdx = allocLocal(fctx, name, closureType);
      fctx.body.push({ op: "local.set", index: localIdx });
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
      compileExpression(ctx, fctx, decl.initializer, wasmType);
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }
}

/**
 * Ensure all binding names in a destructuring pattern are allocated as locals.
 * This is a safety net: if the actual destructuring compilation fails, the
 * identifiers will still be in scope (initialized to their zero/null defaults).
 * For `var` declarations these are already hoisted, but `let`/`const` are not.
 */
function ensureBindingLocals(
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

  // Determine struct type from the initializer's type
  const initType = ctx.checker.getTypeAtLocation(decl.initializer);
  const symName = initType.symbol?.name;
  let typeName =
    symName &&
    symName !== "__type" &&
    symName !== "__object" &&
    ctx.structMap.has(symName)
      ? symName
      : (ctx.anonTypeMap.get(initType) ?? symName);

  // Auto-register anonymous object types (same as resolveWasmType / expressions.ts logic)
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

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
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

  // If the compiled expression produced externref but we need a struct ref,
  // cast: externref → anyref → ref $struct
  let effectiveResultType = resultType;
  if (resultType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as unknown as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
    effectiveResultType = { kind: "ref", typeIdx: structTypeIdx };
  }

  // Save the struct ref into a temp local so we can access fields multiple times
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_${fctx.locals.length}`,
    effectiveResultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // For each binding element, create a local and extract the field
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    const propName = (element.propertyName ?? element.name) as ts.Identifier;
    const localName = (element.name as ts.Identifier).text;

    const fieldIdx = fields.findIndex((f) => f.name === propName.text);
    if (fieldIdx === -1) {
      ctx.errors.push({
        message: `Unknown field in destructuring: ${propName.text}`,
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
      // If field is null/undefined, use default value
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
      // For numeric fields, check against NaN (undefined → NaN after unboxing)
      fctx.body.push({ op: "local.set", index: localIdx });
      // Numeric defaults are less common; just set the field value for now
    } else {
      fctx.body.push({ op: "local.set", index: localIdx });
    }
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
  if (!arrDef || arrDef.kind !== "array") {
    fctx.body.length = bodyLenBefore;
    ensureBindingLocals(ctx, fctx, pattern);
    ctx.errors.push({
      message: "Cannot destructure: vec data is not array",
      line: getLine(decl),
      column: getCol(decl),
    });
    return;
  }

  const elemType = arrDef.element;

  // Store vec ref in temp local
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue; // skip holes: [a, , c]

    const localName = (element.name as ts.Identifier).text;
    const localIdx = allocLocal(fctx, localName, elemType);

    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data from vec
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });

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
    // Break out of the generator body block (depth = blockDepth, i.e. the outermost block)
    fctx.body.push({ op: "br", depth: fctx.blockDepth });
    return;
  }

  if (stmt.expression) {
    compileExpression(ctx, fctx, stmt.expression, fctx.returnType ?? undefined);
  } else if (fctx.returnType) {
    // Bare `return;` in a value-returning function — push default value
    if (fctx.returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fctx.returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (fctx.returnType.kind === "externref") fctx.body.push({ op: "ref.null", refType: "extern" } as any);
  }
  fctx.body.push({ op: "return" });
}

function compileIfStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.IfStatement,
): void {
  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);

  // The 'if' instruction adds one label level. Increment break/continue depths
  // so that br instructions emitted inside the if branches target the correct labels.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

  // Compile then branch
  const savedBody = fctx.body;
  fctx.body = [];
  if (ts.isBlock(stmt.thenStatement)) {
    for (const s of stmt.thenStatement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.thenStatement);
  }
  const thenInstrs = fctx.body;

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

  fctx.body = savedBody;

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;

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

  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;

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

  fctx.body = savedBody;

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
      for (const decl of stmt.initializer.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const varType = ctx.checker.getTypeAtLocation(decl);
          const wasmType = resolveWasmType(ctx, varType);
          const localIdx = allocLocal(fctx, name, wasmType);
          if (decl.initializer) {
            compileExpression(ctx, fctx, decl.initializer, wasmType);
            fctx.body.push({ op: "local.set", index: localIdx });
          }
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
  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 3;

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

  // Body (inside $continue block)
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

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

  fctx.body = savedBody;

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

  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 3;

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

  fctx.body = savedBody;

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

  // Allocate a "matched" local to track fallthrough
  const matchedLocalIdx = allocLocal(
    fctx,
    `__sw_matched_${fctx.locals.length}`,
    { kind: "i32" },
  );
  // Initialize matched to 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: matchedLocalIdx });

  // Choose the equality opcode based on the switch expression type
  const eqOp: "f64.eq" | "i32.eq" =
    wasmType.kind === "i32" ? "i32.eq" : "f64.eq";

  // Collect instructions for the switch block body
  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block adds 1 nesting level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

  // break from switch => br to outer block (depth 0 from inside the block).
  // Each case body is wrapped in an if (+1 nesting), so break depth = 1.
  const switchBreakIdx = fctx.breakStack.length;
  fctx.breakStack.push(1);

  const clauses = stmt.caseBlock.clauses;

  for (const clause of clauses) {
    if (ts.isDefaultClause(clause)) {
      // Default: set matched = 1 unconditionally (but only if not already matched)
      // This allows fallthrough into default and from default to subsequent cases
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: matchedLocalIdx });
    } else {
      // case X: if not yet matched, check condition
      const caseClause = clause as ts.CaseClause;

      // if (!matched) { matched = (tmp == caseExpr); }
      const checkBody: Instr[] = [];
      const outerBody = fctx.body;
      fctx.body = checkBody;

      fctx.body.push({ op: "local.get", index: tmpLocalIdx });
      if (switchIsString && ctx.fast && ctx.nativeStrTypeIdx >= 0) {
        // Fast mode: flatten both operands before comparison
        const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
        fctx.body.push({ op: "call", funcIdx: flattenIdx });
      }
      compileExpression(ctx, fctx, caseClause.expression, wasmType);
      if (switchIsString && ctx.fast && ctx.nativeStrTypeIdx >= 0) {
        const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
        fctx.body.push({ op: "call", funcIdx: flattenIdx });
      }
      if (switchIsString && strEqFuncIdx !== undefined) {
        // String comparison: call equals function
        fctx.body.push({ op: "call", funcIdx: strEqFuncIdx });
      } else {
        fctx.body.push({ op: eqOp });
      }
      fctx.body.push({ op: "local.set", index: matchedLocalIdx });

      fctx.body = outerBody;

      // Wrap in: if (!matched) { ... }
      fctx.body.push({ op: "local.get", index: matchedLocalIdx });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: checkBody,
      });
    }

    // Emit body: if (matched) { <statements> }
    if (clause.statements.length > 0) {
      const bodyInstrs: Instr[] = [];
      const outerBody = fctx.body;
      fctx.body = bodyInstrs;

      // Adjust outer entries for the if-wrapping (+1 nesting level).
      // Only adjust entries before the switch's own entry — the switch's
      // breakStack entry already accounts for the if.
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!++;
      for (let i = 0; i < fctx.continueStack.length; i++)
        fctx.continueStack[i]!++;

      for (const s of clause.statements) {
        compileStatement(ctx, fctx, s);
      }

      // Restore depths after case body compilation
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!--;
      for (let i = 0; i < fctx.continueStack.length; i++)
        fctx.continueStack[i]!--;

      fctx.body = outerBody;

      fctx.body.push({ op: "local.get", index: matchedLocalIdx });
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

  const switchBody = fctx.body;
  fctx.body = savedBody;

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
      ctx.errors.push({
        message: "for-of destructuring: element is not a struct ref",
        line: getLine(stmt),
        column: getCol(stmt),
      });
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

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const propName = (element.propertyName ?? element.name) as ts.Identifier;
      const localName = (element.name as ts.Identifier).text;

      const fieldIdx = fields.findIndex((f) => f.name === propName.text);
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
          // No default — use "undefined" sentinel
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
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
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring in for-of: for (var [a, b] of arr)
    // Element should be a vec struct; extract elements by index
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      ctx.errors.push({
        message: "for-of array destructuring: element is not a ref type",
        line: getLine(stmt),
        column: getCol(stmt),
      });
      return;
    }

    const vecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
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
    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue;

      const localName = (element.name as ts.Identifier).text;
      const localIdx = allocLocal(fctx, localName, innerElemType);

      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "array.get", typeIdx: innerArrTypeIdx });

      if (element.initializer && innerElemType.kind === "externref") {
        const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, innerElemType);
        fctx.body.push({ op: "local.tee", index: tmpElem });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(() => {
              const saved = fctx.body;
              fctx.body = [];
              compileExpression(ctx, fctx, element.initializer!, innerElemType);
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
  }
}

function compileForOfStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): void {
  // Check the TS type of the iterable to decide compilation strategy
  const exprTsType = ctx.checker.getTypeAtLocation(stmt.expression);
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
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPattern = decl.name;
      // Allocate a temp local to hold the element for destructuring
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
    } else {
      const varName = (decl.name as ts.Identifier).text;
      elemLocal = allocLocal(fctx, varName, elemType);
    }
  } else {
    // Expression form: for (x of arr) — x is already declared
    const varName = (stmt.initializer as ts.Identifier).text;
    elemLocal = fctx.localMap.get(varName)!;
  }

  // Build loop body
  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;

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
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring pattern, destructure from the element
  if (destructPattern) {
    compileForOfDestructuring(ctx, fctx, destructPattern, elemLocal, elemType, stmt);
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

  fctx.body = savedBody;

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
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
    } else {
      const varName = (decl.name as ts.Identifier).text;
      elemLocal = allocLocal(fctx, varName, elemType);
    }
  } else {
    // Expression form: for (x of arr) — x is already declared
    const varName = (stmt.initializer as ts.Identifier).text;
    elemLocal = fctx.localMap.get(varName)!;
  }

  // Build loop body
  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;

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

  fctx.body = savedBody;

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
  if (ts.isVariableDeclarationList(init)) {
    const decl = init.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      ctx.errors.push({
        message: "for-in variable must be an identifier",
        line: getLine(decl),
        column: getCol(decl),
      });
      return;
    }
    varName = decl.name.text;
  } else {
    ctx.errors.push({
      message: "for-in requires a variable declaration",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Allocate a local for the loop variable (string / externref)
  const keyLocal = allocLocal(fctx, varName, { kind: "externref" });

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
    const savedBody = fctx.body;
    fctx.body = [];

    // Adjust existing break/continue depths: block adds 1 nesting level
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

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

    fctx.body = savedBody;
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
  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust break/continue depths: the try block adds one label level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

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
      for (const s of stmt.catchClause.block.statements) {
        compileStatement(ctx, fctx, s);
      }
      if (stmt.finallyBlock) {
        for (const s of stmt.finallyBlock.statements) {
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
      for (const s of stmt.catchClause.block.statements) {
        compileStatement(ctx, fctx, s);
      }
      if (stmt.finallyBlock) {
        for (const s of stmt.finallyBlock.statements) {
          compileStatement(ctx, fctx, s);
        }
      }
      catchAllBody = fctx.body;
    }
  }

  fctx.body = savedBody;

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;

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
    paramTypes.push(resolveWasmType(ctx, paramType));
  }

  const sig = ctx.checker.getSignatureFromDeclaration(stmt);
  let returnType: ValType | null = null;
  if (sig) {
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

  const ownParamNames = new Set(
    stmt.parameters
      .filter((p) => ts.isIdentifier(p.name))
      .map((p) => (p.name as ts.Identifier).text),
  );

  const captures: { name: string; type: ValType; localIdx: number }[] = [];
  for (const name of referencedNames) {
    if (ownParamNames.has(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    captures.push({ name, type, localIdx });
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
        name: (p.name as ts.Identifier).text,
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
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = liftedFctx;

    // Emit default-value initialization for parameters with initializers
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, 0);

    // Set up `arguments` object if the function body references it
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      emitArgumentsObject(ctx, liftedFctx, paramTypes, 0);
    }

    for (const s of stmt.body.statements) {
      compileStatement(ctx, liftedFctx, s);
    }
    appendDefaultReturn(liftedFctx, returnType);
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
    const allParamTypes = [...captures.map((c) => c.type), ...paramTypes];
    const funcTypeIdx = addFuncType(
      ctx,
      allParamTypes,
      results,
      `${funcName}_type`,
    );
    const liftedFctx: FunctionContext = {
      name: funcName,
      params: [
        ...captures.map((c) => ({ name: c.name, type: c.type })),
        ...stmt.parameters.map((p, i) => ({
          name: (p.name as ts.Identifier).text,
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
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = liftedFctx;

    // Emit default-value initialization for parameters with initializers
    // (offset by number of captures since they are prepended as leading params)
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, captures.length);

    // Set up `arguments` object if the function body references it
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      emitArgumentsObject(ctx, liftedFctx, paramTypes, captures.length);
    }

    for (const s of stmt.body.statements) {
      compileStatement(ctx, liftedFctx, s);
    }
    appendDefaultReturn(liftedFctx, returnType);
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
    const savedBody = liftedFctx.body;
    liftedFctx.body = [];
    compileExpression(ctx, liftedFctx, param.initializer, paramType);
    liftedFctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = liftedFctx.body;
    liftedFctx.body = savedBody;

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
  const sf = node.getSourceFile();
  if (!sf) return 0;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return line + 1;
}

function getCol(node: ts.Node): number {
  const sf = node.getSourceFile();
  if (!sf) return 0;
  const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
  return character + 1;
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
