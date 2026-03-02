import ts from "typescript";
import type { TypedAST } from "../checker/index.js";
import type {
  FuncTypeDef,
  Instr,
  ValType,
  WasmModule,
} from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import type { LinearContext, LinearFuncContext, CollectionKind } from "./context.js";
import { addLocal } from "./context.js";
import { computeClassLayout } from "./layout.js";
import type { ClassLayout } from "./layout.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
  addArrayRuntime,
  addStringRuntime,
  addMapRuntime,
  addSetRuntime,
  addNumericMapRuntime,
  addNumericSetRuntime,
} from "./runtime.js";

/** Type tag for class instances in linear memory */
const CLASS_TYPE_TAG = 5;

/** Data segment base address — must be below HEAP_START (1024) */
const DATA_SEGMENT_BASE = 64;

/**
 * Generate a WasmModule using the linear-memory backend.
 * Compiles TS functions to standard Wasm with i32/f64 values.
 */
export function generateLinearModule(ast: TypedAST): WasmModule {
  const mod = createEmptyModule();

  // Add memory and runtime functions first
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addMapRuntime(mod);
  addSetRuntime(mod);
  addNumericMapRuntime(mod);
  addNumericSetRuntime(mod);

  const ctx: LinearContext = {
    mod,
    checker: ast.checker,
    funcMap: new Map(),
    numImportFuncs: 0,
    currentFunc: null,
    errors: [],
    classLayouts: new Map(),
    stringLiterals: new Map(),
    dataSegmentOffset: DATA_SEGMENT_BASE,
  };

  // Register runtime functions in funcMap
  for (let i = 0; i < mod.functions.length; i++) {
    ctx.funcMap.set(mod.functions[i].name, ctx.numImportFuncs + i);
  }

  // ── Class declaration pass: scan for classes and compute layouts ──
  const classDecls: ts.ClassDeclaration[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      classDecls.push(stmt);
      scanClassDeclaration(ctx, stmt);
    }
  }

  // ── Forward-register all functions: class ctors/methods first, then top-level ──
  const allFuncEntries: { kind: "ctor" | "method" | "func"; node: ts.Node; name: string; className?: string }[] = [];

  for (const classDecl of classDecls) {
    const className = classDecl.name!.text;
    const layout = ctx.classLayouts.get(className)!;

    // Constructor
    allFuncEntries.push({ kind: "ctor", node: classDecl, name: layout.ctorFuncName, className });

    // Methods
    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const methodName = member.name.text;
        const wasmMethodName = `${className}_${methodName}`;
        layout.methods.set(methodName, wasmMethodName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmMethodName, className });
      }
    }
  }

  // Top-level function declarations
  const funcDecls: ts.FunctionDeclaration[] = [];
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      funcDecls.push(stmt);
      allFuncEntries.push({ kind: "func", node: stmt, name: stmt.name.text });
    }
  }

  // Assign function indices for all entries
  const runtimeFuncCount = ctx.mod.functions.length;
  for (let i = 0; i < allFuncEntries.length; i++) {
    const entry = allFuncEntries[i];
    const funcIdx = ctx.numImportFuncs + runtimeFuncCount + i;
    ctx.funcMap.set(entry.name, funcIdx);
  }

  // ── Compile class constructors and methods ──
  for (const classDecl of classDecls) {
    compileClassDeclaration(ctx, classDecl);
  }

  // ── Compile top-level function declarations ──
  for (const decl of funcDecls) {
    compileFunction(ctx, decl);
  }

  // ── Emit data segments for string literals ──
  if (ctx.stringLiterals.size > 0) {
    const totalSize = ctx.dataSegmentOffset - DATA_SEGMENT_BASE;
    const bytes = new Uint8Array(totalSize);
    for (const [str, offset] of ctx.stringLiterals) {
      const encoded = new TextEncoder().encode(str);
      bytes.set(encoded, offset - DATA_SEGMENT_BASE);
    }
    mod.dataSegments.push({ offset: DATA_SEGMENT_BASE, bytes });
  }

  return mod;
}

function compileFunction(ctx: LinearContext, decl: ts.FunctionDeclaration): void {
  const name = decl.name!.text;
  const isExported = decl.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;

  // Build parameter types
  const params: { name: string; type: ValType }[] = [];
  for (const p of decl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveType(ctx, p.type);
    params.push({ name: paramName, type });
  }

  // Resolve return type
  const returnType = resolveType(ctx, decl.type);
  const isVoid = returnType === null;

  // Register function type
  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  const funcTypeDef: FuncTypeDef = {
    kind: "func",
    name: `$type_${name}`,
    params: paramTypes,
    results: resultTypes,
  };
  ctx.mod.types.push(funcTypeDef);

  // Create function context
  const fctx: LinearFuncContext = {
    name,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    collectionTypes: new Map(),
  };

  // Register params in localMap
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  // Function index was already registered in the forward declaration pass
  const funcIdx = ctx.funcMap.get(name)!;

  // Compile body
  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  // If the function returns a value, add unreachable at the end.
  // This handles the case where all code paths return early (e.g. if/else
  // with return in both branches). Wasm validation requires the stack to
  // match the return type at the end of the function body.
  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  // Add function to module
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: isExported,
  });

  if (isExported) {
    ctx.mod.exports.push({
      name,
      desc: { kind: "func", index: funcIdx },
    });
  }

  ctx.currentFunc = null;
}

