import ts from "typescript";
import { isStringType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { emitGuardedRefCast } from "./type-coercion.js";
import {
  coerceType,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileExpression,
  emitBoundsCheckedArrayGet,
  emitCoercedLocalSet,
  emitThrowString,
  emitUndefined,
  ensureLateImport,
  flushLateImportShifts,
  shiftLateImportIndices,
  valTypesMatch,
  VOID_RESULT,
} from "./expressions.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "./index.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  allocLocal,
  attachSourcePos,
  collectClassDeclaration,
  compileClassBodies,
  ensureExnTag,
  ensureAnyHelpers,
  ensureI32Condition,
  ensureNativeStringHelpers,
  isAnyValue,
  ensureStructForType,
  nativeStringType,
  destructureParamArray,
  destructureParamObject,
  extractConstantDefault,
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
import { promoteAccessorCapturesToGlobals } from "./closures.js";
import { resolveComputedKeyExpression } from "./literals.js";

/**
 * Adjust the depth of all entries in the catchRethrowStack by `delta`.
 * Called wherever breakStack entries are bulk-adjusted for block nesting changes.
 */
function adjustRethrowDepth(fctx: FunctionContext, delta: number): void {
  if (fctx.catchRethrowStack) {
    for (let i = 0; i < fctx.catchRethrowStack.length; i++) {
      fctx.catchRethrowStack[i]!.depth += delta;
    }
  }
}

/**
 * Emit instructions to set a TDZ flag global to 1 (initialized) for a module-level
 * let/const variable. No-op if the variable doesn't have a TDZ flag.
 */
function emitTdzInit(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const flagIdx = ctx.tdzGlobals.get(name);
  if (flagIdx === undefined) return;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "global.set", index: flagIdx });
}

/**
 * Emit a TDZ check for a module-level let/const variable read.
 * If the TDZ flag is 0 (uninitialized), throw a ReferenceError.
 * No-op if the variable doesn't have a TDZ flag.
 */
export function emitTdzCheck(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const flagIdx = ctx.tdzGlobals.get(name);
  if (flagIdx === undefined) return;
  const tagIdx = ensureExnTag(ctx);
  // if (flag == 0) throw ReferenceError
  fctx.body.push({ op: "global.get", index: flagIdx });
  fctx.body.push({ op: "i32.eqz" });
  // if (uninitialized) { throw }
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // Push error message as externref string, then throw
      emitTdzErrorString(ctx, name),
      { op: "throw", tagIdx },
    ],
    else: [],
  } as unknown as Instr);
}

/**
 * Build an instruction that pushes a ReferenceError message as externref onto the stack.
 * Uses ref.null.extern as the payload to avoid adding string constant imports that
 * would require the string_constants module at instantiation time (#790).
 * The exception is still catchable via try/catch.
 */
function emitTdzErrorString(_ctx: CodegenContext, _name: string): Instr {
  return { op: "ref.null.extern" } as Instr;
}

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

/**
 * Collect the names of block-scoped (let/const) variable declarations that
 * are direct children of a block (not nested blocks — those handle their own).
 */
function collectBlockScopedNames(stmt: ts.Block): string[] {
  const names: string[] = [];
  for (const s of stmt.statements) {
    if (!ts.isVariableStatement(s)) continue;
    const flags = s.declarationList.flags;
    // Only let/const create block-scoped bindings (not var)
    if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) continue;
    for (const decl of s.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      }
      // For destructuring patterns, collect all bound names
      else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        collectBindingPatternNames(decl.name, names);
      }
    }
  }
  return names;
}

function collectBindingPatternNames(pattern: ts.BindingPattern, names: string[]): void {
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name)) {
      names.push(el.name.text);
    } else if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) {
      collectBindingPatternNames(el.name, names);
    }
  }
}

/** Saved state for a block scope: localMap + optional TDZ flags */
interface BlockScopeSave {
  locals: Map<string, number>;
  tdzFlags: Map<string, number> | null;
}

/**
 * Save localMap (and TDZ flag) entries for block-scoped names that shadow
 * existing locals.  Also removes the shadow entries from localMap (and
 * tdzFlagLocals) so that compileVariableStatement will allocate fresh locals.
 * Returns the saved state to restore after the block.
 */
function saveBlockScopedShadows(
  fctx: FunctionContext,
  block: ts.Block,
): BlockScopeSave | null {
  const blockNames = collectBlockScopedNames(block);
  if (blockNames.length === 0) return null;

  let savedLocals: Map<string, number> | null = null;
  let savedTdz: Map<string, number> | null = null;
  for (const name of blockNames) {
    const existing = fctx.localMap.get(name);
    if (existing !== undefined) {
      if (!savedLocals) savedLocals = new Map();
      savedLocals.set(name, existing);
      // Remove from localMap so the inner declaration allocates a fresh local
      fctx.localMap.delete(name);
      // Also save and remove any TDZ flag for this name
      if (fctx.tdzFlagLocals) {
        const tdzIdx = fctx.tdzFlagLocals.get(name);
        if (tdzIdx !== undefined) {
          if (!savedTdz) savedTdz = new Map();
          savedTdz.set(name, tdzIdx);
          fctx.tdzFlagLocals.delete(name);
        }
      }
    }
  }
  if (!savedLocals) return null;
  return { locals: savedLocals, tdzFlags: savedTdz };
}

/**
 * Restore localMap (and TDZ flag) entries that were saved before entering
 * a block scope.
 */
function restoreBlockScopedShadows(
  fctx: FunctionContext,
  saved: BlockScopeSave | null,
): void {
  if (!saved) return;
  for (const [name, idx] of saved.locals) {
    fctx.localMap.set(name, idx);
  }
  if (saved.tdzFlags) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    for (const [name, idx] of saved.tdzFlags) {
      fctx.tdzFlagLocals.set(name, idx);
    }
  }
}

/** Compile a statement, appending instructions to the function body */
export function compileStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
): void {
  // Guard: if the AST node is undefined/null, report an error and return
  // instead of crashing with "Cannot read 'kind' of undefined".
  if (!stmt) {
    ctx.errors.push({
      message: "unexpected undefined AST node in compileStatement",
      line: 0,
      column: 0,
    });
    return;
  }

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

  // Skip export declarations — `export { x }`, `export * from '...'`
  // These are module-level metadata with no runtime effect in our compilation.
  if (ts.isExportDeclaration(stmt)) return;

  // Export assignment — `export default expr` or `export = expr`
  // Evaluate the expression (for side effects) but discard the result.
  if (ts.isExportAssignment(stmt)) {
    const resultType = compileExpression(ctx, fctx, stmt.expression);
    if (resultType !== null) {
      fctx.body.push({ op: "drop" });
    }
    return;
  }

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
    // Save localMap entries for any block-scoped (let/const) names that shadow
    // existing variables.  Wasm locals are flat (no block scope), so we need to
    // restore the outer mapping after the block ends.
    const savedLocals = saveBlockScopedShadows(fctx, stmt);
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedLocals);
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
    compileNestedClassDeclaration(ctx, fctx, stmt);
    return;
  }

  // Empty statement (`;`) — no-op
  if (stmt.kind === ts.SyntaxKind.EmptyStatement) {
    return;
  }

  // Class member nodes that can leak into compileStatement when iterating
  // class body or constructor body — treat as no-ops since field initializers
  // are handled separately in compileClassBodies (index.ts).
  if (stmt.kind === ts.SyntaxKind.PropertyDeclaration) {
    // Field declarations (e.g., `x = 5`, `#y: string`) — initializers are
    // compiled in compileClassBodies via struct.set; skip here.
    return;
  }
  if (stmt.kind === ts.SyntaxKind.SemicolonClassElement) {
    // Stray `;` inside class body — no-op.
    return;
  }
  if (stmt.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) {
    // `static { ... }` block — compile the statements inside.
    const staticBlock = stmt as unknown as ts.ClassStaticBlockDeclaration;
    if (staticBlock.body) {
      for (const s of staticBlock.body.statements) {
        compileStatement(ctx, fctx, s);
      }
    }
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
  // With native strings, split returns a native string array, not externref
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) return false;
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

    // Track const bindings for runtime enforcement (assignment throws TypeError)
    if (stmt.declarationList.flags & ts.NodeFlags.Const) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(name);
    }

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
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
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
        // Check if ALL computed keys can be resolved at compile time.
        // If so, skip this early-out and let ensureComputedPropertyFields + the
        // normal module-global path handle it properly.
        const allComputedResolvable = decl.initializer.properties.every((p) => {
          if (!ts.isPropertyAssignment(p) || !p.name || !ts.isComputedPropertyName(p.name)) return true;
          return resolveComputedKeyExpression(ctx, p.name.expression) !== undefined;
        });
        if (!allComputedResolvable) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const objType = actualType ?? { kind: "externref" as const };
          // Store to module global if available, otherwise local
          const modGlobal = ctx.moduleGlobals.get(name);
          if (modGlobal !== undefined) {
            fctx.body.push({ op: "global.set", index: modGlobal });
            emitTdzInit(ctx, fctx, name);
          } else {
            const localIdx = allocLocal(fctx, name, objType);
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }
        // All computed keys resolvable — fall through to normal path
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
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
        continue;
      }
      // Module global: compile initializer and set global
      if (decl.initializer) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        const wasmType =
          globalDef?.type ??
          resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
        compileExpression(ctx, fctx, decl.initializer, wasmType);
        // Re-read index: compileExpression may shift globals via addStringConstantGlobal
        const moduleGlobalIdxPost = ctx.moduleGlobals.get(name)!;
        fctx.body.push({ op: "global.set", index: moduleGlobalIdxPost });
      } else {
        // No initializer: `let x;` at module level — in JS, uninitialized
        // variables are `undefined`. For externref globals, emit __get_undefined()
        // so `x === undefined` works correctly (#737).
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        if (globalDef?.type.kind === "externref") {
          emitUndefined(ctx, fctx);
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
      }
      // Set TDZ flag to 1 (initialized) — even for `let x;` without initializer
      emitTdzInit(ctx, fctx, name);
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

    // If this var/let/const was already pre-hoisted at function entry, reuse that slot.
    const existingIdx = fctx.localMap.get(name);
    const isVar = !(decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    const isHoistedLetConst = !isVar && existingIdx !== undefined && existingIdx >= fctx.params.length && fctx.tdzFlagLocals?.has(name);
    const localIdx = ((isVar || isHoistedLetConst) && existingIdx !== undefined && existingIdx >= fctx.params.length)
      ? existingIdx
      : allocLocal(fctx, name, wasmType);

    // If we reused a pre-hoisted slot but inference found a more precise type
    // (e.g. Array<any> hoisted as vec_externref, but inferred as vec_f64),
    // update the local's type so it matches what the initializer will produce.
    // IMPORTANT: Do NOT downgrade a ref/ref_null local to a primitive type (f64,
    // i32, externref) — earlier instructions (e.g. emitArgumentsObject) may have
    // already emitted struct.new + local.set targeting this local with its original
    // ref type. Changing the type retroactively would cause Wasm validation errors.
    // Instead, keep the existing ref type and let emitCoercedLocalSet handle coercion.
    if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
      const localSlot = fctx.locals[existingIdx - fctx.params.length];
      if (localSlot
          && (wasmType.kind !== localSlot.type.kind
              || (wasmType as any).typeIdx !== (localSlot.type as any).typeIdx)) {
        const existingIsRef = localSlot.type.kind === "ref" || localSlot.type.kind === "ref_null";
        const newIsPrimitive = wasmType.kind === "f64" || wasmType.kind === "i32"
          || wasmType.kind === "i64" || wasmType.kind === "externref";
        if (!(existingIsRef && newIsPrimitive)) {
          localSlot.type = wasmType;
        }
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
            // Convert externref back to closure struct ref (guarded to avoid illegal cast)
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            emitGuardedRefCast(fctx, matchedClosureInfo.structTypeIdx);
            const castType: ValType = { kind: "ref_null", typeIdx: matchedClosureInfo.structTypeIdx };
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
          const bodyLenBeforeCoerce = fctx.body.length;
          coerceType(ctx, fctx, resultType, wasmType);
          // Only update stackType if coercion actually emitted instructions.
          // If coerceType was a no-op (e.g. unrelated struct types), keep
          // the original resultType so emitCoercedLocalSet can detect the
          // mismatch and update the local's declared type accordingly.
          if (fctx.body.length > bodyLenBeforeCoerce) {
            stackType = wasmType; // after coercion, stack is wasmType
          }
        }
      }
      emitCoercedLocalSet(ctx, fctx, localIdx, stackType);
    } else if (wasmType.kind === "externref") {
      // No initializer: `let x;` / `var x;` — in JS, uninitialized variables
      // are `undefined`, not `null`. Emit __get_undefined() so that
      // `x === undefined` works correctly (#737).
      emitUndefined(ctx, fctx);
      fctx.body.push({ op: "local.set", index: localIdx });
    }
    // Set local TDZ flag to 1 (initialized) if this is a hoisted let/const
    emitLocalTdzInit(fctx, name);
  }
}

