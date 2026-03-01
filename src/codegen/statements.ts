import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import { allocLocal, resolveWasmType, ensureI32Condition, ensureExnTag, getSourcePos, attachSourcePos } from "./index.js";
import { compileExpression } from "./expressions.js";
import {
  isVoidType,
  isNumberType,
  isBooleanType,
} from "../checker/type-mapper.js";
import type { Instr } from "../ir/types.js";

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
    markStatementPos(ctx, fctx, stmt, () => compileVariableStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isReturnStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileReturnStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isIfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileIfStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isWhileStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileWhileStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForStatement(ctx, fctx, stmt));
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
    markStatementPos(ctx, fctx, stmt, () => compileDoWhileStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isSwitchStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileSwitchStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForOfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForOfStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForInStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForInStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isBreakStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileBreakStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isContinueStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileContinueStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isThrowStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileThrowStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isTryStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileTryStatement(ctx, fctx, stmt));
    return;
  }

  ctx.errors.push({
    message: `Unsupported statement: ${ts.SyntaxKind[stmt.kind]}`,
    line: getLine(stmt),
    column: getCol(stmt),
  });
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

    // For arrow/function expression initializers, compile the expression first
    // to get the actual closure struct ref type (resolveWasmType returns externref
    // for function types, but closures need ref $struct)
    if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
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
        const globalDef = ctx.mod.globals[moduleGlobalIdx];
        const wasmType = globalDef?.type ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
        compileExpression(ctx, fctx, decl.initializer, wasmType);
        fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
      }
      continue;
    }

    const varType = ctx.checker.getTypeAtLocation(decl);
    const wasmType = resolveWasmType(ctx, varType);

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
    (symName && symName !== "__type" && symName !== "__object" && ctx.structMap.has(symName))
      ? symName
      : ctx.anonTypeMap.get(initType) ?? symName;

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
  const tmpLocal = allocLocal(fctx, `__destruct_${fctx.locals.length}`, resultType);
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
  if (!typeDef || typeDef.kind !== "array") {
    fctx.body.length = bodyLenBefore;
    ctx.errors.push({
      message: "Cannot destructure: not an array type",
      line: getLine(decl),
      column: getCol(decl),
    });
    return;
  }

  const elemType = typeDef.element;

  // Store array ref in temp local
  const tmpLocal = allocLocal(fctx, `__destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue; // skip holes: [a, , c]

    const localName = (element.name as ts.Identifier).text;
    const localIdx = allocLocal(fctx, localName, elemType);

    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "array.get", typeIdx });
    fctx.body.push({ op: "local.set", index: localIdx });
  }
}

function compileReturnStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ReturnStatement,
): void {
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

  // Track break/continue depths
  // Inside the generated structure, br 1 = break, br 0 = continue
  fctx.breakStack.push(1);     // break: exit the outer block
  fctx.continueStack.push(0);  // continue: restart the loop

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

  // Loop structure: block { loop { condition_check; body; incrementor; br 0 } }
  const savedBody = fctx.body;
  fctx.body = [];

  // break goes to outer block (depth 1), continue goes to incrementor+loop restart
  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // Condition
  if (stmt.condition) {
    const condType = compileExpression(ctx, fctx, stmt.condition);
    ensureI32Condition(fctx, condType);
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "br_if", depth: 1 }); // break
  }

  // Body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Incrementor
  if (stmt.incrementor) {
    const resultType = compileExpression(ctx, fctx, stmt.incrementor);
    if (resultType !== null) fctx.body.push({ op: "drop" });
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop
  const loopBody = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

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
  const eqOp: "f64.eq" | "i32.eq" = wasmType.kind === "i32" ? "i32.eq" : "f64.eq";

  // Collect instructions for the switch block body
  const savedBody = fctx.body;
  fctx.body = [];

  // Inside the block: br 1 exits the block ($break). No continueStack change.
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

    for (const s of caseClause.statements) {
      compileStatement(ctx, fctx, s);
    }

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
  // Compile the iterable expression (array ref)
  const bodyLenBefore = fctx.body.length;
  const arrType = compileExpression(ctx, fctx, stmt.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
    ctx.errors.push({
      message: "for-of requires an array expression",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }

  // Look up array element type
  const arrTypeDef = ctx.mod.types[arrType.typeIdx];
  if (!arrTypeDef || arrTypeDef.kind !== "array") {
    fctx.body.length = bodyLenBefore; // rollback — value would leak on stack
    ctx.errors.push({
      message: "for-of requires an array type",
      line: getLine(stmt),
      column: getCol(stmt),
    });
    return;
  }
  const elemType = arrTypeDef.element;

  // Save array ref to temp local
  const arrLocal = allocLocal(fctx, `__forof_arr_${fctx.locals.length}`, arrType);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, { kind: "i32" });
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

  fctx.breakStack.push(1);     // break = depth 1 (exit block)
  fctx.continueStack.push(0);  // continue = depth 0 (restart loop)

  // Condition: i >= arr.length → break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // Get element: x = arr[i]
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "array.get", typeIdx: arrType.typeIdx });
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
    const importName = ctx.stringLiteralMap.get(prop.name);
    if (!importName) continue;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) continue;

    // Set the key variable to this property's name
    fctx.body.push({ op: "call", funcIdx });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Compile the loop body
    compileStatement(ctx, fctx, stmt.statement);
  }
}

function compileBreakStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  _stmt: ts.BreakStatement,
): void {
  const depth = fctx.breakStack[fctx.breakStack.length - 1];
  if (depth !== undefined) {
    fctx.body.push({ op: "br", depth });
  }
}

function compileContinueStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  _stmt: ts.ContinueStatement,
): void {
  const depth = fctx.continueStack[fctx.continueStack.length - 1];
  if (depth !== undefined) {
    fctx.body.push({ op: "br", depth });
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
    const resultType = compileExpression(ctx, fctx, stmt.expression, { kind: "externref" });
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
    if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
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