function compileStatement(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  stmt: ts.Statement,
): void {
  if (ts.isReturnStatement(stmt)) {
    if (stmt.expression) {
      compileExpression(ctx, fctx, stmt.expression);
    }
    fctx.body.push({ op: "return" });
  } else if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const varName = decl.name.text;
        // Detect collection type from annotation or initializer
        const collKind = detectCollectionKind(ctx, decl);
        // Determine type from initializer or annotation
        let type: ValType = { kind: "f64" }; // default to f64 for numbers
        if (collKind) {
          type = { kind: "i32" }; // collections are i32 pointers
          fctx.collectionTypes.set(varName, collKind);
        } else if (decl.type) {
          const resolved = resolveType(ctx, decl.type);
          if (resolved) type = resolved;
        } else if (decl.initializer) {
          type = inferExprType(ctx, fctx, decl.initializer);
        }
        const localIdx = addLocal(fctx, varName, type);
        if (decl.initializer) {
          compileExpression(ctx, fctx, decl.initializer);
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }
  } else if (ts.isIfStatement(stmt)) {
    compileExpression(ctx, fctx, stmt.expression);
    // Convert f64 condition to i32 (0.0 = false, else true)
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.expression));

    const thenBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = thenBody;
    fctx.blockDepth++;
    compileStatement(ctx, fctx, stmt.thenStatement);
    fctx.blockDepth--;

    let elseBody: Instr[] | undefined;
    if (stmt.elseStatement) {
      elseBody = [];
      fctx.body = elseBody;
      fctx.blockDepth++;
      compileStatement(ctx, fctx, stmt.elseStatement);
      fctx.blockDepth--;
    }

    fctx.body = savedBody;

    // Determine block type
    const blockType = { kind: "empty" as const };
    fctx.body.push({
      op: "if",
      blockType,
      then: thenBody,
      ...(elseBody ? { else: elseBody } : {}),
    });
  } else if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else if (ts.isWhileStatement(stmt)) {
    // block { loop { br_if !cond @block; body; br @loop } }
    const loopBody: Instr[] = [];
    const savedBody = fctx.body;

    // Compile condition (break out if false)
    fctx.body = loopBody;
    compileExpression(ctx, fctx, stmt.expression);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.expression));
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "br_if", depth: 1 }); // break to outer block

    // Push break/continue stack
    fctx.breakStack.push(fctx.blockDepth);
    fctx.continueStack.push(fctx.blockDepth + 1);
    fctx.blockDepth += 2;

    compileStatement(ctx, fctx, stmt.statement);

    fctx.blockDepth -= 2;
    fctx.breakStack.pop();
    fctx.continueStack.pop();

    fctx.body.push({ op: "br", depth: 0 }); // continue loop

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
  } else if (ts.isForStatement(stmt)) {
    // Compile initializer outside loop
    if (stmt.initializer) {
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        compileStatement(ctx, fctx, ts.factory.createVariableStatement(undefined, stmt.initializer));
      } else {
        compileExpression(ctx, fctx, stmt.initializer);
        fctx.body.push({ op: "drop" });
      }
    }

    const loopBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = loopBody;

    // Condition
    if (stmt.condition) {
      compileExpression(ctx, fctx, stmt.condition);
      emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.condition));
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({ op: "br_if", depth: 1 }); // break to outer block
    }

    // Push break/continue stack
    fctx.breakStack.push(fctx.blockDepth);
    fctx.continueStack.push(fctx.blockDepth + 1);
    fctx.blockDepth += 2;

    // Body
    compileStatement(ctx, fctx, stmt.statement);

    fctx.blockDepth -= 2;
    fctx.breakStack.pop();
    fctx.continueStack.pop();

    // Incrementor
    if (stmt.incrementor) {
      compileExpression(ctx, fctx, stmt.incrementor);
      fctx.body.push({ op: "drop" });
    }

    fctx.body.push({ op: "br", depth: 0 }); // continue loop

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
  } else if (ts.isExpressionStatement(stmt)) {
    compileExpression(ctx, fctx, stmt.expression);
    fctx.body.push({ op: "drop" });
  }
}