/**
 * Emit instructions to set a local TDZ flag to 1 (initialized) for a function-level
 * let/const variable. No-op if the variable doesn't have a local TDZ flag.
 */
function emitLocalTdzInit(fctx: FunctionContext, name: string): void {
  const flagIdx = fctx.tdzFlagLocals?.get(name);
  if (flagIdx === undefined) return;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: flagIdx });
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
function syncDestructuredLocalsToGlobals(
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

// ---------------------------------------------------------------------------
// Destructuring helpers — shared across object, array, and for-of paths
// ---------------------------------------------------------------------------

/**
 * Collect instructions emitted by `emitFn` into a separate array without
 * appending them to the current `fctx.body`.  This replaces the pervasive
 * "save body / swap / restore" pattern that was duplicated dozens of times.
 */
export function collectInstrs(
  fctx: FunctionContext,
  emitFn: () => void,
): Instr[] {
  const saved = fctx.body;
  // Register saved body so late import shifts can find it (#801).
  // Without this, ensureLateImport/shiftLateImportIndices during emitFn
  // would miss the saved body when updating function indices.
  fctx.savedBodies.push(saved);
  fctx.body = [];
  emitFn();
  const instrs = fctx.body;
  fctx.body = saved;
  fctx.savedBodies.pop();
  return instrs;
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
function emitNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  srcLocal: number,
  isNullable: boolean,
  emitFn: () => void,
): void {
  const guardInstrs = collectInstrs(fctx, emitFn);
  if (isNullable && guardInstrs.length > 0) {
    // Per JS spec, destructuring null/undefined must throw TypeError
    const msg = "TypeError: Cannot destructure 'null' or 'undefined'";
    addStringConstantGlobal(ctx, msg);
    const strIdx = ctx.stringGlobalMap.get(msg)!;
    const tagIdx = ensureExnTag(ctx);
    const throwInstrs: Instr[] = [
      { op: "global.get", index: strIdx } as Instr,
      { op: "throw", tagIdx } as Instr,
    ];
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: guardInstrs });
  } else {
    fctx.body.push(...guardInstrs);
  }
}

/**
 * Ensure __async_iterator import is available.
 * Returns the function index, or undefined if registration failed.
 * JS impl: (obj) => obj[Symbol.asyncIterator]?.() ?? obj[Symbol.iterator]()
 */
function ensureAsyncIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
): number | undefined {
  let idx = ctx.funcMap.get("__async_iterator");
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
function ensureExternIsUndefined(
  ctx: CodegenContext,
  fctx: FunctionContext,
): number | undefined {
  let idx = ctx.funcMap.get("__extern_is_undefined");
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
export function emitExternrefDefaultCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  tmpLocal: number,
): void {
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
        op: "if", blockType: { kind: "empty" },
        then: defaultInstrs, else: [],
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
        op: "if", blockType: { kind: "empty" },
        then: defaultInstrs, else: [],
      });
    }
  } else if (valueType.kind === "f64") {
    // Check for sNaN sentinel (0x7FF00000DEADC0DE) — NOT generic NaN.
    // This distinguishes missing/undefined from explicit NaN arguments (#866).
    fctx.body.push({ op: "local.get", index: nestedLocal });
    fctx.body.push({ op: "i64.reinterpret_f64" } as unknown as Instr);
    fctx.body.push({ op: "i64.const", value: 0x7FF00000DEADC0DEn } as unknown as Instr);
    fctx.body.push({ op: "i64.eq" });
    const defaultInstrs = collectInstrs(fctx, () => {
      compileExpression(ctx, fctx, initializer, valueType);
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if", blockType: { kind: "empty" },
        then: defaultInstrs, else: [],
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
    return [
      { op: "local.get", index: tmpField } as Instr,
      { op: "local.set", index: localIdx } as Instr,
    ];
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
    fctx.body.push({ op: "i64.const", value: 0x7FF00000DEADC0DEn } as unknown as Instr);
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
      symName &&
      symName !== "__type" &&
      symName !== "__object" &&
      ctx.structMap.has(symName)
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
      // Known type name but no struct — fall back to externref
      if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" } as Instr);
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        return;
      }
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

  // Null guard: throw TypeError if source is null (#728)
  emitNullGuard(ctx, fctx, tmpLocal, resultType.kind === "ref_null", () => {

  // For each binding element, create a local and extract the field
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    const propNameNode = element.propertyName ?? element.name;
    const propName = ts.isIdentifier(propNameNode) ? propNameNode
      : ts.isStringLiteral(propNameNode) ? propNameNode
      : ts.isNumericLiteral(propNameNode) ? propNameNode
      : undefined;
    // Try resolving computed property names at compile time
    let propNameResolvedText: string | undefined;
    if (!propName && ts.isComputedPropertyName(propNameNode)) {
      propNameResolvedText = resolveComputedKeyExpression(ctx, propNameNode.expression);
    }

    // Handle nested binding patterns: const { b: { c, d } } = obj
    if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      const nestedPropName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName : undefined;
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
        let nestedStructName: string | undefined;
        nestedStructName = ctx.typeIdxToStructName.get(nestedTypeIdx);
        const nestedFields = nestedStructName ? ctx.structFields.get(nestedStructName) : undefined;
        if (nestedFields) {
          emitNullGuard(ctx, fctx, nestedTmp, nFieldType.kind === "ref_null", () => {
            for (const ne of (element.name as ts.ObjectBindingPattern).elements) {
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
      } else if (ts.isArrayBindingPattern(element.name) && (nFieldType.kind === "ref" || nFieldType.kind === "ref_null")) {
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
          const restObjType = addFuncType(ctx,
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }]);
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
      ctx.errors.push({
        message: `Unknown field in destructuring: ${propNameText}`,
        line: getLine(element),
        column: getCol(element),
      });
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
  emitNullGuard(ctx, fctx, tmpLocal, isNullable, () => {

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
          const restObjType = addFuncType(ctx,
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }]);
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
        const elseCoerce = (localType && !valTypesMatch(elemType, localType))
          ? collectInstrs(fctx, () => { coerceType(ctx, fctx, elemType, localType!); })
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

  }); // end null guard

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
          const sliceType = addFuncType(ctx,
            [{ kind: "externref" }, { kind: "f64" }],
            [{ kind: "externref" }]);
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
        const elseCoerce = (localType && !valTypesMatch(elemType, localType))
          ? collectInstrs(fctx, () => { coerceType(ctx, fctx, elemType, localType!); })
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
          op: "if", blockType: { kind: "empty" },
          then: defaultInstrs, else: [],
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

function compileArrayDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (!decl.initializer) return;

  const pattern = decl.name as ts.ArrayBindingPattern;
  const bodyLenBefore = fctx.body.length;

  // When the pattern has rest elements, force vec mode for the initializer so
  // array literals produce a full vec (not a truncated tuple matching the binding pattern type)
  const patternHasRest = pattern.elements.some(
    (el) => ts.isBindingElement(el) && el.dotDotDotToken,
  );
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
  const isTupleStruct = !isVecArray && typeDef.kind === "struct" &&
    (typeDef.fields.length === 0 ||
     typeDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`));

  // Check if this is a string type (AnyString, NativeString, ConsString)
  const isStringStruct = ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 &&
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
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_${fctx.locals.length}`,
    resultType,
  );
  fctx.body.push({ op: "local.set", index: tmpLocal });

  const isNullableArr = resultType.kind === "ref_null";

  // When the pattern has rest elements, tuples may not have enough fields;
  // convert to externref and use __extern_slice for the rest
  const hasRestElement = pattern.elements.some(
    (el) => ts.isBindingElement(el) && el.dotDotDotToken,
  );

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
              if (initType && initType !== VOID_RESULT) {
                if ((initType.kind === "ref" || initType.kind === "ref_null") && ts.isObjectBindingPattern(element.name)) {
                  const initTypeIdx = (initType as { typeIdx: number }).typeIdx;
                  const tmpObjLocal = allocLocal(fctx, `__dflt_obj_${fctx.locals.length}`, initType);
                  fctx.body.push({ op: "local.set", index: tmpObjLocal });
                  const nestedStructName = ctx.typeIdxToStructName.get(initTypeIdx);
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
                } else if ((initType.kind === "ref" || initType.kind === "ref_null") && ts.isArrayBindingPattern(element.name)) {
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
                  const propNText = ts.isIdentifier(propNNode) ? propNNode.text
                    : ts.isStringLiteral(propNNode) ? propNNode.text
                    : ts.isNumericLiteral(propNNode) ? propNNode.text
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
              const isNestedTuple = nestedTypeDef && nestedTypeDef.kind === "struct" &&
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
  const elemType = arrDef!.element;

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
              } else if (ts.isObjectBindingPattern(element.name)) {
                // Store in temp local and extract struct fields
                const tmpObjLocal = allocLocal(fctx, `__dflt_obj_${fctx.locals.length}`, initType);
                fctx.body.push({ op: "local.set", index: tmpObjLocal });
                const nestedStructName = ctx.typeIdxToStructName.get(initTypeIdx);
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
          } else if (ts.isObjectBindingPattern(element.name)) {
            fctx.body.push({ op: "local.get", index: nestedExtLocal });
            compileExternrefObjectDestructuringDecl(ctx, fctx, element.name, elemType);
          }
        });

        fctx.body.push({
          op: "if", blockType: { kind: "empty" },
          then: defaultBranch, else: elseBranch,
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
        const nullableElemType: ValType = (elemType.kind === "ref")
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
                const propNText = ts.isIdentifier(propNNode) ? propNNode.text
                  : ts.isStringLiteral(propNNode) ? propNNode.text
                  : ts.isNumericLiteral(propNNode) ? propNNode.text
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
                const propNText = ts.isIdentifier(propNNode) ? propNNode.text
                  : ts.isStringLiteral(propNNode) ? propNNode.text
                  : ts.isNumericLiteral(propNNode) ? propNNode.text
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
          } else if (ts.isObjectBindingPattern(element.name)) {
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
          const sliceType = addFuncType(ctx,
            [{ kind: "externref" }, { kind: "f64" }],
            [{ kind: "externref" }]);
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
  // Inside a generator function, `return expr` should push the return value
  // into the generator buffer (so .next().value sees it), then break out of
  // the body block (not use the wasm `return` opcode, which would skip __create_generator).
  if (fctx.isGenerator) {
    if (stmt.expression) {
      const bufferIdx = fctx.localMap.get("__gen_buffer");
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      if (resultType !== null && resultType !== VOID_RESULT && bufferIdx !== undefined) {
        // Push the return value into the gen buffer so it appears as the
        // final next() value (#729)
        const tmpLocal = allocLocal(fctx, `__gen_ret_${fctx.locals.length}`, resultType);
        fctx.body.push({ op: "local.set", index: tmpLocal });
        fctx.body.push({ op: "local.get", index: bufferIdx });
        fctx.body.push({ op: "local.get", index: tmpLocal });
        if (resultType.kind === "f64") {
          const pushIdx = ctx.funcMap.get("__gen_push_f64");
          if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
        } else if (resultType.kind === "i32") {
          const pushIdx = ctx.funcMap.get("__gen_push_i32");
          if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
        } else {
          const pushIdx = ctx.funcMap.get("__gen_push_ref");
          if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
        }
      } else if (resultType !== null && resultType !== VOID_RESULT) {
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

  const hasPendingFinally = fctx.finallyStack && fctx.finallyStack.length > 0;

  if (stmt.expression) {
    const exprType = compileExpression(ctx, fctx, stmt.expression, fctx.returnType ?? undefined);
    // Coerce expression result to match function return type if they differ
    if (exprType && fctx.returnType && !valTypesMatch(exprType, fctx.returnType)) {
      coerceType(ctx, fctx, exprType, fctx.returnType);
    }
    // (#585) If the function is void (no return type) but the expression produced
    // a value, drop it — Wasm requires an empty stack before `return` in void funcs.
    if (exprType && !fctx.returnType) {
      fctx.body.push({ op: "drop" });
    }
  } else if (fctx.returnType) {
    // Bare `return;` in a value-returning function — push default value
    if (fctx.returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fctx.returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (fctx.returnType.kind === "i64") fctx.body.push({ op: "i64.const", value: 0n });
    else if (fctx.returnType.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (fctx.returnType.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
    else if (fctx.returnType.kind === "ref") fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
  }

  // If inside a try block with a finally clause, save the return value to a
  // temp local, inline the finally instructions, then restore and return.
  // This ensures finally always runs, and if finally contains its own return,
  // that return takes precedence (the subsequent return becomes unreachable).
  if (hasPendingFinally) {
    // Save return value to a temp local (if there is one)
    let retTmpIdx: number | undefined;
    if (fctx.returnType) {
      retTmpIdx = allocLocal(fctx, `__finally_ret_${fctx.locals.length}`, fctx.returnType);
      fctx.body.push({ op: "local.set", index: retTmpIdx });
    }
    // Inline ALL pending finally blocks from innermost to outermost
    for (let i = fctx.finallyStack!.length - 1; i >= 0; i--) {
      fctx.body.push(...fctx.finallyStack![i]!.cloneFinally());
    }
    // Restore return value and emit return
    if (retTmpIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: retTmpIdx });
    }
    fctx.body.push({ op: "return" });
    return;
  }

  // Tail call optimization: if the last instruction is a call or call_ref,
  // replace it with return_call / return_call_ref to eliminate stack growth
  // for recursive and tail-position calls.
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (lastInstr && lastInstr.op === "call") {
    (lastInstr as any).op = "return_call";
    return; // return_call implicitly returns — no need for explicit return
  }
  if (lastInstr && lastInstr.op === "call_ref") {
    (lastInstr as any).op = "return_call_ref";
    return; // return_call_ref implicitly returns — no need for explicit return
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

/**
 * Detect `typeof x === "string"` / `typeof x === "number"` patterns in if conditions.
 * Returns the variable name, the type literal, and which branch is narrowed.
 */
function detectTypeofNarrowing(
  expr: ts.Expression,
): { varName: string; typeLiteral: string; narrowedBranch: "then" | "else" } | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isEq =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Only narrow for simple identifier operands
  const operand = typeofExpr.expression;
  if (!ts.isIdentifier(operand)) return null;

  // Only narrow for "string" and "number" for now
  if (stringLiteral !== "string" && stringLiteral !== "number") return null;

  return {
    varName: operand.text,
    typeLiteral: stringLiteral,
    narrowedBranch: isEq ? "then" : "else",
  };
}

/**
 * Apply typeof narrowing for a branch: allocate a new local of the narrowed type,
 * emit unboxing from the AnyValue local, and remap localMap.
 * Returns the original local index so we can restore it later.
 */
function applyTypeofNarrowing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  varName: string,
  typeLiteral: string,
): { originalLocalIdx: number; narrowedLocalIdx: number } | null {
  const originalLocalIdx = fctx.localMap.get(varName);
  if (originalLocalIdx === undefined) return null;

  // Check that the variable is currently AnyValue typed
  const localType = getLocalType(fctx, originalLocalIdx);
  if (!localType || !isAnyValue(localType, ctx)) return null;

  ensureAnyHelpers(ctx);

  let narrowedType: ValType;
  let unboxHelper: string;

  if (typeLiteral === "number") {
    narrowedType = { kind: "f64" };
    unboxHelper = "__any_unbox_f64";
  } else if (typeLiteral === "string") {
    narrowedType = { kind: "externref" };
    unboxHelper = "__any_unbox_extern";
  } else {
    return null;
  }

  const funcIdx = ctx.funcMap.get(unboxHelper);
  if (funcIdx === undefined) return null;

  // Allocate a new local for the narrowed value
  const narrowedLocalIdx = allocLocal(fctx, `__typeof_${varName}`, narrowedType);

  // Emit unboxing: load original AnyValue, call unbox, store in narrowed local
  fctx.body.push({ op: "local.get", index: originalLocalIdx });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.set", index: narrowedLocalIdx });

  // Remap the variable to use the narrowed local
  fctx.localMap.set(varName, narrowedLocalIdx);

  return { originalLocalIdx, narrowedLocalIdx };
}

function compileIfStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.IfStatement,
): void {
  // Detect null-narrowing pattern before compiling the condition
  const narrowing = detectNullNarrowing(stmt.expression);

  // Detect typeof narrowing pattern (typeof x === "string" / "number")
  const typeofNarrowing = detectTypeofNarrowing(stmt.expression);

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);

  // The 'if' instruction adds one label level. Increment break/continue depths
  // so that br instructions emitted inside the if branches target the correct labels.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

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

  // Apply typeof narrowing at start of the appropriate branch
  let typeofNarrowResult: { originalLocalIdx: number; narrowedLocalIdx: number } | null = null;
  if (typeofNarrowing && typeofNarrowing.narrowedBranch === "then") {
    typeofNarrowResult = applyTypeofNarrowing(ctx, fctx, typeofNarrowing.varName, typeofNarrowing.typeLiteral);
  }

  if (ts.isBlock(stmt.thenStatement)) {
    for (const s of stmt.thenStatement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.thenStatement);
  }
  const thenInstrs = fctx.body;

  // Restore typeof narrowing after then branch
  if (typeofNarrowResult) {
    fctx.localMap.set(typeofNarrowing!.varName, typeofNarrowResult.originalLocalIdx);
  }

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
  let typeofNarrowResultElse: { originalLocalIdx: number; narrowedLocalIdx: number } | null = null;
  if (stmt.elseStatement) {
    fctx.body = [];

    // Apply typeof narrowing for else branch
    if (typeofNarrowing && typeofNarrowing.narrowedBranch === "else") {
      typeofNarrowResultElse = applyTypeofNarrowing(ctx, fctx, typeofNarrowing.varName, typeofNarrowing.typeLiteral);
    }

    if (ts.isBlock(stmt.elseStatement)) {
      for (const s of stmt.elseStatement.statements) {
        compileStatement(ctx, fctx, s);
      }
    } else {
      compileStatement(ctx, fctx, stmt.elseStatement);
    }
    elseInstrs = fctx.body;

    // Restore typeof narrowing after else branch
    if (typeofNarrowResultElse) {
      fctx.localMap.set(typeofNarrowing!.varName, typeofNarrowResultElse.originalLocalIdx);
    }
  }

  popBody(fctx, savedBody);

  // Restore original narrowing state (leaving the if block clears narrowing)
  fctx.narrowedNonNull = savedNarrowedNonNull;

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

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
  adjustRethrowDepth(fctx, 2);

  // Track break/continue depths
  // Inside the generated structure, br 1 = break, br 0 = continue
  fctx.breakStack.push(1); // break: exit the outer block
  fctx.continueStack.push(0); // continue: restart the loop

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break out of block

  // Compile body — must save/restore block-scoped shadows so that let/const
  // declarations inside the loop body do not leak into the outer scope (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
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
  adjustRethrowDepth(fctx, -2);

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
 * Detect integer loop counter pattern: for (let i = INT; i < EXPR; i++)
 * Returns the variable name and initial integer value if the pattern matches,
 * or null if it doesn't match.
 */
function detectI32LoopVar(stmt: ts.ForStatement): { name: string; initValue: number } | null {
  // 1. Check initializer: must be a single variable declaration with an integer literal
  if (!stmt.initializer || !ts.isVariableDeclarationList(stmt.initializer)) return null;
  const decls = stmt.initializer.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0];
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  if (!decl.initializer || !ts.isNumericLiteral(decl.initializer)) return null;
  const initValue = Number(decl.initializer.text.replace(/_/g, ""));
  if (!Number.isInteger(initValue) || initValue < -2147483648 || initValue > 2147483647) return null;

  // 2. Check condition: must be i < EXPR, i <= EXPR, EXPR > i, or EXPR >= i
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  let isValidCondition = false;
  if ((op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) &&
      ts.isIdentifier(cond.left) && cond.left.text === name) {
    isValidCondition = true;
  }
  if ((op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) &&
      ts.isIdentifier(cond.right) && cond.right.text === name) {
    isValidCondition = true;
  }
  if (!isValidCondition) return null;

  // 3. Check incrementor: must be i++, ++i, i--, --i, i += INT, or i -= INT
  if (!stmt.incrementor) return null;
  const incr = stmt.incrementor;
  if (ts.isPostfixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken &&
        incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isPrefixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken &&
        incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isBinaryExpression(incr)) {
    if (!ts.isIdentifier(incr.left) || incr.left.text !== name) return null;
    if (incr.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken &&
        incr.operatorToken.kind !== ts.SyntaxKind.MinusEqualsToken) return null;
    // The RHS must be an integer literal
    if (!ts.isNumericLiteral(incr.right)) return null;
    const stepVal = Number(incr.right.text.replace(/_/g, ""));
    if (!Number.isInteger(stepVal)) return null;
  } else {
    return null;
  }

  return { name, initValue };
}

function compileForStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForStatement,
): void {
  // Save localMap entries for let/const initializers that shadow outer variables.
  // `for (let x = ...; ...)` creates a block scope that ends after the loop.
  let savedForScope: Map<string, number> | null = null;
  if (
    stmt.initializer &&
    ts.isVariableDeclarationList(stmt.initializer) &&
    (stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))
  ) {
    for (const decl of stmt.initializer.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        const existing = fctx.localMap.get(name);
        if (existing !== undefined) {
          if (!savedForScope) savedForScope = new Map();
          savedForScope.set(name, existing);
          fctx.localMap.delete(name);
        }
      }
    }
  }

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
        let wasmType = resolveWasmType(ctx, varType);

        // Integer loop inference: if this variable is detected as an integer loop
        // counter (e.g. for (let i = 0; i < n; i++)), use i32 instead of f64
        const i32LoopInfo = detectI32LoopVar(stmt);
        const isI32LoopVar = i32LoopInfo !== null && i32LoopInfo.name === name && wasmType.kind === "f64";
        if (isI32LoopVar) {
          wasmType = { kind: "i32" };
        }

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
          if (isI32LoopVar) {
            // Emit i32.const directly for the integer init value
            fctx.body.push({ op: "i32.const", value: i32LoopInfo!.initValue });
            fctx.body.push({ op: "local.set", index: localIdx });
          } else {
            const forInitType = compileExpression(ctx, fctx, decl.initializer, wasmType);
            if (forInitType && !valTypesMatch(forInitType, wasmType)) {
              coerceType(ctx, fctx, forInitType, wasmType);
            }
            emitCoercedLocalSet(ctx, fctx, localIdx, forInitType ?? wasmType);
          }
        }
        // Set TDZ flag for let/const loop vars so they are no longer in TDZ (#790)
        if (!isVar) {
          const tdzFlagIdx = fctx.tdzFlagLocals?.get(name);
          if (tdzFlagIdx !== undefined) {
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "local.set", index: tdzFlagIdx });
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
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

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

  // Body (inside $continue block) — save/restore block-scoped shadows so that
  // let/const declarations inside the loop body do not leak into outer scope (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
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
  adjustRethrowDepth(fctx, -3);

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

  // Restore localMap entries for for-loop let/const initializers
  if (savedForScope) {
    for (const [name, idx] of savedForScope) {
      fctx.localMap.set(name, idx);
    }
  }
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
  adjustRethrowDepth(fctx, 3);

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to condition)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
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
  adjustRethrowDepth(fctx, -3);

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
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
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
    if (switchIsString && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
      fctx.body.push({ op: "call", funcIdx: flattenIdx });
    }
    compileExpression(ctx, fctx, caseClause.expression, wasmType);
    if (switchIsString && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
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
  adjustRethrowDepth(fctx, 1);

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
      adjustRethrowDepth(fctx, 1);

      for (const s of clause.statements) {
        compileStatement(ctx, fctx, s);
      }

      // Restore depths after case body compilation
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!--;
      for (let i = 0; i < fctx.continueStack.length; i++)
        fctx.continueStack[i]!--;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
      adjustRethrowDepth(fctx, -1);

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
  adjustRethrowDepth(fctx, -1);

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
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get to extract properties (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
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
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          });
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
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

    // Find the struct fields by looking up the struct name from reverse map
    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
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
    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;

      // Handle rest element: for (const { a, ...rest } of arr)
      if (element.dotDotDotToken) {
        if (ts.isIdentifier(element.name)) {
          const restName = element.name.text;
          let restIdx = fctx.localMap.get(restName);
          if (restIdx === undefined) {
            restIdx = allocLocal(fctx, restName, { kind: "externref" });
          }
          // Collect excluded keys
          const excludedKeys: string[] = [];
          for (const el of pattern.elements) {
            if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
            const pn = el.propertyName ?? el.name;
            if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
            else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
            else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
          }
          let restObjIdx = ctx.funcMap.get("__extern_rest_object");
          if (restObjIdx === undefined) {
            const importsBefore = ctx.numImportFuncs;
            const restObjType = addFuncType(ctx,
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }]);
            addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
            shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
            restObjIdx = ctx.funcMap.get("__extern_rest_object");
          }
          if (restObjIdx !== undefined) {
            const excludedStr = excludedKeys.join(",");
            addStringConstantGlobal(ctx, excludedStr);
            const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
            if (excludedStrIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: elemLocal });
              fctx.body.push({ op: "extern.convert_any" } as Instr);
              fctx.body.push({ op: "global.get", index: excludedStrIdx });
              fctx.body.push({ op: "call", funcIdx: restObjIdx });
              fctx.body.push({ op: "local.set", index: restIdx });
            }
          }
        }
        continue;
      }

      const propNameNode = element.propertyName ?? element.name;
      let propNameText = ts.isIdentifier(propNameNode) ? propNameNode.text
        : ts.isStringLiteral(propNameNode) ? propNameNode.text
        : ts.isNumericLiteral(propNameNode) ? propNameNode.text
        : undefined;
      // Try resolving computed property names at compile time
      if (!propNameText && ts.isComputedPropertyName(propNameNode)) {
        propNameText = resolveComputedKeyExpression(ctx, propNameNode.expression);
      }
      if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
      const localName = element.name.text;
      if (!propNameText) continue; // skip truly unresolvable computed property names

      const fieldIdx = fields.findIndex((f) => f.name === propNameText);
      if (fieldIdx === -1) {
        // Field not found in struct — property is "undefined" at runtime.
        // Use the default value if one is provided, otherwise use the
        // appropriate "undefined" sentinel for the target type.
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          });
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
        continue;
      }

      const fieldEntry = fields[fieldIdx];
      if (!fieldEntry) continue;
      const fieldType = fieldEntry.type;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Handle default value
      if (element.initializer) {
        emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }

    }); // end null guard for for-of object destructuring
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring in for-of: for (var [a, b] of arr)
    // Element may be a vec struct (array wrapper) OR a tuple struct.

    // Handle externref elements: use __extern_get to extract indexed properties
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get(elem, box(i)) for each binding (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // Non-ref, non-externref (f64, i32): assign defaults or undefined sentinels
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          });
          fctx.body.push(...instrs);
        } else {
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
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

      emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
        for (let i = 0; i < pattern.elements.length; i++) {
          const element = pattern.elements[i]!;
          if (ts.isOmittedExpression(element)) continue;

          if (i >= tupleFields.length) break; // more bindings than tuple fields

          const fieldType = tupleFields[i]!.type;

          // Handle rest element — convert tuple to externref and slice
          if (ts.isBindingElement(element) && element.dotDotDotToken) {
            const restName = ts.isIdentifier(element.name)
              ? element.name.text
              : `__rest_${fctx.locals.length}`;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            let sliceIdx = ctx.funcMap.get("__extern_slice");
            if (sliceIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const sliceType = addFuncType(ctx,
                [{ kind: "externref" }, { kind: "f64" }],
                [{ kind: "externref" }]);
              addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              sliceIdx = ctx.funcMap.get("__extern_slice");
            }
            if (sliceIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: elemLocal });
              fctx.body.push({ op: "extern.convert_any" } as Instr);
              fctx.body.push({ op: "f64.const", value: i });
              fctx.body.push({ op: "call", funcIdx: sliceIdx });
              fctx.body.push({ op: "local.set", index: restIdx });
            }
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

          if (element.initializer) {
            emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
          } else {
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        }
      }); // end null guard for for-of tuple destructuring
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

    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
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

        // Handle rest element: for (const [...rest] of arr) or for (const [a, ...rest] of arr)
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          const restName = ts.isIdentifier(element.name)
            ? element.name.text
            : `__rest_${fctx.locals.length}`;

          // Compute rest length: max(0, original.length - i)
          const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" } as Instr);
          fctx.body.push({ op: "local.set", index: restLenLocal });
          // Clamp to 0 if negative
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "i32.lt_s" } as Instr);
          fctx.body.push({ op: "select" } as Instr);
          fctx.body.push({ op: "local.set", index: restLenLocal });

          // Create new data array: array.new_default(restLen)
          const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: innerArrTypeIdx });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: innerArrTypeIdx } as Instr);
          fctx.body.push({ op: "local.set", index: restArrLocal });

          // array.copy(restArr, 0, srcData, i, restLen)
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 }); // src data
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "array.copy", dstTypeIdx: innerArrTypeIdx, srcTypeIdx: innerArrTypeIdx } as Instr);

          // Create new vec struct: struct.new(restLen, restArr)
          const restVecType: ValType = { kind: "ref", typeIdx: structTypeIdx };
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);

          let restIdx = fctx.localMap.get(restName);
          if (restIdx === undefined) {
            restIdx = allocLocal(fctx, restName, restVecType);
          }
          fctx.body.push({ op: "local.set", index: restIdx });
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

        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for for-of array destructuring
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
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, init, targetType ?? { kind: "externref" });
            fctx.body.push({ op: "local.set", index: targetLocal } as Instr);
          });
          fctx.body.push(...instrs);
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") return;

    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) return;

    for (const prop of expr.properties) {
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
      let propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text
        : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // skip truly unresolvable computed property names
      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer) ? prop.initializer.text : propName;

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) continue;

      const targetLocal = fctx.localMap.get(targetName);
      if (targetLocal === undefined) continue;

      const fieldEntry2 = fields[fieldIdx];
      if (!fieldEntry2) continue;
      const fieldType = fieldEntry2.type;
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
      // Externref elements: use __extern_get to extract indexed properties
      if (elemType.kind === "externref") {
        compileForOfAssignDestructuringExternref(ctx, fctx, expr, elemLocal);
      }
      return;
    }

    const innerVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const innerStructDef = ctx.mod.types[innerVecTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTuple = innerStructDef && innerStructDef.kind === "struct" &&
      innerStructDef.fields.length > 0 &&
      innerStructDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    // Handle 0-field structs (empty tuples like []) — all elements are OOB, apply defaults
    if (innerStructDef && innerStructDef.kind === "struct" && innerStructDef.fields.length === 0) {
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;
        let oobTarget: ts.Expression = el;
        let oobInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          oobTarget = el.left;
          oobInit = el.right;
        }
        if (oobInit && ts.isIdentifier(oobTarget)) {
          const oobLocal = fctx.localMap.get(oobTarget.text);
          if (oobLocal !== undefined) {
            const oobType = getLocalType(fctx, oobLocal);
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
              fctx.body.push({ op: "local.set", index: oobLocal } as Instr);
            });
            fctx.body.push(...instrs);
          }
        }
      }
      return;
    }

    if (isTuple) {
      // Tuple assignment destructuring: extract fields directly
      const tupleFields = (innerStructDef as { fields: { name?: string; type: ValType }[] }).fields;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        // OOB: tuple has fewer fields than destructuring targets
        if (i >= tupleFields.length) {
          // If element has a default initializer, apply it directly (value is undefined/OOB)
          let oobTarget: ts.Expression = el;
          let oobInit: ts.Expression | undefined;
          if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            oobTarget = el.left;
            oobInit = el.right;
          }
          if (oobInit && ts.isIdentifier(oobTarget)) {
            const oobLocal = fctx.localMap.get(oobTarget.text);
            if (oobLocal !== undefined) {
              const oobType = getLocalType(fctx, oobLocal);
              const instrs = collectInstrs(fctx, () => {
                compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
                fctx.body.push({ op: "local.set", index: oobLocal } as Instr);
              });
              fctx.body.push(...instrs);
            }
          }
          continue;
        }

        const fieldType = tupleFields[i]!.type;

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, fieldType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        const targetLocal = fctx.localMap.get(targetEl.text);
        if (targetLocal === undefined) continue;

        const targetType = getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });

        if (defaultInit) {
          // Check for undefined and apply default — BEFORE type coercion
          emitDefaultValueCheck(ctx, fctx, fieldType, targetLocal, defaultInit, targetType ?? undefined);
        } else {
          if (targetType && !valTypesMatch(fieldType, targetType)) {
            coerceType(ctx, fctx, fieldType, targetType);
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
        }
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

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, innerElemType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        const targetLocal = fctx.localMap.get(targetEl.text);
        if (targetLocal === undefined) continue;

        const targetType = getLocalType(fctx, targetLocal);

        if (defaultInit && innerElemType.kind === "externref") {
          // For externref elements with defaults, do explicit bounds check.
          // OOB produces ref.null.extern (Wasm null) which is indistinguishable from JS null.
          // We must apply defaults for OOB but NOT for JS null.
          const arrDataLocal = allocLocal(fctx, `__forof_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: innerArrTypeIdx });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "local.tee", index: arrDataLocal });
          fctx.body.push({ op: "array.len" });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.gt_s" } as Instr); // len > i means in-bounds

          const hintType = targetType ?? innerElemType;
          // Then branch: in-bounds — get element, check for undefined, apply default if needed
          const thenInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: arrDataLocal } as Instr);
            fctx.body.push({ op: "i32.const", value: i } as Instr);
            fctx.body.push({ op: "array.get", typeIdx: innerArrTypeIdx } as Instr);
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal, defaultInit!, targetType ?? undefined);
          });
          // Else branch: OOB — apply default directly
          const elseInstrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, defaultInit!, hintType);
            fctx.body.push({ op: "local.set", index: targetLocal } as Instr);
          });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: elseInstrs,
          } as Instr);
        } else {
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

          if (defaultInit) {
            // Check for undefined and apply default — BEFORE type coercion
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal, defaultInit, targetType ?? undefined);
          } else {
            if (targetType && !valTypesMatch(innerElemType, targetType)) {
              coerceType(ctx, fctx, innerElemType, targetType);
            }
            fctx.body.push({ op: "local.set", index: targetLocal });
          }
        }
      }
    }
  }
}

/**
 * Handle assignment destructuring of externref arrays in for-of.
 * Uses __extern_get(elem, box(i)) for each element, with default value support.
 */
function compileForOfAssignDestructuringExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  elemLocal: number,
): void {
  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return;

  // Ensure __box_number is available
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) return;

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isSpreadElement(el)) continue;

    // Handle assignment with default: [v = 10]
    let targetEl: ts.Expression = el;
    let defaultInit: ts.Expression | undefined;
    if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      targetEl = el.left;
      defaultInit = el.right;
    }

    if (!ts.isIdentifier(targetEl)) continue;

    const targetLocal = fctx.localMap.get(targetEl.text);
    if (targetLocal === undefined) continue;

    // Emit: __extern_get(elem, box(i)) -> externref
    fctx.body.push({ op: "local.get", index: elemLocal });
    fctx.body.push({ op: "f64.const", value: i });
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    if (defaultInit) {
      const targetType = getLocalType(fctx, targetLocal);
      emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInit, targetType ?? undefined);
    } else {
      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
    }
  }
}

/** Collect all identifier names from a binding pattern (ObjectBindingPattern or ArrayBindingPattern) */
function collectBindingNames(pattern: ts.BindingPattern): string[] {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.text);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        names.push(...collectBindingNames(element.name));
      }
    }
  }
  return names;
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
  if (isStringType(exprTsType) && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
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
    // Type checker didn't resolve as Array — tentatively compile the expression
    // to check if it produces a vec struct (e.g. tuple types, union types, etc.).
    // If so, use the efficient array path; otherwise fall back to host iterator.
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) {
      compileForOfIterator(ctx, fctx, stmt);
    }
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

  // Mark position for null guard wrapping
  const strNullGuardStart = fctx.body.length;

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
    // Track const bindings — assignment to const in for-of should throw TypeError
    if ((stmt.initializer.flags & ts.NodeFlags.Const) && ts.isIdentifier(decl.name)) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(decl.name.text);
    }
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
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

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

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
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
  adjustRethrowDepth(fctx, -2);

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

  // Null guard: if string ref is nullable, throw TypeError on null (#775)
  // In JS, `for (const c of null)` throws TypeError
  if (strType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(strNullGuardStart);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: strLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "ref.null.extern" } as Instr,
        { op: "throw", tagIdx } as Instr,
      ],
      else: guardedInstrs,
    });
  }
}

/**
 * Tentatively try to compile for...of as an array iteration.
 * Compiles the iterable expression, checks if the result is a vec struct,
 * and if so delegates to compileForOfArray (which re-compiles the expression).
 * Returns true if the array path was used, false if caller should fall back.
 */
function compileForOfArrayTentative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): boolean {
  // Tentatively compile just the expression to discover its Wasm type
  const bodyLenBefore = fctx.body.length;
  const localsLenBefore = fctx.locals.length;
  const exprType = compileExpression(ctx, fctx, stmt.expression);

  // Check if it compiled to a ref to a vec struct (not just any struct —
  // a class instance is also a struct but not iterable via array access).
  // A vec struct has {length: i32, data: (ref $arr)} — verified by getArrTypeIdxFromVec.
  if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
    const typeDef = ctx.mod.types[exprType.typeIdx];
    if (typeDef && typeDef.kind === "struct" && getArrTypeIdxFromVec(ctx, exprType.typeIdx) >= 0) {
      // Confirmed vec struct — undo the tentative compilation and use the
      // full array path (which compiles the expression again with proper setup)
      fctx.body.length = bodyLenBefore;
      fctx.locals.length = localsLenBefore;
      compileForOfArray(ctx, fctx, stmt);
      return true;
    }
  }

  // Not a vec struct — undo tentative compilation, let caller use iterator path
  fctx.body.length = bodyLenBefore;
  fctx.locals.length = localsLenBefore;
  return false;
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
  fctx.body.push({ op: "local.set", index: vecLocal });

  // Mark position for null guard wrapping (struct.get on null ref traps)
  const nullGuardStart = fctx.body.length;

  // Extract data array from vec into a local
  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
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
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPattern = decl.name;
      // Allocate a temp local to hold the element for destructuring
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
      // Track const bindings for all identifiers in the destructuring pattern
      if (isConst) {
        collectBindingNames(decl.name).forEach(n => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      // Track const bindings — assignment to const in for-of should throw TypeError
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
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
  adjustRethrowDepth(fctx, 2);

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

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
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
  adjustRethrowDepth(fctx, -2);

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

  // Null guard: if vec ref is nullable, guard against null (#775, #789)
  // If null from a failed guarded cast (wrong struct type), just skip the loop.
  // Only throw TypeError for genuinely null values (e.g. `for (const x of null)`).
  if (vecType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(nullGuardStart);
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    if (backupLocal !== undefined) {
      // A guarded cast backup exists: distinguish "wrong type" from "genuinely null"
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "ref.null.extern" } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],  // wrong struct type → skip loop
          } as Instr,
        ],
        else: guardedInstrs,
      });
    } else {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "ref.null.extern" } as Instr,
          { op: "throw", tagIdx } as Instr,
        ],
        else: guardedInstrs,
      });
    }
  }
}

/**
 * Handle assignment destructuring for the iterator protocol path.
 * Element is externref — use __extern_get(elem, key) to extract properties/indices.
 */
function compileForOfIteratorAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  stmt: ts.ForOfStatement,
): void {
  // Ensure __extern_get is available
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (getIdx === undefined) return;

  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of iterable) — use __extern_get(elem, "propName") for each property
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) continue;
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;

      const propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text
        : undefined;
      if (!propName) continue;

      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer) ? prop.initializer.text : propName;

      const targetLocal = fctx.localMap.get(targetName);
      if (targetLocal === undefined) continue;

      // Register string constant for property name
      addStringConstantGlobal(ctx, propName);
      const strGlobalIdx = ctx.stringGlobalMap.get(propName);
      if (strGlobalIdx === undefined) continue;

      // Refresh getIdx in case addStringConstantGlobal shifted indices
      getIdx = ctx.funcMap.get("__extern_get");
      if (getIdx === undefined) continue;

      // Emit: __extern_get(elem, "propName") -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "global.get", index: strGlobalIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx });

      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of iterable) — use __extern_get(elem, box(i)) for each element

    // Ensure __box_number is available
    let boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      boxIdx = ctx.funcMap.get("__box_number");
      // Refresh getIdx since it may have shifted
      getIdx = ctx.funcMap.get("__extern_get");
    }
    if (boxIdx === undefined || getIdx === undefined) return;

    for (let i = 0; i < expr.elements.length; i++) {
      const el = expr.elements[i]!;
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isSpreadElement(el)) continue;
      if (!ts.isIdentifier(el)) continue;

      const targetLocal = fctx.localMap.get(el.text);
      if (targetLocal === undefined) continue;

      // Emit: __extern_get(elem, box(i)) -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx! });

      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
    }
  }
}

/**
 * Compile for...of using direct Wasm method dispatch when the iterable
 * is a known struct with a @@iterator method.
 *
 * Calls @@iterator() directly in Wasm, then loops calling next() directly,
 * extracting done/value from struct fields — no host imports needed.
 *
 * Returns true if successfully compiled, false if caller should fall back.
 */
function compileForOfDirectIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  iterableType: ValType,
  iterMethodIdx: number,
): boolean {
  // Get the return type of the @@iterator method to find the iterator struct
  const iterMethodDef = ctx.mod.functions[iterMethodIdx - ctx.numImportFuncs];
  if (!iterMethodDef) return false;
  const iterMethodType = ctx.mod.types[iterMethodDef.typeIdx];
  if (!iterMethodType || iterMethodType.kind !== "func" || iterMethodType.results.length === 0) return false;

  const iterResultType = iterMethodType.results[0]!;
  if (iterResultType.kind !== "ref" && iterResultType.kind !== "ref_null") return false;

  const iterStructTypeIdx = iterResultType.typeIdx;
  const iterStructDef = ctx.mod.types[iterStructTypeIdx];
  if (!iterStructDef || iterStructDef.kind !== "struct") return false;

  // Find the struct name for the iterator type to look up the next method
  let iterStructName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === iterStructTypeIdx) { iterStructName = name; break; }
  }
  if (!iterStructName) return false;

  const nextMethodIdx = ctx.funcMap.get(`${iterStructName}_next`);
  if (nextMethodIdx === undefined) return false;

  // Get the return type of next() to find the result struct ({value, done})
  const nextMethodDef = ctx.mod.functions[nextMethodIdx - ctx.numImportFuncs];
  if (!nextMethodDef) return false;
  const nextMethodType = ctx.mod.types[nextMethodDef.typeIdx];
  if (!nextMethodType || nextMethodType.kind !== "func" || nextMethodType.results.length === 0) return false;

  const nextResultType = nextMethodType.results[0]!;

  // If next() returns externref, we can't extract done/value in Wasm — fall back
  if (nextResultType.kind !== "ref" && nextResultType.kind !== "ref_null") return false;

  const resultStructTypeIdx = nextResultType.typeIdx;
  const resultStructDef = ctx.mod.types[resultStructTypeIdx];
  if (!resultStructDef || resultStructDef.kind !== "struct") return false;

  // Find "done" and "value" field indices in the result struct
  const resultFields = ctx.structFields.get(iterStructName + "_next_result")
    ?? findStructFieldsByTypeIdx(ctx, resultStructTypeIdx);
  if (!resultFields) return false;

  let doneFieldIdx = -1;
  let valueFieldIdx = -1;
  let doneFieldType: ValType | undefined;
  let valueFieldType: ValType | undefined;

  for (let i = 0; i < resultFields.length; i++) {
    const f = resultFields[i]!;
    if (f.name === "done") { doneFieldIdx = i; doneFieldType = f.type; }
    if (f.name === "value") { valueFieldIdx = i; valueFieldType = f.type; }
  }

  if (doneFieldIdx < 0 || valueFieldIdx < 0 || !doneFieldType || !valueFieldType) return false;

  // We have everything we need — compile the full iteration loop in Wasm!

  // Null check on iterable
  const nullTmp = allocLocal(fctx, `__forit_stmp_${fctx.locals.length}`, iterableType);
  fctx.body.push({ op: "local.tee", index: nullTmp });
  fctx.body.push({ op: "ref.is_null" });
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "ref.null.extern" } as Instr,
      { op: "throw", tagIdx } as Instr,
    ],
    else: [],
  });

  // Call @@iterator method: iter = obj[Symbol.iterator]()
  fctx.body.push({ op: "local.get", index: nullTmp });
  if (iterableType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: iterMethodIdx });

  const iterLocal = allocLocal(fctx, `__forit_iter_${fctx.locals.length}`, iterResultType);
  fctx.body.push({ op: "local.set", index: iterLocal });

  // Allocate result local
  const resultLocal = allocLocal(fctx, `__forit_res_${fctx.locals.length}`, nextResultType);

  // Declare the loop variable
  const elemType: ValType = valueFieldType;
  let elemLocal: number;
  let destructPatternIter: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExprIter: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
      if (isConst) {
        collectBindingNames(decl.name).forEach(n => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forit_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    assignDestructExprIter = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
  }

  // Look up the return() method on the iterator struct for iterator close (#851)
  const returnMethodIdx = ctx.funcMap.get(`${iterStructName}_return`);

  // Done flag: tracks whether iterator completed normally (done=true) (#851)
  const doneFlagDirect = allocLocal(fctx, `__forit_done_${fctx.locals.length}`, { kind: "i32" });

  // Build loop body
  const savedBody = pushBody(fctx);

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // Safety guard
  const iterCountLocal = allocLocal(fctx, `__forit_guard_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.tee", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1_000_000 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // Call next(): result = iter.next()
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (iterResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: nextMethodIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: result.done -> set done flag and break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "struct.get", typeIdx: resultStructTypeIdx, fieldIdx: doneFieldIdx });
  // done field might be i32 (boolean) or f64; convert to i32 for br_if
  if (doneFieldType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" } as Instr);
  }
  // If done, set the done flag to 1 before breaking (#851)
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlagDirect } as Instr,
      { op: "br", depth: 2 } as Instr, // break out of block (if + loop = depth 2)
    ],
    else: [],
  } as unknown as Instr);

  // Get value: elem = result.value
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "struct.get", typeIdx: resultStructTypeIdx, fieldIdx: valueFieldIdx });

  // Coerce value to element type if needed
  const targetElemType = getLocalType(fctx, elemLocal) ?? elemType;
  if (!valTypesMatch(valueFieldType, targetElemType)) {
    coerceType(ctx, fctx, valueFieldType, targetElemType);
  }
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring, handle it
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 });

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

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

  // Iterator close protocol (#851): call iterator.return() only on abrupt
  // completion (break/return), NOT on normal completion (done=true).
  if (returnMethodIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlagDirect });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: iterLocal } as Instr,
        ...(iterResultType.kind === "ref_null" ? [{ op: "ref.as_non_null" } as Instr] : []),
        { op: "call", funcIdx: returnMethodIdx } as Instr,
        // Drop the return value (return() returns {value, done})
        { op: "drop" } as Instr,
      ],
      else: [],
    } as unknown as Instr);
  }

  return true;
}

