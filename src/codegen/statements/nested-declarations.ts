/**
 * Nested function and class declaration lowering.
 * Handles function declarations within other functions, class declarations,
 * function hoisting, default parameter handling, and the arguments object.
 */
import ts from "typescript";
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import {
  compileExpression,
  ensureLateImport,
  flushLateImportShifts,
  registerHoistFunctionDeclarations,
  registerEmitArgumentsObject,
} from "../shared.js";
import { emitThrowString } from "../expressions/helpers.js";
import { collectReferencedIdentifiers, collectWrittenIdentifiers } from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "../context/types.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
} from "../registry/types.js";
import { ensureExnTag } from "../registry/imports.js";
import {
  collectClassDeclaration,
  compileClassBodies,
  destructureParamArray,
  destructureParamObject,
  extractConstantDefault,
  resolveWasmType,
} from "../index.js";
import { promoteAccessorCapturesToGlobals } from "../closures.js";
import { collectInstrs } from "./shared.js";
import { compileStatement } from "../shared.js";

export function compileNestedClassDeclaration(
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

export function compileNestedFunctionDeclaration(
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
  // Detect async functions — their TS return type is Promise<T> but the
  // Wasm return should be T (matching the unwrap that top-level async functions use).
  const isAsync = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (isAsync && !isGenerator) {
    ctx.asyncFunctions.add(funcName);
  }

  const sig = ctx.checker.getSignatureFromDeclaration(stmt);
  let returnType: ValType | null = null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (sig) {
    let retType = ctx.checker.getReturnTypeOfSignature(sig);
    // For async functions, unwrap Promise<T> to get T
    if (isAsync) {
      retType = unwrapPromiseType(retType, ctx.checker);
    }
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
    stmt.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => (p.name as ts.Identifier).text),
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
    const funcTypeIdx = addFuncType(ctx, paramTypes, results, `${funcName}_type`);
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
      // The body is wrapped in try/catch so that exceptions thrown before any yields
      // are captured as a "pending throw" and deferred to the first next() call,
      // matching lazy generator semantics (#928).
      const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
      const pendingThrowLocal = allocLocal(liftedFctx, "__gen_pending_throw", { kind: "externref" });
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
      liftedFctx.body.push({ op: "local.set", index: bufferLocal });
      liftedFctx.body.push({ op: "ref.null.extern" } as unknown as Instr);
      liftedFctx.body.push({ op: "local.set", index: pendingThrowLocal });

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

      // Wrap generator body block in try/catch to capture exceptions as pending throw
      const tagIdx = ensureExnTag(ctx);
      const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
      const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal } as unknown as Instr];
      const catchAllBody: Instr[] =
        getCaughtIdx !== undefined
          ? [
              { op: "call", funcIdx: getCaughtIdx } as Instr,
              { op: "local.set", index: pendingThrowLocal } as unknown as Instr,
            ]
          : [];
      liftedFctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
        catches: [{ tagIdx, body: catchBody }],
        catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
      } as unknown as Instr);

      // Return __create_generator or __create_async_generator depending on async flag
      const createGenName = isAsync ? "__create_async_generator" : "__create_generator";
      const createGenIdx = ctx.funcMap.get(createGenName)!;
      liftedFctx.body.push({ op: "local.get", index: bufferLocal });
      liftedFctx.body.push({ op: "local.get", index: pendingThrowLocal });
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
    const funcTypeIdx = addFuncType(ctx, allParamTypes, results, `${funcName}_type`);
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
          liftedFctx.boxedCaptures.set(cap.name, {
            refCellTypeIdx: outerBoxed.refCellTypeIdx,
            valType: outerBoxed.valType,
          });
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
      // The body is wrapped in try/catch so that exceptions thrown before any yields
      // are captured as a "pending throw" and deferred to the first next() call,
      // matching lazy generator semantics (#928).
      const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
      const pendingThrowLocal = allocLocal(liftedFctx, "__gen_pending_throw", { kind: "externref" });
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
      liftedFctx.body.push({ op: "local.set", index: bufferLocal });
      liftedFctx.body.push({ op: "ref.null.extern" } as unknown as Instr);
      liftedFctx.body.push({ op: "local.set", index: pendingThrowLocal });

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

      // Wrap generator body block in try/catch to capture exceptions as pending throw
      const tagIdx = ensureExnTag(ctx);
      const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
      const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal } as unknown as Instr];
      const catchAllBody: Instr[] =
        getCaughtIdx !== undefined
          ? [
              { op: "call", funcIdx: getCaughtIdx } as Instr,
              { op: "local.set", index: pendingThrowLocal } as unknown as Instr,
            ]
          : [];
      liftedFctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
        catches: [{ tagIdx, body: catchBody }],
        catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
      } as unknown as Instr);

      // Return __create_generator or __create_async_generator depending on async flag
      const createGenName = isAsync ? "__create_async_generator" : "__create_generator";
      const createGenIdx = ctx.funcMap.get(createGenName)!;
      liftedFctx.body.push({ op: "local.get", index: bufferLocal });
      liftedFctx.body.push({ op: "local.get", index: pendingThrowLocal });
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
      liftedFctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den } as unknown as Instr);
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
function appendDefaultReturn(fctx: FunctionContext, returnType: ValType | null): void {
  if (!returnType) return;
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (lastInstr && lastInstr.op === "return") return;
  if (returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
  else if (returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
  else if (returnType.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
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

  // Ensure __box_number and __unbox_number are available for mapped arguments sync
  const hasNumericParams = paramTypes.some((pt) => pt.kind === "f64" || pt.kind === "i32");
  if (hasNumericParams) {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
    flushLateImportShifts(ctx, fctx);
  }

  // Set up mapped arguments info for param ↔ arguments bidirectional sync (#849)
  fctx.mappedArgsInfo = {
    argsLocalIdx: argsLocal,
    arrTypeIdx: ati,
    vecTypeIdx: vti,
    paramCount: numArgs,
    paramOffset,
    paramTypes: paramTypes.slice(),
  };

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

// Register delegates in shared.ts so index.ts can call these without
// importing statements/nested-declarations.ts directly (cycle prevention).
registerHoistFunctionDeclarations(hoistFunctionDeclarations);
registerEmitArgumentsObject(emitArgumentsObject);