export function compileExpression(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.Expression,
): void {
  if (ts.isNumericLiteral(expr)) {
    fctx.body.push({ op: "f64.const", value: Number(expr.text) });
  } else if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    compileStringLiteral(ctx, fctx, expr.text);
  } else if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    // `this` is the first parameter (index 0) in class methods/constructors
    fctx.body.push({ op: "local.get", index: 0 });
  } else if (ts.isBinaryExpression(expr)) {
    compileBinaryExpression(ctx, fctx, expr);
  } else if (ts.isParenthesizedExpression(expr)) {
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      ctx.errors.push({
        message: `Unknown identifier: ${name}`,
        line: 0,
        column: 0,
      });
    }
  } else if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.MinusToken) {
      compileExpression(ctx, fctx, expr.operand);
      fctx.body.push({ op: "f64.neg" });
    } else if (expr.operator === ts.SyntaxKind.PlusToken) {
      compileExpression(ctx, fctx, expr.operand);
      // unary plus is a no-op for numbers
    } else if (expr.operator === ts.SyntaxKind.ExclamationToken) {
      compileExpression(ctx, fctx, expr.operand);
      emitTruthyCoercion(fctx, inferExprType(ctx, fctx, expr.operand));
      fctx.body.push({ op: "i32.eqz" });
      // Result is i32 (0 or 1), convert back to f64
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (expr.operator === ts.SyntaxKind.TildeToken) {
      // Bitwise NOT: ~x = (x ^ -1)
      compileExpression(ctx, fctx, expr.operand);
      fctx.body.push({ op: "i32.trunc_f64_s" });
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.xor" });
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (expr.operator === ts.SyntaxKind.PlusPlusToken) {
      // ++x
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.tee", index: idx });
        }
      }
    } else if (expr.operator === ts.SyntaxKind.MinusMinusToken) {
      // --x
      if (ts.isIdentifier(expr.operand)) {
        const idx = fctx.localMap.get(expr.operand.text);
        if (idx !== undefined) {
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.sub" });
          fctx.body.push({ op: "local.tee", index: idx });
        }
      }
    }
  } else if (ts.isPostfixUnaryExpression(expr)) {
    if (ts.isIdentifier(expr.operand)) {
      const idx = fctx.localMap.get(expr.operand.text);
      if (idx !== undefined) {
        // Return old value
        fctx.body.push({ op: "local.get", index: idx });
        // Compute new value
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({ op: "f64.const", value: 1 });
        if (expr.operator === ts.SyntaxKind.PlusPlusToken) {
          fctx.body.push({ op: "f64.add" });
        } else {
          fctx.body.push({ op: "f64.sub" });
        }
        fctx.body.push({ op: "local.set", index: idx });
      }
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // [] or [a, b, c]
    compileArrayLiteral(ctx, fctx, expr);
  } else if (ts.isNewExpression(expr)) {
    // new Uint8Array(n), new Map(), new Set()
    compileNewExpression(ctx, fctx, expr);
  } else if (ts.isPropertyAccessExpression(expr)) {
    // arr.length, map.size, set.size
    compilePropertyAccess(ctx, fctx, expr);
  } else if (ts.isElementAccessExpression(expr)) {
    // arr[i], u8[i]
    compileElementAccess(ctx, fctx, expr);
  } else if (ts.isCallExpression(expr)) {
    if (ts.isPropertyAccessExpression(expr.expression)) {
      // Method calls: arr.push(x), map.set(k,v), etc.
      compileMethodCall(ctx, fctx, expr);
    } else if (ts.isIdentifier(expr.expression)) {
      const funcName = expr.expression.text;
      const funcIdx = ctx.funcMap.get(funcName);
      if (funcIdx !== undefined) {
        // Compile arguments
        for (const arg of expr.arguments) {
          compileExpression(ctx, fctx, arg);
        }
        fctx.body.push({ op: "call", funcIdx });
      } else {
        ctx.errors.push({
          message: `Unknown function: ${funcName}`,
          line: 0,
          column: 0,
        });
      }
    }
  } else if (ts.isNonNullExpression(expr)) {
    // Handle `expr!` (non-null assertion) - just compile the inner expression
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isConditionalExpression(expr)) {
    // ternary: cond ? then : else
    compileExpression(ctx, fctx, expr.condition);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, expr.condition));

    const thenBody: Instr[] = [];
    const elseBody: Instr[] = [];
    const savedBody = fctx.body;

    fctx.body = thenBody;
    compileExpression(ctx, fctx, expr.whenTrue);
    fctx.body = elseBody;
    compileExpression(ctx, fctx, expr.whenFalse);
    fctx.body = savedBody;

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenBody,
      else: elseBody,
    });
  }
}

function compileBinaryExpression(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.BinaryExpression,
): void {
  const op = expr.operatorToken.kind;

  // Handle assignment
  if (op === ts.SyntaxKind.EqualsToken) {
    // Handle element access assignment: arr[i] = v, u8[i] = v
    if (ts.isElementAccessExpression(expr.left)) {
      compileElementAccessAssignment(ctx, fctx, expr.left, expr.right);
      return;
    }
    // Handle property assignment: obj.field = value
    if (ts.isPropertyAccessExpression(expr.left)) {
      compilePropertyAssignment(ctx, fctx, expr.left, expr.right);
      return;
    }
    if (ts.isIdentifier(expr.left)) {
      const idx = fctx.localMap.get(expr.left.text);
      if (idx !== undefined) {
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "local.tee", index: idx });
        return;
      }
    }
  }

  // Handle compound assignment (+=, -=, *=, /=)
  if (isCompoundAssignment(op) && ts.isIdentifier(expr.left)) {
    const idx = fctx.localMap.get(expr.left.text);
    if (idx !== undefined) {
      fctx.body.push({ op: "local.get", index: idx });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push(compoundAssignmentOp(op));
      fctx.body.push({ op: "local.tee", index: idx });
      return;
    }
  }

  // Bitwise operators: need i32 truncation
  if (isBitwiseOp(op)) {
    compileExpression(ctx, fctx, expr.left);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    compileExpression(ctx, fctx, expr.right);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push(bitwiseOp(op));
    // Unsigned right shift converts back with unsigned conversion
    if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      fctx.body.push({ op: "f64.convert_i32_u" });
    } else {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return;
  }

  // Check if both sides are string expressions — use string ops
  if (isStringExpr(ctx, fctx, expr.left) && isStringExpr(ctx, fctx, expr.right)) {
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      compileExpression(ctx, fctx, expr.left);
      compileExpression(ctx, fctx, expr.right);
      const strEqIdx = ctx.funcMap.get("__str_eq")!;
      fctx.body.push({ op: "call", funcIdx: strEqIdx });
      // __str_eq returns i32 (0 or 1), convert to f64
      fctx.body.push({ op: "f64.convert_i32_s" });
      return;
    }
    if (op === ts.SyntaxKind.PlusToken) {
      compileExpression(ctx, fctx, expr.left);
      compileExpression(ctx, fctx, expr.right);
      const strConcatIdx = ctx.funcMap.get("__str_concat")!;
      fctx.body.push({ op: "call", funcIdx: strConcatIdx });
      return;
    }
  }

  // Regular binary: compile both sides
  compileExpression(ctx, fctx, expr.left);
  compileExpression(ctx, fctx, expr.right);

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "f64.add" });
      break;
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "f64.sub" });
      break;
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "f64.mul" });
      break;
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "f64.div" });
      break;
    case ts.SyntaxKind.PercentToken:
      // f64 remainder: a - trunc(a/b) * b
      // We need to use a temp approach. Actually, wasm doesn't have f64.rem.
      // Use i32 truncation for integer modulo
      // For simplicity, truncate both to i32, do i32.rem_s, convert back
      // Pop the two f64 values we already pushed, redo with i32
      // Actually, we already pushed them. Let's just truncate on stack.
      // Remove the two f64 values and redo
      // Easier: don't push above, handle separately
      // We need to restructure. Let's handle % specially before the switch.
      // For now, use the values on the stack:
      // stack: [left_f64, right_f64]
      // But we can't convert them in-place easily with the switch pattern.
      // Let's use a different approach: handle % before the main compile
      break;
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "f64.lt" });
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "f64.le" });
      break;
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "f64.gt" });
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "f64.ge" });
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      break;
    case ts.SyntaxKind.AmpersandAmpersandToken:
      // Logical AND – already have both on stack. Use select:
      // if left is truthy, result is right; else left
      // Actually this is complex. For now just do comparison-based:
      // This is incorrect for general case, but works for boolean-like values
      // TODO: proper short-circuit evaluation
      break;
    case ts.SyntaxKind.BarBarToken:
      // Logical OR – similar issue
      break;
    default:
      ctx.errors.push({
        message: `Unsupported binary operator: ${ts.SyntaxKind[op]}`,
        line: 0,
        column: 0,
      });
  }

  // Comparison operators return i32 (0 or 1), convert to f64
  if (isComparisonOp(op)) {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }
}