/** Helper to find struct fields by type index when the name isn't directly in structFields */
function findStructFieldsByTypeIdx(
  ctx: CodegenContext,
  typeIdx: number,
): { name: string; type: ValType }[] | undefined {
  for (const [name, fields] of ctx.structFields) {
    const idx = ctx.structMap.get(name);
    if (idx === typeIdx) return fields;
  }
  // Fall back to the type definition if available
  const typeDef = ctx.mod.types[typeIdx];
  if (typeDef && typeDef.kind === "struct") {
    return typeDef.fields.map((f, i) => ({
      name: f.name ?? `field_${i}`,
      type: f.type,
    }));
  }
  return undefined;
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
  // Compile the iterable expression
  const iterableType = compileExpression(ctx, fctx, stmt.expression);
  if (!iterableType) {
    ctx.errors.push({
      message: "for-of: failed to compile iterable expression",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Check if the iterable is a known struct type with a @@iterator method.
  // If so, compile the entire iteration loop in Wasm without host imports.
  if (iterableType.kind === "ref" || iterableType.kind === "ref_null") {
    let structName: string | undefined;
    for (const [name, idx] of ctx.structMap) {
      if (idx === iterableType.typeIdx) { structName = name; break; }
    }
    if (structName) {
      const methodFullName = `${structName}_@@iterator`;
      const iterMethodIdx = ctx.funcMap.get(methodFullName);
      if (iterMethodIdx !== undefined) {
        // Try to compile the full iteration loop in Wasm (no host imports)
        if (compileForOfDirectIterator(ctx, fctx, stmt, iterableType, iterMethodIdx)) {
          return;
        }
      }
    }
  }

  // Fallback: host-delegated iterator protocol
  // Coerce to externref if the iterable is a struct ref (GC type).
  if (iterableType.kind !== "externref") {
    coerceType(ctx, fctx, iterableType, { kind: "externref" });
  }

  // Null check: throw TypeError for `for (const x of null)` (#775, #789)
  // If null from a failed guarded cast, skip instead of throw.
  {
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    const tagIdx = ensureExnTag(ctx);
    const iterTmp = allocLocal(fctx, `__forit_null_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: iterTmp });
    fctx.body.push({ op: "ref.is_null" });
    if (backupLocal !== undefined) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "ref.null.extern" } as Instr,
              { op: "throw", tagIdx } as Instr,
            ],
            else: [],
          } as Instr,
        ],
        else: [],
      });
    } else {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "ref.null.extern" } as Instr,
          { op: "throw", tagIdx } as Instr,
        ],
        else: [],
      });
    }
    fctx.body.push({ op: "local.get", index: iterTmp });
  }

  // Look up the iterator host import function indices
  let iteratorIdx: number | undefined;
  if (stmt.awaitModifier) {
    iteratorIdx = ensureAsyncIterator(ctx, fctx);
  }
  if (iteratorIdx === undefined) {
    iteratorIdx = ctx.funcMap.get("__iterator");
  }
  if (iteratorIdx === undefined) {
    ctx.errors.push({
      message: "for-of on non-array type requires iterator imports",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Call __iterator/__async_iterator(obj) -> externref (the iterator)
  fctx.body.push({ op: "call", funcIdx: iteratorIdx });

  const nextIdx = ctx.funcMap.get("__iterator_next");
  const doneIdx = ctx.funcMap.get("__iterator_done");
  const valueIdx = ctx.funcMap.get("__iterator_value");
  const returnIdx = ctx.funcMap.get("__iterator_return");
  if (
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
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
      if (isConst) {
        collectBindingNames(decl.name).forEach(n => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
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
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Done flag: tracks whether iterator completed normally (done=true).
  // Used after the loop to decide whether to call iterator.return() (#851).
  const doneFlag = allocLocal(fctx, `__forof_done_${fctx.locals.length}`, { kind: "i32" });

  // Safety guard: max iteration counter to prevent infinite loops from collection mutation
  const iterCountLocal = allocLocal(fctx, `__forof_guard_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.tee", index: iterCountLocal });
  fctx.body.push({ op: "i32.const", value: 1_000_000 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break if >1M iterations

  // Call __iterator_next(iter) → result
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "call", funcIdx: nextIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: __iterator_done(result) → i32, break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "call", funcIdx: doneIdx });
  // If done, set the done flag to 1 before breaking
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlag } as Instr,
      { op: "br", depth: 2 } as Instr, // break out of block (if + loop = depth 2)
    ],
    else: [],
  } as unknown as Instr);

  // Get value: elem = __iterator_value(result)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "call", funcIdx: valueIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring pattern, destructure from the element
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals.
  // For iterator path, elemType is externref — use __extern_get to extract properties/indices.
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
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
  adjustRethrowDepth(fctx, -2);

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

  // Iterator close protocol (#851): call iterator.return() only on abrupt
  // completion (break/return/throw), NOT on normal completion (done=true).
  if (returnIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlag });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: iterLocal } as Instr,
        { op: "call", funcIdx: returnIdx } as Instr,
      ],
      else: [],
    } as unknown as Instr);
  }
}

function compileForInStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForInStatement,
): void {
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

  // Look up for-in host imports
  const keysIdx = ctx.funcMap.get("__for_in_keys");
  const lenIdx = ctx.funcMap.get("__for_in_len");
  const getIdx = ctx.funcMap.get("__for_in_get");

  if (keysIdx === undefined || lenIdx === undefined || getIdx === undefined) {
    // Fallback: static unrolling when host imports are not available (standalone mode)
    const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
    const props = exprType.getProperties();
    if (props.length === 0) return;
    for (const prop of props) {
      const globalIdx = ctx.stringGlobalMap.get(prop.name);
      if (globalIdx === undefined) continue;
      fctx.body.push({ op: "global.get", index: globalIdx });
      fctx.body.push({ op: "local.set", index: keyLocal });
      compileStatement(ctx, fctx, stmt.statement);
    }
    return;
  }

  // Compile the object expression and coerce to externref for the host import
  const exprType = compileExpression(ctx, fctx, stmt.expression);
  if (exprType && exprType.kind !== "externref") {
    coerceType(ctx, fctx, exprType, { kind: "externref" });
  }
  fctx.body.push({ op: "call", funcIdx: keysIdx }); // __for_in_keys(obj) -> keys array

  // Store keys array in a local
  const keysLocal = allocLocal(fctx, `__forin_keys_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keysLocal });

  // Get length
  const lenLocal = allocLocal(fctx, `__forin_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: keysLocal });
  fctx.body.push({ op: "call", funcIdx: lenIdx }); // __for_in_len(keys) -> i32
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Counter
  const iLocal = allocLocal(fctx, `__forin_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Build the user's loop body in a new body segment.
  // Structure: block $break { loop $loop { <cond> block $continue { <body> } <incr> br $loop } }
  // This ensures `continue` (br 0 = exit $continue) falls through to the increment,
  // while `break` (br 2 = exit $break) exits the entire loop.
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  fctx.breakStack.push(2);    // break = depth 2 (exit $break block)
  fctx.continueStack.push(0); // continue = depth 0 (exit $continue block -> falls to incr)

  // Compile the user's loop body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  const userBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // Build the full loop body: condition + key fetch + block{userBody} + increment + br
  const loopBody: Instr[] = [];

  // Condition: i >= length -> break (depth 1 exits $break from inside $loop)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 }); // break out of $break block

  // Get current key: key = keys[i]
  loopBody.push({ op: "local.get", index: keysLocal });
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "call", funcIdx: getIdx }); // __for_in_get(keys, i) -> externref
  loopBody.push({ op: "local.set", index: keyLocal });

  // Wrap user body in block $continue so `continue` exits here
  loopBody.push({
    op: "block",
    blockType: { kind: "empty" },
    body: userBody,
  });

  // Increment counter (reached after user body OR after continue)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });

  loopBody.push({ op: "br", depth: 0 }); // restart $loop

  // Emit block $break { loop $loop { ...loopBody } }
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
    adjustRethrowDepth(fctx, 1);

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
    adjustRethrowDepth(fctx, -1);

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
  let breakIdx: number;
  if (stmt.label) {
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo === undefined) return;
    breakIdx = labelInfo.breakIdx;
  } else {
    breakIdx = fctx.breakStack.length - 1;
  }
  const depth = fctx.breakStack[breakIdx];
  if (depth === undefined) return;

  // Inline finally blocks for any try-with-finally that we're breaking out of.
  // A finallyStack entry applies if the break target is outside the try block,
  // i.e. the breakStack index we're targeting is less than the entry's breakStackLen.
  if (fctx.finallyStack) {
    for (let i = fctx.finallyStack.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack[i]!;
      if (breakIdx < entry.breakStackLen) {
        fctx.body.push(...entry.cloneFinally());
      }
    }
  }

  fctx.body.push({ op: "br", depth });
}

function compileContinueStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ContinueStatement,
): void {
  let contIdx: number;
  if (stmt.label) {
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo === undefined) return;
    contIdx = labelInfo.continueIdx;
  } else {
    contIdx = fctx.continueStack.length - 1;
  }
  const depth = fctx.continueStack[contIdx];
  if (depth === undefined) return;

  // Inline finally blocks for any try-with-finally that we're continuing out of.
  if (fctx.finallyStack) {
    for (let i = fctx.finallyStack.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack[i]!;
      if (contIdx < entry.continueStackLen) {
        fctx.body.push(...entry.cloneFinally());
      }
    }
  }

  fctx.body.push({ op: "br", depth });
}

/**
 * Destructure an externref catch variable into binding pattern locals.
 * The externref value is already on the stack when called.
 * For ObjectBindingPattern: uses __extern_get(obj, "propName") for each property.
 * For ArrayBindingPattern: uses __extern_get(obj, box(index)) for each element.
 */
function compileExternrefCatchDestructure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
  exnLocalIdx: number,
): void {
  // Drop the externref we pushed — we'll use local.get for each property
  fctx.body.push({ op: "drop" });

  if (ts.isObjectBindingPattern(pattern)) {
    // Ensure __extern_get is available
    let getIdx = ensureLateImport(
      ctx, "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const propNameNode = element.propertyName ?? element.name;
      let propNameText: string | undefined;
      if (ts.isIdentifier(propNameNode)) propNameText = propNameNode.text;
      else if (ts.isStringLiteral(propNameNode)) propNameText = propNameNode.text;
      if (!propNameText) continue;

      // Get the local for this binding
      const localName = ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (!localName) continue;
      const localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) continue;

      addStringConstantGlobal(ctx, propNameText);
      const strGlobalIdx = ctx.stringGlobalMap.get(propNameText);
      if (strGlobalIdx === undefined) continue;

      // Refresh getIdx after potential import shifts
      getIdx = ctx.funcMap.get("__extern_get")!;

      // __extern_get(exnLocal, "propName") -> externref, store to binding local
      fctx.body.push({ op: "local.get", index: exnLocalIdx });
      fctx.body.push({ op: "global.get", index: strGlobalIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx });

      // Coerce externref to the local's declared type if needed
      const localType = getLocalType(fctx, localIdx);
      if (localType && localType.kind !== "externref") {
        coerceType(ctx, fctx, { kind: "externref" }, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring: use __extern_get(obj, box(index))
    addUnionImports(ctx);
    let getIdx = ensureLateImport(
      ctx, "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    const boxIdx = ctx.funcMap.get("__box_number");

    let idx = 0;
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) { idx++; continue; }
      if (!ts.isBindingElement(element)) { idx++; continue; }

      const localName = ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (!localName) { idx++; continue; }
      const localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) { idx++; continue; }

      getIdx = ctx.funcMap.get("__extern_get")!;

      // __extern_get(exnLocal, box(index)) -> externref
      fctx.body.push({ op: "local.get", index: exnLocalIdx });
      fctx.body.push({ op: "f64.const", value: idx });
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
      fctx.body.push({ op: "call", funcIdx: getIdx });

      const localType = getLocalType(fctx, localIdx);
      if (localType && localType.kind !== "externref") {
        coerceType(ctx, fctx, { kind: "externref" }, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
      idx++;
    }
  }
}

function compileThrowStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ThrowStatement,
): void {
  // Check if this is a rethrow: `throw e` where `e` is the catch variable
  // of an enclosing catch block. If so, emit `rethrow` to preserve the
  // original exception type and stack trace.
  if (
    stmt.expression &&
    ts.isIdentifier(stmt.expression) &&
    fctx.catchRethrowStack &&
    fctx.catchRethrowStack.length > 0
  ) {
    const thrownName = stmt.expression.text;
    // Search from innermost catch outward
    for (let i = fctx.catchRethrowStack.length - 1; i >= 0; i--) {
      const entry = fctx.catchRethrowStack[i]!;
      if (entry.varName === thrownName) {
        fctx.body.push({ op: "rethrow", depth: entry.depth } as any);
        return;
      }
    }
  }

  const tagIdx = ensureExnTag(ctx);

  if (stmt.expression) {
    // Compile the thrown expression — coerce to externref for the exception tag
    const resultType = compileExpression(ctx, fctx, stmt.expression, {
      kind: "externref",
    });
    // If the expression didn't produce externref, coerce it properly
    if (resultType && resultType.kind !== "externref") {
      coerceType(ctx, fctx, resultType, { kind: "externref" });
    } else if (!resultType) {
      // Expression produced no value (void) — push null externref
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

  // Pre-compile the finally body once so we can clone it into each
  // control-flow path instead of re-compiling the TS statements 2-5 times.
  // This avoids duplicating compilation side-effects and reduces code size
  // variance between insertion points.
  let finallyInstrs: Instr[] | null = null;
  if (stmt.finallyBlock) {
    const savedForFinally = pushBody(fctx);
    // Save/restore block-scoped shadows for let/const in the finally block (#817).
    const savedFinallyScope = saveBlockScopedShadows(fctx, stmt.finallyBlock);
    for (const s of stmt.finallyBlock.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedFinallyScope);
    finallyInstrs = fctx.body;
    popBody(fctx, savedForFinally);
  }

  /** Return a deep clone of the pre-compiled finally instructions. */
  function cloneFinally(): Instr[] {
    return JSON.parse(JSON.stringify(finallyInstrs!));
  }

  // Track finallyInstrs in savedBodies so late import shifts (addUnionImports /
  // flushLateImportShifts) update its function indices during try/catch compilation.
  // Without this, finallyInstrs retains stale pre-shift indices and cloneFinally()
  // produces instructions with wrong call targets.
  if (finallyInstrs) {
    fctx.savedBodies.push(finallyInstrs);
  }

  // Compile the try block body
  const savedBody = pushBody(fctx);

  // Adjust break/continue depths: the try block adds one label level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

  // Push finallyStack entry so return/break/continue inside the try body
  // know to inline the finally instructions before transferring control.
  if (finallyInstrs) {
    if (!fctx.finallyStack) fctx.finallyStack = [];
    fctx.finallyStack.push({
      cloneFinally,
      breakStackLen: fctx.breakStack.length,
      continueStackLen: fctx.continueStack.length,
    });
  }

  // Save/restore block-scoped shadows for let/const in the try block (#817).
  const savedTryScope = saveBlockScopedShadows(fctx, stmt.tryBlock);
  for (const s of stmt.tryBlock.statements) {
    compileStatement(ctx, fctx, s);
  }
  restoreBlockScopedShadows(fctx, savedTryScope);

  // Pop finallyStack before inlining the normal-path finally (avoid double-inline)
  if (finallyInstrs) {
    fctx.finallyStack!.pop();
  }

  // If there's a finally block, inline it at the end of the try body (normal path)
  if (finallyInstrs) {
    fctx.body.push(...cloneFinally());
  }

  const tryBody = fctx.body;

  // Compile catch clause (if present)
  let catches: { tagIdx: number; body: Instr[] }[] = [];
  let catchAllBody: Instr[] | undefined;

  // If there's a finally block but no catch clause, we need a catch_all
  // that runs the finally block and then rethrows the exception.
  if (finallyInstrs && !stmt.catchClause) {
    fctx.body = [];
    fctx.body.push(...cloneFinally());
    fctx.body.push({ op: "rethrow", depth: 0 } as any);
    catchAllBody = fctx.body;
  }

  if (stmt.catchClause) {
    // Allocate the catch variable local (if any) before compiling catch bodies
    // so it's available in both catch $tag and catch_all bodies.
    // Save the previous localMap entry so we can restore it after the catch scope.
    let exnLocalIdx: number | null = null;
    let savedCatchVarIdx: number | undefined;
    if (
      stmt.catchClause.variableDeclaration &&
      ts.isIdentifier(stmt.catchClause.variableDeclaration.name)
    ) {
      const varName = stmt.catchClause.variableDeclaration.name.text;
      savedCatchVarIdx = fctx.localMap.get(varName);
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

    // Pre-compile the catch clause body once.  When a finally block exists the
    // catch body is placed inside an inner try, so we compile at +1 depth.
    // The resulting instructions are cloned for the catch_all handler.
    //
    // Push the catch variable onto catchRethrowStack so that `throw e` inside
    // the catch body can emit `rethrow` instead of `throw $tag`.
    let catchVarName: string | undefined;
    if (
      stmt.catchClause.variableDeclaration &&
      ts.isIdentifier(stmt.catchClause.variableDeclaration.name)
    ) {
      catchVarName = stmt.catchClause.variableDeclaration.name.text;
    }

    let catchBodyInstrs: Instr[];
    {
      const prevBody = fctx.body;
      // Track tryBody in savedBodies so late imports during catch body
      // compilation can shift function indices inside it. Without this,
      // tryBody is orphaned and its call instructions get stale indices.
      fctx.savedBodies.push(tryBody);
      fctx.body = [];

      // Push rethrow info: depth starts at 0 (directly inside catch)
      if (catchVarName) {
        if (!fctx.catchRethrowStack) fctx.catchRethrowStack = [];
        fctx.catchRethrowStack.push({ varName: catchVarName, depth: 0 });
      }

      if (finallyInstrs) {
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
        adjustRethrowDepth(fctx, 1);

        // Push finallyStack so return/break/continue inside catch body also
        // inline the finally instructions before transferring control.
        if (!fctx.finallyStack) fctx.finallyStack = [];
        fctx.finallyStack.push({
          cloneFinally,
          breakStackLen: fctx.breakStack.length,
          continueStackLen: fctx.continueStack.length,
        });
      }

      // Emit catch binding destructuring if the catch variable is a binding pattern
      if (
        exnLocalIdx !== null &&
        stmt.catchClause.variableDeclaration &&
        (ts.isObjectBindingPattern(stmt.catchClause.variableDeclaration.name) ||
         ts.isArrayBindingPattern(stmt.catchClause.variableDeclaration.name))
      ) {
        // Push the caught exception externref, then destructure into binding locals
        fctx.body.push({ op: "local.get", index: exnLocalIdx });
        compileExternrefCatchDestructure(ctx, fctx, stmt.catchClause.variableDeclaration.name, exnLocalIdx);
      }

      // Save/restore block-scoped shadows for let/const in the catch block (#817).
      const savedCatchScope = saveBlockScopedShadows(fctx, stmt.catchClause.block);
      for (const s of stmt.catchClause.block.statements) {
        compileStatement(ctx, fctx, s);
      }
      restoreBlockScopedShadows(fctx, savedCatchScope);
      if (finallyInstrs) {
        // Pop the finallyStack entry we pushed for the catch body
        fctx.finallyStack!.pop();

        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
        adjustRethrowDepth(fctx, -1);
      }

      // Pop rethrow info
      if (catchVarName) {
        fctx.catchRethrowStack!.pop();
      }

      catchBodyInstrs = fctx.body;
      fctx.body = prevBody;
      // Remove tryBody from savedBodies (added above for shift tracking)
      const tbIdx = fctx.savedBodies.lastIndexOf(tryBody);
      if (tbIdx >= 0) fctx.savedBodies.splice(tbIdx, 1);
    }

    /** Deep-clone the catch body instructions for reuse in catch_all. */
    function cloneCatchBody(): Instr[] {
      return JSON.parse(JSON.stringify(catchBodyInstrs));
    }

    // Build "catch $exn" body: receives the externref value on the stack
    {
      fctx.body = [];
      if (exnLocalIdx !== null) {
        fctx.body.push({ op: "local.set", index: exnLocalIdx });
      } else {
        fctx.body.push({ op: "drop" });
      }

      if (finallyInstrs) {
        // Wrap catch body in inner try/catch_all so that if the catch body
        // throws, the finally block still executes before the exception
        // propagates.
        const innerCatchAllBody: Instr[] = [
          ...cloneFinally(),
          { op: "rethrow", depth: 0 } as any,
        ];

        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: catchBodyInstrs,
          catches: [],
          catchAll: innerCatchAllBody,
        } as any);

        // Finally on normal exit path (no exception in catch body)
        fctx.body.push(...cloneFinally());
      } else {
        fctx.body.push(...catchBodyInstrs);
      }
      catches = [{ tagIdx, body: fctx.body }];
    }

    // Build "catch_all" body: no value on stack from catch_all itself.
    // Call __get_caught_exception host import to retrieve the foreign JS exception.
    {
      // Track tryBody and catch bodies in savedBodies so late imports
      // (e.g. __get_caught_exception) shift their function indices too.
      fctx.savedBodies.push(tryBody);
      for (const c of catches) fctx.savedBodies.push(c.body);
      fctx.body = [];
      if (exnLocalIdx !== null) {
        const getCaughtIdx = ensureLateImport(
          ctx, "__get_caught_exception", [], [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: getCaughtIdx });
        fctx.body.push({ op: "local.set", index: exnLocalIdx });
      }

      if (finallyInstrs) {
        // Same wrapping as catch $exn body above, but with cloned catch body
        const innerCatchAllBody: Instr[] = [
          ...cloneFinally(),
          { op: "rethrow", depth: 0 } as any,
        ];

        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: cloneCatchBody(),
          catches: [],
          catchAll: innerCatchAllBody,
        } as any);

        fctx.body.push(...cloneFinally());
      } else {
        fctx.body.push(...cloneCatchBody());
      }
      catchAllBody = fctx.body;
      // Remove tryBody and catch bodies from savedBodies (added above)
      for (const c of catches) {
        const ci = fctx.savedBodies.lastIndexOf(c.body);
        if (ci >= 0) fctx.savedBodies.splice(ci, 1);
      }
      const tbIdx2 = fctx.savedBodies.lastIndexOf(tryBody);
      if (tbIdx2 >= 0) fctx.savedBodies.splice(tbIdx2, 1);
    }

    // Restore the previous localMap entry for the catch variable so that
    // variables in outer scopes with the same name are accessible after the
    // catch clause.  (The catch parameter is block-scoped to the catch body.)
    if (
      stmt.catchClause.variableDeclaration &&
      ts.isIdentifier(stmt.catchClause.variableDeclaration.name)
    ) {
      const varName = stmt.catchClause.variableDeclaration.name.text;
      if (savedCatchVarIdx !== undefined) {
        fctx.localMap.set(varName, savedCatchVarIdx);
      }
    }
  }

  // Remove finallyInstrs from savedBodies now that all cloning is done
  if (finallyInstrs) {
    const fiIdx = fctx.savedBodies.lastIndexOf(finallyInstrs);
    if (fiIdx >= 0) fctx.savedBodies.splice(fiIdx, 1);
  }

  popBody(fctx, savedBody);

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

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
  fctx: FunctionContext,
  decl: ts.ClassDeclaration,
): void {
  if (!decl.name) return;
  const className = decl.name.text;

  const isDeferred = ctx.deferredClassBodies.has(className);
  // Skip if already collected AND not deferred (already fully compiled)
  if (ctx.structMap.has(className) && !isDeferred) {
    // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
    if (ctx.classThrowsOnEval.has(className)) {
      emitThrowString(ctx, fctx, "TypeError: Classes may not have a static property named 'prototype'");
      return;
    }
    return;
  }

  try {
    // Collect struct type, constructor, and method stubs (if not already done)
    if (!ctx.structMap.has(className)) {
      collectClassDeclaration(ctx, decl);
    }

    // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
    // Check after collection since collectClassDeclaration sets the flag.
    if (ctx.classThrowsOnEval.has(className)) {
      emitThrowString(ctx, fctx, "TypeError: Classes may not have a static property named 'prototype'");
      return;
    }

    // Promote captured locals to globals so method/constructor bodies can access
    // variables from the enclosing function scope
    for (const member of decl.members) {
      if (ts.isMethodDeclaration(member) && member.body) {
        promoteAccessorCapturesToGlobals(ctx, fctx, member.body);
      }
      if (ts.isConstructorDeclaration(member) && member.body) {
        promoteAccessorCapturesToGlobals(ctx, fctx, member.body);
      }
    }

    // Build funcByName map for compileClassBodies
    const funcByName = new Map<string, number>();
    for (let i = 0; i < ctx.mod.functions.length; i++) {
      funcByName.set(ctx.mod.functions[i]!.name, i);
    }

    // Compile constructor and method bodies
    compileClassBodies(ctx, decl, funcByName);

    // Mark as no longer deferred
    if (isDeferred) ctx.deferredClassBodies.delete(className);
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
  const optionalParams: OptionalParamInfo[] = [];
  for (let i = 0; i < stmt.parameters.length; i++) {
    const param = stmt.parameters[i]!;
    if (param.questionToken || param.initializer) {
      const info: OptionalParamInfo = { index: i, type: paramTypes[i]! };
      if (param.initializer) {
        const cd = extractConstantDefault(param.initializer, paramTypes[i]!);
        if (cd) {
          info.constantDefault = cd;
        } else {
          info.hasExpressionDefault = true;
        }
      }
      optionalParams.push(info);
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
      isGenerator,
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    const savedFunc = ctx.currentFunc;
    if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
    if (savedFunc) ctx.funcStack.push(savedFunc);
    ctx.currentFunc = liftedFctx;

    // Emit default-value initialization for parameters with initializers
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, 0);

    // Destructure parameters with binding patterns
    for (let pi = 0; pi < stmt.parameters.length; pi++) {
      const param = stmt.parameters[pi]!;
      if (ts.isObjectBindingPattern(param.name)) {
        destructureParamObject(ctx, liftedFctx, pi, param.name, paramTypes[pi]!);
      } else if (ts.isArrayBindingPattern(param.name)) {
        destructureParamArray(ctx, liftedFctx, pi, param.name, paramTypes[pi]!);
      }
    }

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
    if (savedFunc) ctx.funcStack.pop();
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
      isGenerator,
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    // Register mutable captures as boxed so reads/writes use struct.get/set.
    // Also register non-mutable captures that are already boxed in the outer
    // scope, so the body code dereferences through the ref cell.
    for (const cap of captures) {
      if (cap.mutable) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      } else {
        const outerBoxed = fctx.boxedCaptures?.get(cap.name);
        if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
          if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
          liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx: outerBoxed.refCellTypeIdx, valType: outerBoxed.valType });
        }
      }
    }

    const savedFunc = ctx.currentFunc;
    if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
    if (savedFunc) ctx.funcStack.push(savedFunc);
    ctx.currentFunc = liftedFctx;

    // Emit default-value initialization for parameters with initializers
    // (offset by number of captures since they are prepended as leading params)
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, captures.length);

    // Destructure parameters with binding patterns (offset by captures)
    for (let pi = 0; pi < stmt.parameters.length; pi++) {
      const param = stmt.parameters[pi]!;
      const paramIdx = captures.length + pi;
      if (ts.isObjectBindingPattern(param.name)) {
        destructureParamObject(ctx, liftedFctx, paramIdx, param.name, paramTypes[pi]!);
      } else if (ts.isArrayBindingPattern(param.name)) {
        destructureParamArray(ctx, liftedFctx, paramIdx, param.name, paramTypes[pi]!);
      }
    }

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
    if (savedFunc) ctx.funcStack.pop();
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
      // Check if the f64 param holds the sentinel sNaN bit pattern (#866).
      // This distinguishes missing args from explicit NaN/0/any other value.
      // Sentinel: 0x7FF00000DEADC0DE (emitted by pushDefaultValue).
      liftedFctx.body.push({ op: "local.get", index: paramIdx });
      liftedFctx.body.push({ op: "i64.reinterpret_f64" } as unknown as Instr);
      liftedFctx.body.push({ op: "i64.const", value: 0x7FF00000DEADC0DEn } as unknown as Instr);
      liftedFctx.body.push({ op: "i64.eq" });
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
 * Check if a node tree references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
export function bodyUsesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  // Arrow functions do NOT have their own `arguments` — they inherit
  // the enclosing function's, so we must traverse into them.
  return ts.forEachChild(node, bodyUsesArguments) ?? false;
}

/**
 * Emit code to create an `arguments` vec struct from function parameters.
 * paramOffset is the number of leading params to skip (e.g. captures).
 *
 * Uses an externref-backed vec so that all parameter types (f64, i32,
 * externref, ref) are preserved as externref values.  This matches JS
 * semantics where `arguments[n]` returns the original value.
 */
export function emitArgumentsObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
): void {
  const numArgs = paramTypes.length;
  const elemType: ValType = { kind: "externref" };
  const vti = getOrRegisterVecType(ctx, "externref", elemType);
  const ati = getArrTypeIdxFromVec(ctx, vti);
  const vecRef: ValType = { kind: "ref", typeIdx: vti };
  const argsLocal = allocLocal(fctx, "arguments", vecRef);
  const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: ati });

  // Ensure __box_number is available if we have any f64/i32 params to box
  const hasNumericParams = paramTypes.some(
    (pt) => pt.kind === "f64" || pt.kind === "i32",
  );
  if (hasNumericParams) {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
  }

  // Push each param coerced to externref
  for (let i = 0; i < numArgs; i++) {
    fctx.body.push({ op: "local.get", index: i + paramOffset });
    const pt = paramTypes[i]!;
    if (pt.kind === "f64") {
      // Box f64 → externref via __box_number
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        // Fallback: drop and push null
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (pt.kind === "i32") {
      // i32 → f64 → externref via __box_number
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (pt.kind === "ref" || pt.kind === "ref_null") {
      // GC ref → externref via extern.convert_any
      fctx.body.push({ op: "extern.convert_any" });
    }
    // externref params are already externref — no conversion needed
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: numArgs });
  fctx.body.push({ op: "local.set", index: arrTmp });
  fctx.body.push({ op: "i32.const", value: numArgs });
  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "struct.new", typeIdx: vti });
  fctx.body.push({ op: "local.set", index: argsLocal });
}
