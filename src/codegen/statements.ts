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
  allocLocal,
  attachSourcePos,
  ensureExnTag,
  ensureI32Condition,
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  getSourcePos,
  localGlobalIdx,
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
    compileNestedFunctionDeclaration(ctx, fctx, stmt);
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

    // Check if this is a module-level global (already registered)
    const moduleGlobalIdx = ctx.moduleGlobals.get(name);
    if (moduleGlobalIdx !== undefined) {
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
    const wasmType = inferredVecType
      ?? ((decl.initializer && isStringMethodReturningHostArray(ctx, decl.initializer))
        ? { kind: "externref" as const }
        : resolveWasmType(ctx, varType));

    const localIdx = allocLocal(fctx, name, wasmType);

    if (decl.initializer) {
      compileExpression(ctx, fctx, decl.initializer, wasmType);
      fctx.body.push({ op: "local.set", index: localIdx });
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
  const typeName =
    symName &&
    symName !== "__type" &&
    symName !== "__object" &&
    ctx.structMap.has(symName)
      ? symName
      : (ctx.anonTypeMap.get(initType) ?? symName);

  if (!typeName) {
    fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
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
    ctx.errors.push({
      message: `Cannot destructure: not a known struct type: ${typeName}`,
      line: getLine(decl),
      column: getCol(decl),
    });
    return;
  }

  // Save the struct ref into a temp local so we can access fields multiple times
  const tmpLocal = allocLocal(
    fctx,
    `__destruct_${fctx.locals.length}`,
    resultType,
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
    fctx.body.push({ op: "local.set", index: localIdx });
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
    fctx.body.push({ op: "local.set", index: localIdx });
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
  ensureI32Condition(fctx, condType);

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
  ensureI32Condition(fctx, condType);
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
    ensureI32Condition(fctx, condType);
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
  // block $break        (break target — depth 1 from inside the loop)
  //   loop $continue    (continue target — depth 0)
  //     <body>
  //     <condition>
  //     ensureI32Condition
  //     br_if 0         (true → jump back to loop start)
  //   end
  // end

  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++)
    fctx.continueStack[i]! += 2;

  // Inside this structure: br 1 = break (exits outer block), br 0 = continue (restarts loop)
  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Compile condition — true means continue looping
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType);
  fctx.body.push({ op: "br_if", depth: 0 }); // continue loop if true

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

function compileSwitchStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.SwitchStatement,
): void {
  // Evaluate the switch expression and save it to a temp local
  const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
  const wasmType = resolveWasmType(ctx, exprType);

  const tmpLocalIdx = allocLocal(fctx, `__sw_${fctx.locals.length}`, wasmType);
  compileExpression(ctx, fctx, stmt.expression);
  fctx.body.push({ op: "local.set", index: tmpLocalIdx });

  // Choose the equality opcode based on the switch expression type
  const eqOp: "f64.eq" | "i32.eq" =
    wasmType.kind === "i32" ? "i32.eq" : "f64.eq";

  // Collect instructions for the switch block body
  const savedBody = fctx.body;
  fctx.body = [];

  // Adjust existing break/continue depths: block adds 1 nesting level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

  // Inside the block: br 1 exits the block ($break). No continueStack change.
  // The value 1 accounts for the case if-wrapping (+1 from block).
  const switchBreakIdx = fctx.breakStack.length;
  fctx.breakStack.push(1);

  const clauses = stmt.caseBlock.clauses;
  let defaultClause: ts.DefaultClause | undefined;

  for (const clause of clauses) {
    if (ts.isDefaultClause(clause)) {
      // Defer the default clause — emit it after all case clauses
      defaultClause = clause;
      continue;
    }

    // case X:
    const caseClause = clause as ts.CaseClause;

    // Condition: tmpLocal == caseExpr
    fctx.body.push({ op: "local.get", index: tmpLocalIdx });
    compileExpression(ctx, fctx, caseClause.expression);
    fctx.body.push({ op: eqOp });

    // Compile the clause body into a temp buffer to check for break
    const savedBodyInner = fctx.body;
    fctx.body = [];

    // Adjust outer entries for the if-wrapping (+1 nesting level).
    // Only adjust entries before the switch's own entry — the switch's
    // breakStack entry already accounts for the if.
    for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++)
      fctx.continueStack[i]!++;

    for (const s of caseClause.statements) {
      compileStatement(ctx, fctx, s);
    }

    // Restore depths after case body compilation
    for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++)
      fctx.continueStack[i]!--;

    const clauseBody = fctx.body;
    fctx.body = savedBodyInner;

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: clauseBody,
    });
  }

  // Emit default clause body (if any) directly — no condition check needed
  if (defaultClause) {
    for (const s of defaultClause.statements) {
      compileStatement(ctx, fctx, s);
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

  // Declare the loop variable
  let elemLocal: number;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const varName = (decl.name as ts.Identifier).text;
    elemLocal = allocLocal(fctx, varName, elemType);
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
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const varName = (decl.name as ts.Identifier).text;
    elemLocal = allocLocal(fctx, varName, elemType);
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

  // Record the label with the current break/continue stack indices.
  // The inner loop statement will push its own entries, so the label
  // points to the index that will be pushed by the labeled loop.
  const breakIdx = fctx.breakStack.length;
  const continueIdx = fctx.continueStack.length;
  fctx.labelMap.set(labelName, { breakIdx, continueIdx });

  // Compile the inner statement (typically a loop)
  compileStatement(ctx, fctx, stmt.statement);

  // Remove the label after compilation
  fctx.labelMap.delete(labelName);
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
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = liftedFctx;
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
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = liftedFctx;
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