function isComparisonOp(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function isBitwiseOp(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

function bitwiseOp(op: ts.SyntaxKind): Instr {
  switch (op) {
    case ts.SyntaxKind.AmpersandToken:
      return { op: "i32.and" };
    case ts.SyntaxKind.BarToken:
      return { op: "i32.or" };
    case ts.SyntaxKind.CaretToken:
      return { op: "i32.xor" };
    case ts.SyntaxKind.LessThanLessThanToken:
      return { op: "i32.shl" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return { op: "i32.shr_s" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return { op: "i32.shr_u" };
    default:
      return { op: "unreachable" };
  }
}

function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken
  );
}

function compoundAssignmentOp(op: ts.SyntaxKind): Instr {
  switch (op) {
    case ts.SyntaxKind.PlusEqualsToken:
      return { op: "f64.add" };
    case ts.SyntaxKind.MinusEqualsToken:
      return { op: "f64.sub" };
    case ts.SyntaxKind.AsteriskEqualsToken:
      return { op: "f64.mul" };
    case ts.SyntaxKind.SlashEqualsToken:
      return { op: "f64.div" };
    default:
      return { op: "unreachable" };
  }
}

/** Convert a value to i32 truthiness (for conditions) */
function emitTruthyCoercion(fctx: LinearFuncContext, type: ValType): void {
  if (type.kind === "f64") {
    // f64 → i32: value != 0.0
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ne" });
  } else if (type.kind === "i32") {
    // Already i32, no conversion needed
  }
}

// ── Collection detection ──────────────────────────────────────────────

/** Detect whether a variable declaration is a collection type */
function detectCollectionKind(
  _ctx: LinearContext,
  decl: ts.VariableDeclaration,
): CollectionKind | null {
  // Check type annotation: number[], Array<number>, Uint8Array, Map<K,V>, Set<V>
  if (decl.type) {
    const text = decl.type.getText();
    if (text === "number[]" || text.startsWith("Array<")) return "Array";
    if (text === "Uint8Array") return "Uint8Array";
    if (text.startsWith("Map<") || text === "Map") return "Map";
    if (text.startsWith("Set<") || text === "Set") return "Set";
  }
  // Check initializer: [], [a,b], new Uint8Array(), new Map(), new Set()
  if (decl.initializer) {
    if (ts.isArrayLiteralExpression(decl.initializer)) return "Array";
    if (ts.isNewExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
      const ctorName = decl.initializer.expression.text;
      if (ctorName === "Uint8Array") return "Uint8Array";
      if (ctorName === "Map") return "Map";
      if (ctorName === "Set") return "Set";
    }
  }
  return null;
}

/** Get the collection kind for an expression (typically an identifier) */
function getExprCollectionKind(
  _ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.Expression,
): CollectionKind | null {
  if (ts.isIdentifier(expr)) {
    return fctx.collectionTypes.get(expr.text) ?? null;
  }
  return null;
}

// ── Array literal ────────────────────────────────────────────────────

function compileArrayLiteral(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.ArrayLiteralExpression,
): void {
  const elements = expr.elements;
  const cap = Math.max(elements.length, 16);
  const arrNewIdx = ctx.funcMap.get("__arr_new")!;
  const arrPushIdx = ctx.funcMap.get("__arr_push")!;

  // Create array: __arr_new(cap) → i32 ptr
  fctx.body.push({ op: "i32.const", value: cap });
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });

  if (elements.length > 0) {
    // Store ptr in a temp local so we can push elements
    const tmpLocal = addLocal(fctx, `__arr_tmp_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: tmpLocal });

    for (const elem of elements) {
      fctx.body.push({ op: "local.get", index: tmpLocal });
      compileExpression(ctx, fctx, elem);
      // Convert f64 value to i32 for storage
      fctx.body.push({ op: "i32.trunc_f64_s" });
      fctx.body.push({ op: "call", funcIdx: arrPushIdx });
    }

    // Leave the array pointer on the stack as the expression result
    fctx.body.push({ op: "local.get", index: tmpLocal });
  }
  // If empty array, __arr_new already left ptr on stack
}

// ── NewExpression ────────────────────────────────────────────────────

function compileNewExpression(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.NewExpression,
): void {
  if (!ts.isIdentifier(expr.expression)) {
    ctx.errors.push({ message: "Unsupported new expression", line: 0, column: 0 });
    return;
  }
  const ctorName = expr.expression.text;

  if (ctorName === "Uint8Array") {
    // new Uint8Array(n): compile n, truncate to i32, call __u8arr_new
    const u8NewIdx = ctx.funcMap.get("__u8arr_new")!;
    if (expr.arguments && expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
      fctx.body.push({ op: "i32.trunc_f64_s" }); // f64 → i32
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "call", funcIdx: u8NewIdx });
  } else if (ctorName === "Map") {
    // new Map(): call __nmap_new(16) with default capacity
    const nmapNewIdx = ctx.funcMap.get("__nmap_new")!;
    fctx.body.push({ op: "i32.const", value: 16 });
    fctx.body.push({ op: "call", funcIdx: nmapNewIdx });
  } else if (ctorName === "Set") {
    // new Set(): call __nset_new(16) with default capacity
    const nsetNewIdx = ctx.funcMap.get("__nset_new")!;
    fctx.body.push({ op: "i32.const", value: 16 });
    fctx.body.push({ op: "call", funcIdx: nsetNewIdx });
  } else {
    // Check if it's a known class
    const layout = ctx.classLayouts.get(ctorName);
    if (layout) {
      compileClassNewExpression(ctx, fctx, expr, ctorName, layout);
    } else {
      ctx.errors.push({ message: `Unsupported constructor: ${ctorName}`, line: 0, column: 0 });
    }
  }
}

// ── PropertyAccessExpression ─────────────────────────────────────────

function compilePropertyAccess(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.PropertyAccessExpression,
): void {
  const propName = expr.name.text;
  const objKind = getExprCollectionKind(ctx, fctx, expr.expression);

  if (propName === "length" && (objKind === "Array" || objKind === "Uint8Array")) {
    // arr.length or u8.length → call __arr_len / __u8arr_len
    compileExpression(ctx, fctx, expr.expression);
    // expression is i32 (pointer), no conversion needed
    const lenFunc = objKind === "Array" ? "__arr_len" : "__u8arr_len";
    const funcIdx = ctx.funcMap.get(lenFunc)!;
    fctx.body.push({ op: "call", funcIdx });
    // Convert i32 result to f64 (since our numeric values are f64)
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  if (propName === "size" && (objKind === "Map" || objKind === "Set")) {
    // map.size or set.size → call __nmap_size / __nset_size
    compileExpression(ctx, fctx, expr.expression);
    const sizeFunc = objKind === "Map" ? "__nmap_size" : "__nset_size";
    const funcIdx = ctx.funcMap.get(sizeFunc)!;
    fctx.body.push({ op: "call", funcIdx });
    // Convert i32 result to f64
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  // Check if it's a class field access
  const className = inferClassName(ctx, fctx, expr.expression);
  if (className) {
    const layout = ctx.classLayouts.get(className);
    if (layout) {
      const field = layout.fields.get(propName);
      if (field) {
        compileExpression(ctx, fctx, expr.expression);
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.load", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.load", align: 2, offset: field.offset });
        }
        return;
      }
    }
  }

  // Fallback: just report error for unsupported property access
  ctx.errors.push({
    message: `Unsupported property access: .${propName}`,
    line: 0,
    column: 0,
  });
}

// ── ElementAccessExpression ──────────────────────────────────────────

function compileElementAccess(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.ElementAccessExpression,
): void {
  const objKind = getExprCollectionKind(ctx, fctx, expr.expression);

  if (objKind === "Array") {
    // arr[i] → __arr_get(arr, i) → i32, convert to f64
    const getIdx = ctx.funcMap.get("__arr_get")!;
    compileExpression(ctx, fctx, expr.expression); // arr ptr (i32)
    compileExpression(ctx, fctx, expr.argumentExpression); // index (f64)
    fctx.body.push({ op: "i32.trunc_f64_s" }); // index f64 → i32
    fctx.body.push({ op: "call", funcIdx: getIdx });
    fctx.body.push({ op: "f64.convert_i32_s" }); // result i32 → f64
  } else if (objKind === "Uint8Array") {
    // u8[i] → __u8arr_get(u8, i) → i32, convert to f64
    const getIdx = ctx.funcMap.get("__u8arr_get")!;
    compileExpression(ctx, fctx, expr.expression);
    compileExpression(ctx, fctx, expr.argumentExpression);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push({ op: "call", funcIdx: getIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: "Unsupported element access on non-collection type",
      line: 0,
      column: 0,
    });
  }
}

// ── ElementAccess assignment (arr[i] = v) ────────────────────────────

function compileElementAccessAssignment(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  left: ts.ElementAccessExpression,
  right: ts.Expression,
): void {
  const objKind = getExprCollectionKind(ctx, fctx, left.expression);

  if (objKind === "Array") {
    // arr[i] = v → __arr_set(arr, i, v)
    const setIdx = ctx.funcMap.get("__arr_set")!;
    compileExpression(ctx, fctx, left.expression); // arr ptr (i32)
    compileExpression(ctx, fctx, left.argumentExpression); // index (f64)
    fctx.body.push({ op: "i32.trunc_f64_s" }); // index → i32
    compileExpression(ctx, fctx, right); // value (f64)
    fctx.body.push({ op: "i32.trunc_f64_s" }); // value → i32
    fctx.body.push({ op: "call", funcIdx: setIdx });
    // Assignment expressions should return the assigned value
    // Push a dummy f64 value for the expression result
    compileExpression(ctx, fctx, right);
  } else if (objKind === "Uint8Array") {
    // u8[i] = v → __u8arr_set(u8, i, v)
    const setIdx = ctx.funcMap.get("__u8arr_set")!;
    compileExpression(ctx, fctx, left.expression);
    compileExpression(ctx, fctx, left.argumentExpression);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    compileExpression(ctx, fctx, right);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push({ op: "call", funcIdx: setIdx });
    // Push the assigned value as the expression result
    compileExpression(ctx, fctx, right);
  } else {
    ctx.errors.push({
      message: "Unsupported element access assignment",
      line: 0,
      column: 0,
    });
  }
}

// ── Method calls ─────────────────────────────────────────────────────

function compileMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
): void {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;
  const objKind = getExprCollectionKind(ctx, fctx, propAccess.expression);

  if (objKind === "Array") {
    compileArrayMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Uint8Array") {
    compileUint8ArrayMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Map") {
    compileMapMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Set") {
    compileSetMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else {
    // Check if it's a class method call
    const className = inferClassName(ctx, fctx, propAccess.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const wasmMethodName = layout.methods.get(methodName);
        if (wasmMethodName) {
          const funcIdx = ctx.funcMap.get(wasmMethodName);
          if (funcIdx !== undefined) {
            // Push `this` (the object)
            compileExpression(ctx, fctx, propAccess.expression);
            // Push arguments
            for (const arg of expr.arguments) {
              compileExpression(ctx, fctx, arg);
            }
            fctx.body.push({ op: "call", funcIdx });

            // Check if method returns void — if so, push a dummy value
            // because expression statements always emit a `drop`
            const methodFuncType = findMethodResultType(ctx, wasmMethodName);
            if (methodFuncType.length === 0) {
              fctx.body.push({ op: "f64.const", value: 0 });
            }
            return;
          }
        }
      }
    }
    ctx.errors.push({
      message: `Unsupported method call: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileArrayMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "push") {
    // arr.push(val) → __arr_push(arr, i32(val))
    const pushIdx = ctx.funcMap.get("__arr_push")!;
    compileExpression(ctx, fctx, propAccess.expression); // arr ptr (i32)
    compileExpression(ctx, fctx, expr.arguments[0]); // value (f64)
    fctx.body.push({ op: "i32.trunc_f64_s" }); // value → i32
    fctx.body.push({ op: "call", funcIdx: pushIdx });
    // push returns void in runtime, but expression needs a value for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else {
    ctx.errors.push({
      message: `Unsupported Array method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileUint8ArrayMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "slice") {
    // u8.slice(start, end) → __u8arr_slice(u8, start, end)
    // Note: we'd need __u8arr_slice in runtime. For now just report error.
    ctx.errors.push({
      message: "Uint8Array.slice not yet implemented in linear backend",
      line: 0,
      column: 0,
    });
  } else {
    ctx.errors.push({
      message: `Unsupported Uint8Array method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileMapMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "set") {
    // map.set(key, val) → __nmap_set(map, i32(key), i32(val))
    const setIdx = ctx.funcMap.get("__nmap_set")!;
    compileExpression(ctx, fctx, propAccess.expression); // map ptr (i32)
    compileExpression(ctx, fctx, expr.arguments[0]); // key (f64)
    fctx.body.push({ op: "i32.trunc_f64_s" }); // key → i32
    compileExpression(ctx, fctx, expr.arguments[1]); // val (f64)
    fctx.body.push({ op: "i32.trunc_f64_s" }); // val → i32
    fctx.body.push({ op: "call", funcIdx: setIdx });
    // map.set returns void in runtime, push dummy for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (methodName === "get") {
    // map.get(key) → __nmap_get(map, i32(key)) → i32, convert to f64
    const getIdx = ctx.funcMap.get("__nmap_get")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExpression(ctx, fctx, expr.arguments[0]);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push({ op: "call", funcIdx: getIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (methodName === "has") {
    // map.has(key) → __nmap_has(map, i32(key)) → i32, convert to f64
    const hasIdx = ctx.funcMap.get("__nmap_has")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExpression(ctx, fctx, expr.arguments[0]);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push({ op: "call", funcIdx: hasIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: `Unsupported Map method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

function compileSetMethodCall(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): void {
  if (methodName === "add") {
    // set.add(val) → __nset_add(set, i32(val))
    const addIdx = ctx.funcMap.get("__nset_add")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExpression(ctx, fctx, expr.arguments[0]);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push({ op: "call", funcIdx: addIdx });
    // void return, push dummy for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (methodName === "has") {
    // set.has(val) → __nset_has(set, i32(val)) → i32, convert to f64
    const hasIdx = ctx.funcMap.get("__nset_has")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExpression(ctx, fctx, expr.arguments[0]);
    fctx.body.push({ op: "i32.trunc_f64_s" });
    fctx.body.push({ op: "call", funcIdx: hasIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: `Unsupported Set method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

// ── Type inference and resolution ────────────────────────────────────

/** Infer the wasm type of an expression (simple heuristic) */
function inferExprType(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.Expression,
): ValType {
  // String literals are i32 (pointers)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: "i32" };
  }

  // `this` is always an i32 pointer
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return { kind: "i32" };
  }

  // Collections produce i32 pointers
  if (ts.isArrayLiteralExpression(expr)) return { kind: "i32" };
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (name === "Uint8Array" || name === "Map" || name === "Set") {
      return { kind: "i32" };
    }
    // Class constructors return i32 pointers
    if (ctx.classLayouts.has(name)) {
      return { kind: "i32" };
    }
  }
  if (ts.isIdentifier(expr)) {
    const kind = getExprCollectionKind(ctx, fctx, expr);
    if (kind) return { kind: "i32" };
    // Check local type
    const localIdx = fctx.localMap.get(expr.text);
    if (localIdx !== undefined) {
      if (localIdx < fctx.params.length) {
        return fctx.params[localIdx].type;
      } else {
        const localDef = fctx.locals[localIdx - fctx.params.length];
        if (localDef) return localDef.type;
      }
    }
  }

  // Property access on a class — check field type
  if (ts.isPropertyAccessExpression(expr)) {
    const className = inferClassName(ctx, fctx, expr.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const field = layout.fields.get(expr.name.text);
        if (field) {
          return { kind: field.type };
        }
      }
    }
  }

  // For the linear backend, numbers are f64 by default
  // Comparison results are i32 but get converted to f64
  return { kind: "f64" };
}

/** Resolve a TS type annotation to a ValType */
function resolveType(
  _ctx: LinearContext,
  typeNode: ts.TypeNode | undefined,
): ValType | null {
  if (!typeNode) return null;
  const text = typeNode.getText();
  switch (text) {
    case "number":
      return { kind: "f64" };
    case "boolean":
      return { kind: "f64" }; // booleans as f64 (0.0/1.0)
    case "void":
      return null;
    case "string":
      return { kind: "i32" }; // strings are pointers
    default:
      return { kind: "i32" }; // pointers for objects
  }
}

// ── Class support ────────────────────────────────────────────────────

/** Scan a class declaration to extract field names and types, then compute layout. */
function scanClassDeclaration(ctx: LinearContext, classDecl: ts.ClassDeclaration): void {
  const className = classDecl.name!.text;
  const fieldDefs: { name: string; type: "i32" | "f64" }[] = [];
  const seenFields = new Set<string>();

  // First: explicit property declarations
  for (const member of classDecl.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const fieldName = member.name.text;
      const fieldType = resolveFieldType(member.type);
      fieldDefs.push({ name: fieldName, type: fieldType });
      seenFields.add(fieldName);
    }
  }

  // Second: look at constructor body for `this.x = x` assignments
  for (const member of classDecl.members) {
    if (ts.isConstructorDeclaration(member) && member.body) {
      for (const stmt of member.body.statements) {
        if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
          const bin = stmt.expression;
          if (
            bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(bin.left) &&
            bin.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ts.isIdentifier(bin.left.name)
          ) {
            const fieldName = bin.left.name.text;
            if (!seenFields.has(fieldName)) {
              let fieldType: "i32" | "f64" = "f64";
              if (ts.isIdentifier(bin.right)) {
                for (const p of member.parameters) {
                  if (ts.isIdentifier(p.name) && p.name.text === bin.right.text && p.type) {
                    const resolved = resolveType(ctx, p.type);
                    if (resolved && resolved.kind === "i32") fieldType = "i32";
                  }
                }
              }
              fieldDefs.push({ name: fieldName, type: fieldType });
              seenFields.add(fieldName);
            }
          }
        }
      }
    }
  }

  const layout = computeClassLayout(className, fieldDefs);
  ctx.classLayouts.set(className, layout);
}

/** Resolve a field type annotation to "i32" or "f64" */
function resolveFieldType(typeNode: ts.TypeNode | undefined): "i32" | "f64" {
  if (!typeNode) return "f64";
  const text = typeNode.getText();
  switch (text) {
    case "number":
      return "f64";
    case "boolean":
      return "f64";
    default:
      return "i32";
  }
}

/** Compile a class declaration: emit constructor and method functions. */
function compileClassDeclaration(ctx: LinearContext, classDecl: ts.ClassDeclaration): void {
  const className = classDecl.name!.text;
  const layout = ctx.classLayouts.get(className)!;

  let ctorDecl: ts.ConstructorDeclaration | undefined;
  for (const member of classDecl.members) {
    if (ts.isConstructorDeclaration(member)) {
      ctorDecl = member;
      break;
    }
  }

  compileClassCtor(ctx, className, layout, ctorDecl);

  for (const member of classDecl.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      compileClassMethod(ctx, className, layout, member);
    }
  }
}

/** Compile a class constructor. Receives `this` as first parameter. */
function compileClassCtor(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  ctorDecl: ts.ConstructorDeclaration | undefined,
): void {
  const ctorName = layout.ctorFuncName;

  const params: { name: string; type: ValType }[] = [
    { name: "this", type: { kind: "i32" } },
  ];

  if (ctorDecl) {
    for (const p of ctorDecl.parameters) {
      const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
      const type = resolveType(ctx, p.type);
      params.push({ name: paramName, type });
    }
  }

  const paramTypes = params.map((p) => p.type);
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${ctorName}`,
    params: paramTypes,
    results: [],
  });

  const fctx: LinearFuncContext = {
    name: ctorName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    collectionTypes: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  if (ctorDecl?.body) {
    for (const stmt of ctorDecl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  ctx.mod.functions.push({
    name: ctorName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  ctx.currentFunc = null;
}

/** Compile a class method. Receives `this` as first parameter. */
function compileClassMethod(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  methodDecl: ts.MethodDeclaration,
): void {
  const methodName = (methodDecl.name as ts.Identifier).text;
  const wasmMethodName = layout.methods.get(methodName)!;

  const params: { name: string; type: ValType }[] = [
    { name: "this", type: { kind: "i32" } },
  ];

  for (const p of methodDecl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveType(ctx, p.type);
    params.push({ name: paramName, type });
  }

  const returnType = resolveType(ctx, methodDecl.type);
  const isVoid = returnType === null;

  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${wasmMethodName}`,
    params: paramTypes,
    results: resultTypes,
  });

  const fctx: LinearFuncContext = {
    name: wasmMethodName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    collectionTypes: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  if (methodDecl.body) {
    for (const stmt of methodDecl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  ctx.mod.functions.push({
    name: wasmMethodName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  ctx.currentFunc = null;
}

/** Compile `new ClassName(args)` — allocate, set tag, call constructor */
function compileClassNewExpression(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.NewExpression,
  className: string,
  layout: ClassLayout,
): void {
  const mallocIdx = ctx.funcMap.get("__malloc")!;
  const ctorIdx = ctx.funcMap.get(layout.ctorFuncName)!;

  const ptrLocal = addLocal(fctx, `$new_${className}`, { kind: "i32" });

  // __malloc(totalSize)
  fctx.body.push({ op: "i32.const", value: layout.totalSize });
  fctx.body.push({ op: "call", funcIdx: mallocIdx });
  fctx.body.push({ op: "local.set", index: ptrLocal });

  // Store type tag at +0
  fctx.body.push({ op: "local.get", index: ptrLocal });
  fctx.body.push({ op: "i32.const", value: CLASS_TYPE_TAG });
  fctx.body.push({ op: "i32.store8", align: 0, offset: 0 });

  // Store payload size at +4
  fctx.body.push({ op: "local.get", index: ptrLocal });
  fctx.body.push({ op: "i32.const", value: layout.totalSize - 8 });
  fctx.body.push({ op: "i32.store", align: 2, offset: 4 });

  // Call constructor: ctor(this, arg0, arg1, ...)
  fctx.body.push({ op: "local.get", index: ptrLocal });
  if (expr.arguments) {
    for (const arg of expr.arguments) {
      compileExpression(ctx, fctx, arg);
    }
  }
  fctx.body.push({ op: "call", funcIdx: ctorIdx });

  // Result: the pointer
  fctx.body.push({ op: "local.get", index: ptrLocal });
}

/** Compile property assignment: obj.field = value */
function compilePropertyAssignment(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  propExpr: ts.PropertyAccessExpression,
  value: ts.Expression,
): void {
  const propName = propExpr.name.text;
  const className = inferClassName(ctx, fctx, propExpr.expression);

  if (className) {
    const layout = ctx.classLayouts.get(className);
    if (layout) {
      const field = layout.fields.get(propName);
      if (field) {
        // Compile: obj
        compileExpression(ctx, fctx, propExpr.expression);
        // Compile: value
        compileExpression(ctx, fctx, value);

        // Use a temp local so we can return the value (assignment is an expression)
        const tempLocal = addLocal(fctx, `$prop_tmp`, field.type === "f64" ? { kind: "f64" } : { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tempLocal });

        // Store: stack has [ptr], push value, store
        fctx.body.push({ op: "local.get", index: tempLocal });
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
        }

        // Push the value back as the expression result
        fctx.body.push({ op: "local.get", index: tempLocal });
        return;
      }
    }
  }

  ctx.errors.push({
    message: `Unknown property assignment: .${propName}`,
    line: 0,
    column: 0,
  });
}

/** Infer the class name of an expression */
function inferClassName(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.Expression,
): string | undefined {
  // `this` — infer from function name (ClassName_ctor or ClassName_methodName)
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const funcName = fctx.name;
    for (const [className] of ctx.classLayouts) {
      if (funcName === `${className}_ctor` || funcName.startsWith(`${className}_`)) {
        return className;
      }
    }
    return undefined;
  }

  // Identifier — use TS type checker
  if (ts.isIdentifier(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const symbol = type.getSymbol();
      if (symbol) {
        const typeName = symbol.getName();
        if (ctx.classLayouts.has(typeName)) {
          return typeName;
        }
      }
    } catch {
      // Ignore checker errors
    }
    return undefined;
  }

  // NewExpression — the class name from the constructor
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const className = expr.expression.text;
    if (ctx.classLayouts.has(className)) {
      return className;
    }
  }

  return undefined;
}

// ── String literal support ───────────────────────────────────────────

/** Compile a string literal into a __str_from_data call */
function compileStringLiteral(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  value: string,
): void {
  const encoded = new TextEncoder().encode(value);

  // Check if we already have this string in the data segment
  let dataOffset = ctx.stringLiterals.get(value);
  if (dataOffset === undefined) {
    dataOffset = ctx.dataSegmentOffset;
    ctx.stringLiterals.set(value, dataOffset);
    ctx.dataSegmentOffset += encoded.length;
  }

  const strFromDataIdx = ctx.funcMap.get("__str_from_data")!;

  // Call __str_from_data(dataOffset, len) -> i32 pointer
  fctx.body.push({ op: "i32.const", value: dataOffset });
  fctx.body.push({ op: "i32.const", value: encoded.length });
  fctx.body.push({ op: "call", funcIdx: strFromDataIdx });
}

/** Look up a function's result types by its wasm function name */
function findMethodResultType(ctx: LinearContext, wasmFuncName: string): ValType[] {
  for (const f of ctx.mod.functions) {
    if (f.name === wasmFuncName) {
      const typeDef = ctx.mod.types[f.typeIdx];
      if (typeDef && typeDef.kind === "func") {
        return typeDef.results;
      }
    }
  }
  // If not yet compiled (forward reference), look at the funcMap
  // and check types. Return empty array (void) as default.
  return [];
}

/** Check if an expression is a string type */
function isStringExpr(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): boolean {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return true;
  }
  if (ts.isIdentifier(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      if (type.flags & ts.TypeFlags.StringLike) {
        return true;
      }
    } catch {
      // Ignore
    }
    // Also check local type
    const localIdx = fctx.localMap.get(expr.text);
    if (localIdx !== undefined) {
      const localType = localIdx < fctx.params.length
        ? fctx.params[localIdx].type
        : fctx.locals[localIdx - fctx.params.length]?.type;
      // If the local is i32 and was assigned a string, it's a string
      // We can check the type checker for this
    }
  }
  return false;
}
