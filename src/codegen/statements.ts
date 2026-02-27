import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import { allocLocal } from "./index.js";
import { compileExpression } from "./expressions.js";
import {
  mapTsTypeToWasm,
  isVoidType,
  isNumberType,
  isBooleanType,
} from "../checker/type-mapper.js";
import type { Instr } from "../ir/types.js";

/** Compile a statement, appending instructions to the function body */
export function compileStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
): void {
  if (ts.isVariableStatement(stmt)) {
    compileVariableStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isReturnStatement(stmt)) {
    compileReturnStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isIfStatement(stmt)) {
    compileIfStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isWhileStatement(stmt)) {
    compileWhileStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isForStatement(stmt)) {
    compileForStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
    return;
  }

  if (ts.isExpressionStatement(stmt)) {
    const resultType = compileExpression(ctx, fctx, stmt.expression);
    // Drop the result if the expression left something on the stack
    if (resultType !== null) {
      fctx.body.push({ op: "drop" });
    }
    return;
  }

  if (ts.isBreakStatement(stmt)) {
    compileBreakStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isContinueStatement(stmt)) {
    compileContinueStatement(ctx, fctx, stmt);
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
    if (!ts.isIdentifier(decl.name)) {
      ctx.errors.push({
        message: "Destructuring not supported",
        line: getLine(decl),
        column: getCol(decl),
      });
      continue;
    }

    const name = decl.name.text;
    const varType = ctx.checker.getTypeAtLocation(decl);
    const wasmType = mapTsTypeToWasm(varType, ctx.checker);

    const localIdx = allocLocal(fctx, name, wasmType);

    if (decl.initializer) {
      compileExpression(ctx, fctx, decl.initializer);
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }
}

function compileReturnStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ReturnStatement,
): void {
  if (stmt.expression) {
    compileExpression(ctx, fctx, stmt.expression);
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

  // If the condition is an f64 (number comparison result), convert to i32
  if (condType && condType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ne" });
  }

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
  if (condType && condType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ne" });
  }
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
          const wasmType = mapTsTypeToWasm(varType, ctx.checker);
          const localIdx = allocLocal(fctx, name, wasmType);
          if (decl.initializer) {
            compileExpression(ctx, fctx, decl.initializer);
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
    if (condType && condType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.ne" });
    }
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
