// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
import ts from "typescript";
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import type { FuncTypeDef, Instr, ValType, WasmModule } from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import type { CollectionKind, LinearContext, LinearFuncContext } from "./context.js";
import { addLocal } from "./context.js";
import type { ClassLayout } from "./layout.js";
import { computeClassLayout } from "./layout.js";
import {
  addArrayRuntime,
  addMapRuntime,
  addNumericMapRuntime,
  addNumericSetRuntime,
  addRuntime,
  addSetRuntime,
  addStringRuntime,
  addUint8ArrayRuntime,
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

  // Add __closure_env global (mutable i32, init 0) for closure support
  const closureEnvGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__closure_env",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

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
    lambdaCounter: 0,
    tableEntries: [],
    closureEnvGlobalIdx,
    moduleGlobals: new Map(),
    moduleCollectionTypes: new Map(),
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
      // Getter accessors
      if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const getterName = member.name.text;
        const wasmGetterName = `${className}_get_${getterName}`;
        layout.getters.set(getterName, wasmGetterName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmGetterName, className });
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

  // ── Collect module-level variable declarations as wasm globals ──
  collectModuleGlobals(ctx, ast.sourceFile);

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

  emitClosureTable(ctx);

  return mod;
}

/**
 * Generate a WasmModule from multiple TS source files using the linear-memory backend.
 * Cross-file imports are resolved by the TypeScript checker; we iterate all source files.
 */
export function generateLinearMultiModule(multiAst: MultiTypedAST): WasmModule {
  const mod = createEmptyModule();

  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addMapRuntime(mod);
  addSetRuntime(mod);
  addNumericMapRuntime(mod);
  addNumericSetRuntime(mod);

  // Add __closure_env global for closure support
  const closureEnvGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__closure_env",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  const ctx: LinearContext = {
    mod,
    checker: multiAst.checker,
    funcMap: new Map(),
    numImportFuncs: 0,
    currentFunc: null,
    errors: [],
    classLayouts: new Map(),
    stringLiterals: new Map(),
    dataSegmentOffset: DATA_SEGMENT_BASE,
    lambdaCounter: 0,
    tableEntries: [],
    closureEnvGlobalIdx,
    moduleGlobals: new Map(),
    moduleCollectionTypes: new Map(),
  };

  // Register runtime functions in funcMap
  for (let i = 0; i < mod.functions.length; i++) {
    ctx.funcMap.set(mod.functions[i].name, ctx.numImportFuncs + i);
  }

  // ── Class declaration pass: scan all source files ──
  const classDecls: ts.ClassDeclaration[] = [];
  for (const sf of multiAst.sourceFiles) {
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        classDecls.push(stmt);
        scanClassDeclaration(ctx, stmt);
      }
    }
  }

  // ── Forward-register all functions across all files ──
  const allFuncEntries: {
    kind: "ctor" | "method" | "func";
    node: ts.Node;
    name: string;
    className?: string;
    isEntry: boolean;
  }[] = [];

  for (const classDecl of classDecls) {
    const className = classDecl.name!.text;
    const layout = ctx.classLayouts.get(className)!;
    const isEntry = classDecl.getSourceFile() === multiAst.entryFile;

    allFuncEntries.push({ kind: "ctor", node: classDecl, name: layout.ctorFuncName, className, isEntry });

    for (const member of classDecl.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const methodName = member.name.text;
        const wasmMethodName = `${className}_${methodName}`;
        layout.methods.set(methodName, wasmMethodName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmMethodName, className, isEntry });
      }
      if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const getterName = member.name.text;
        const wasmGetterName = `${className}_get_${getterName}`;
        layout.getters.set(getterName, wasmGetterName);
        allFuncEntries.push({ kind: "method", node: member, name: wasmGetterName, className, isEntry });
      }
    }
  }

  // Top-level functions across all source files
  const funcDeclsByFile: { decl: ts.FunctionDeclaration; isEntry: boolean }[] = [];
  for (const sf of multiAst.sourceFiles) {
    const isEntry = sf === multiAst.entryFile;
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        funcDeclsByFile.push({ decl: stmt, isEntry });
        allFuncEntries.push({ kind: "func", node: stmt, name: stmt.name.text, isEntry });
      }
    }
  }

  // Assign function indices
  const runtimeFuncCount = ctx.mod.functions.length;
  for (let i = 0; i < allFuncEntries.length; i++) {
    const entry = allFuncEntries[i];
    const funcIdx = ctx.numImportFuncs + runtimeFuncCount + i;
    ctx.funcMap.set(entry.name, funcIdx);
  }

  // ── Collect module-level variable declarations as wasm globals ──
  for (const sf of multiAst.sourceFiles) {
    collectModuleGlobals(ctx, sf);
  }

  // ── Compile class constructors and methods ──
  for (const classDecl of classDecls) {
    compileClassDeclaration(ctx, classDecl);
  }

  // ── Collect re-exported names from entry file ──
  // e.g. `export { link } from "./linker.js"` in the entry file
  const reExportedNames = new Set<string>();
  for (const stmt of multiAst.entryFile.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        reExportedNames.add(spec.name.text);
      }
    }
  }
  // ── Compile top-level functions (only export entry file's exports) ──
  for (const { decl, isEntry } of funcDeclsByFile) {
    compileFunctionMulti(ctx, decl, isEntry, reExportedNames);
  }

  // ── Fix up function indices after lambda insertion ──
  // Lambdas generated during compilation are inserted into mod.functions,
  // which shifts indices of subsequently compiled functions. Rebuild the
  // funcMap from actual positions and patch all call/ref.func instructions.
  fixupFuncIndices(ctx);

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

  emitClosureTable(ctx);

  return mod;
}

/** Like compileFunction but only exports if isEntry is true or re-exported */
function compileFunctionMulti(
  ctx: LinearContext,
  decl: ts.FunctionDeclaration,
  isEntry: boolean,
  reExportedNames: Set<string>,
): void {
  const name = decl.name!.text;
  const hasExportKeyword = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  // Export if: (1) directly exported from entry file, or (2) re-exported by entry file
  const isExported = (hasExportKeyword && isEntry) || reExportedNames.has(name);

  // Build parameter types
  const params: { name: string; type: ValType }[] = [];
  for (const p of decl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
    params.push({ name: paramName, type });
  }

  const returnType = resolveType(ctx, decl.type);
  const isVoid = returnType === null;
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
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;
  detectCallbackParams(ctx, fctx, decl.parameters);
  detectParamCollectionTypes(ctx, fctx, decl.parameters);
  const funcIdx = ctx.funcMap.get(name)!;

  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

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

function compileFunction(ctx: LinearContext, decl: ts.FunctionDeclaration): void {
  const name = decl.name!.text;
  const isExported = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  // Build parameter types
  const params: { name: string; type: ValType }[] = [];
  for (const p of decl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
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
    callbackParams: new Map(),
  };

  // Register params in localMap
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;
  detectCallbackParams(ctx, fctx, decl.parameters);
  detectParamCollectionTypes(ctx, fctx, decl.parameters);

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

function compileStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.Statement): void {
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
      } else if (ts.isArrayBindingPattern(decl.name) && decl.initializer) {
        // Array destructuring: const [a, b, c] = arr
        compileArrayDestructuring(ctx, fctx, decl.name, decl.initializer);
      } else if (ts.isObjectBindingPattern(decl.name) && decl.initializer) {
        // Object destructuring: const { a, b: c } = obj
        compileObjectDestructuring(ctx, fctx, decl.name, decl.initializer);
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
  } else if (ts.isForOfStatement(stmt)) {
    // for (const x of arr) { ... }
    compileForOfStatement(ctx, fctx, stmt);
  } else if (ts.isDoStatement(stmt)) {
    // do { ... } while (cond)
    compileDoWhileStatement(ctx, fctx, stmt);
  } else if (ts.isSwitchStatement(stmt)) {
    // switch (expr) { case ...: ... }
    compileSwitchStatement(ctx, fctx, stmt);
  } else if (ts.isTryStatement(stmt)) {
    // Compile try body inline (wasm has no exception handling in MVP).
    // The catch clause is skipped — wasm traps are not catchable.
    for (const s of stmt.tryBlock.statements) {
      compileStatement(ctx, fctx, s);
    }
    // Skip catch clause — it would only fire on JS exceptions
  } else if (ts.isExpressionStatement(stmt)) {
    compileExpression(ctx, fctx, stmt.expression);
    // Only drop if the expression produces a value
    if (!isVoidExpression(ctx, stmt.expression)) {
      fctx.body.push({ op: "drop" });
    }
  } else if (ts.isThrowStatement(stmt)) {
    // throw → unreachable (wasm trap)
    fctx.body.push({ op: "unreachable" });
  }
}

// ── ForOfStatement ─────────────────────────────────────────────────────

function compileForOfStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.ForOfStatement): void {
  // Compile the iterable expression (the array)
  compileExpression(ctx, fctx, stmt.expression);
  const arrLocal = addLocal(fctx, `__forof_arr_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // Create index counter
  const idxLocal = addLocal(fctx, `__forof_idx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Determine collection kind for the iterable
  const iterKind = getExprCollectionKind(ctx, fctx, stmt.expression);

  // Get length (use appropriate len function based on collection kind)
  const lenLocal = addLocal(fctx, `__forof_len_${fctx.locals.length}`, { kind: "i32" });
  if (iterKind === "ArrayOrUint8Array") {
    // Runtime dispatch: check tag byte at offset 0
    const arrLenIdx = ctx.funcMap.get("__arr_len")!;
    const u8LenIdx = ctx.funcMap.get("__u8arr_len")!;
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 });
    fctx.body.push({ op: "i32.const", value: 0x02 }); // Uint8Array tag
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: arrLocal },
        { op: "call", funcIdx: u8LenIdx },
      ],
      else: [
        { op: "local.get", index: arrLocal },
        { op: "call", funcIdx: arrLenIdx },
      ],
    });
  } else {
    const lenFuncName = iterKind === "Uint8Array" ? "__u8arr_len" : "__arr_len";
    const arrLenIdx = ctx.funcMap.get(lenFuncName)!;
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "call", funcIdx: arrLenIdx });
  }
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Determine the loop variable name(s)
  const initDecl = stmt.initializer;
  let loopVarName: string | null = null;
  let destructuredNames: string[] | null = null;

  if (ts.isVariableDeclarationList(initDecl)) {
    const decl = initDecl.declarations[0];
    if (ts.isIdentifier(decl.name)) {
      loopVarName = decl.name.text;
    } else if (ts.isArrayBindingPattern(decl.name)) {
      // Destructuring: for (const [k, v] of map)
      destructuredNames = [];
      for (const el of decl.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
          destructuredNames.push(el.name.text);
        }
      }
    }
  }

  // If it's a Map iteration with destructuring, delegate to compileForOfMap
  if (destructuredNames && iterKind === "Map") {
    compileForOfMap(ctx, fctx, stmt, arrLocal, destructuredNames);
    return;
  }

  // Create loop variable (for simple for-of)
  // Determine element type: use TypeChecker to check if elements are numbers or pointers
  let elementIsI32 = false;
  if (loopVarName) {
    try {
      // Check the type of the iterable's element type via the TypeChecker
      const iterType = ctx.checker.getTypeAtLocation(stmt.expression);
      const iterTypeStr = ctx.checker.typeToString(iterType);
      // If it's an array of non-numeric types (objects, strings, etc.), use i32
      if (iterTypeStr.endsWith("[]") && !iterTypeStr.startsWith("number") && !iterTypeStr.startsWith("boolean")) {
        elementIsI32 = true;
      }
    } catch {
      /* fall through */
    }
  }
  let loopVarIdx: number | undefined;
  if (loopVarName) {
    loopVarIdx = addLocal(fctx, loopVarName, elementIsI32 ? { kind: "i32" } : { kind: "f64" });
  }

  // Build loop body
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break condition: idx >= len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break to outer block

  // Load element: x = getter(arr, idx)
  if (loopVarIdx !== undefined) {
    if (iterKind === "ArrayOrUint8Array") {
      // Runtime dispatch: check tag byte at offset 0
      const arrGetIdx = ctx.funcMap.get("__arr_get")!;
      const u8GetIdx = ctx.funcMap.get("__u8arr_get")!;
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 });
      fctx.body.push({ op: "i32.const", value: 0x02 }); // Uint8Array tag
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: arrLocal },
          { op: "local.get", index: idxLocal },
          { op: "call", funcIdx: u8GetIdx },
        ],
        else: [
          { op: "local.get", index: arrLocal },
          { op: "local.get", index: idxLocal },
          { op: "call", funcIdx: arrGetIdx },
        ],
      });
    } else {
      const getFuncName = iterKind === "Uint8Array" ? "__u8arr_get" : "__arr_get";
      const arrGetIdx = ctx.funcMap.get(getFuncName)!;
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: idxLocal });
      fctx.body.push({ op: "call", funcIdx: arrGetIdx });
    }
    if (!elementIsI32) {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    fctx.body.push({ op: "local.set", index: loopVarIdx });
  }

  // Push break/continue stack
  fctx.breakStack.push(fctx.blockDepth);
  fctx.continueStack.push(fctx.blockDepth + 1);
  fctx.blockDepth += 2;

  // Compile body
  compileStatement(ctx, fctx, stmt.statement);

  fctx.blockDepth -= 2;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Increment index
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Continue loop
  fctx.body.push({ op: "br", depth: 0 });

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

// ── ForOfMap (for-of over Map entries with destructuring) ──────────────

function compileForOfMap(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  stmt: ts.ForOfStatement,
  mapLocal: number,
  destructuredNames: string[],
): void {
  // Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
  // Entry: [hash:u32][key:i32][val:i32] = 12 bytes each

  const idxLocal = addLocal(fctx, `__forof_map_idx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: idxLocal });

  const capLocal = addLocal(fctx, `__forof_map_cap_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: mapLocal });
  fctx.body.push({ op: "i32.load", align: 2, offset: 12 });
  fctx.body.push({ op: "local.set", index: capLocal });

  // Determine Map key/value types via TypeChecker
  let keyIsI32 = false;
  let valIsI32 = false;
  try {
    const mapType = ctx.checker.getTypeAtLocation(stmt.expression);
    const mapStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(mapType));
    // Parse Map<K, V> to determine key and value types
    const match = mapStr.match(/^Map<(.+),\s*(.+)>$/);
    if (match) {
      const keyStr = match[1].trim();
      const valStr = match[2].trim();
      if (keyStr !== "number" && keyStr !== "boolean") keyIsI32 = true;
      if (valStr !== "number" && valStr !== "boolean") valIsI32 = true;
    } else {
      // Default: string keys, object values
      keyIsI32 = true;
      valIsI32 = true;
    }
  } catch {
    /* default: f64 */
  }

  // Create locals for destructured variables
  const keyVarIdx =
    destructuredNames.length > 0
      ? addLocal(fctx, destructuredNames[0], keyIsI32 ? { kind: "i32" } : { kind: "f64" })
      : undefined;
  const valVarIdx =
    destructuredNames.length > 1
      ? addLocal(fctx, destructuredNames[1], valIsI32 ? { kind: "i32" } : { kind: "f64" })
      : undefined;

  // Register collection types for destructured variables using TypeChecker
  try {
    const mapType = ctx.checker.getTypeAtLocation(stmt.expression);
    const mapStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(mapType));
    const match = mapStr.match(/^Map<(.+),\s*(.+)>$/);
    if (match) {
      const valStr = match[2].trim();
      if (valStr.endsWith("[]") || valStr.startsWith("Array<")) {
        if (destructuredNames.length > 1) {
          fctx.collectionTypes.set(destructuredNames[1], "Array");
        }
      } else if (valStr.startsWith("Map<") || valStr === "Map") {
        if (destructuredNames.length > 1) {
          fctx.collectionTypes.set(destructuredNames[1], "Map");
        }
      } else if (valStr.startsWith("Set<") || valStr === "Set") {
        if (destructuredNames.length > 1) {
          fctx.collectionTypes.set(destructuredNames[1], "Set");
        }
      }
    }
  } catch {
    /* ignore */
  }

  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break condition: idx >= cap
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: capLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // Compute entry address: map + 16 + idx * 12
  // Read hash at entry address
  const entryAddrLocal = addLocal(fctx, `__forof_entry_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: mapLocal });
  fctx.body.push({ op: "i32.const", value: 16 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 12 });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: entryAddrLocal });

  // Check hash != 0 (non-empty entry)
  fctx.body.push({ op: "local.get", index: entryAddrLocal });
  fctx.body.push({ op: "i32.load", align: 2, offset: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });

  // If hash != 0, process this entry
  const thenBody: Instr[] = [];
  const savedBody2 = fctx.body;
  fctx.body = thenBody;

  // Load key: i32.load at entry + 4
  if (keyVarIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: entryAddrLocal });
    fctx.body.push({ op: "i32.load", align: 2, offset: 4 });
    if (!keyIsI32) fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: keyVarIdx });
  }

  // Load val: i32.load at entry + 8
  if (valVarIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: entryAddrLocal });
    fctx.body.push({ op: "i32.load", align: 2, offset: 8 });
    if (!valIsI32) fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: valVarIdx });
  }

  // Push break/continue stack
  // Note: We're inside the if block, so block depth is higher
  fctx.breakStack.push(fctx.blockDepth);
  fctx.continueStack.push(fctx.blockDepth + 1);
  fctx.blockDepth += 2; // +2 for block/loop that wraps us

  // Compile body
  compileStatement(ctx, fctx, stmt.statement);

  fctx.blockDepth -= 2;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  fctx.body = savedBody2;

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenBody,
  });

  // Increment index
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: idxLocal });

  // Continue loop
  fctx.body.push({ op: "br", depth: 0 });

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

// ── DoWhileStatement ──────────────────────────────────────────────────

function compileDoWhileStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.DoStatement): void {
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Push break/continue stack
  fctx.breakStack.push(fctx.blockDepth);
  fctx.continueStack.push(fctx.blockDepth + 1);
  fctx.blockDepth += 2;

  // Compile body first (do-while executes body before checking condition)
  compileStatement(ctx, fctx, stmt.statement);

  fctx.blockDepth -= 2;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Compile condition
  compileExpression(ctx, fctx, stmt.expression);
  emitTruthyCoercion(fctx, inferExprType(ctx, fctx, stmt.expression));
  // If condition is true, continue looping (br to loop)
  fctx.body.push({ op: "br_if", depth: 0 });

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

// ── SwitchStatement ────────────────────────────────────────────────────

function compileSwitchStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.SwitchStatement): void {
  // Compile as cascading if/else with fall-through support.
  // Group consecutive case clauses with empty bodies (fall-through)
  // into a single OR'd condition.
  compileExpression(ctx, fctx, stmt.expression);
  const switchExprType = inferExprType(ctx, fctx, stmt.expression);
  const switchLocal = addLocal(fctx, `__switch_${fctx.locals.length}`, switchExprType);
  fctx.body.push({ op: "local.set", index: switchLocal });

  let defaultClause: ts.CaseOrDefaultClause | null = null;

  // Track whether any case matched (for default clause guarding)
  let matchedLocal: number | undefined;
  // Pre-scan for default clause
  for (const c of stmt.caseBlock.clauses) {
    if (ts.isDefaultClause(c)) {
      matchedLocal = addLocal(fctx, `__switch_matched_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: matchedLocal });
      break;
    }
  }

  const clauseArr = Array.from(stmt.caseBlock.clauses);
  let i = 0;
  while (i < clauseArr.length) {
    const clause = clauseArr[i]!;
    if (ts.isDefaultClause(clause)) {
      defaultClause = clause;
      i++;
      continue;
    }

    // Collect consecutive case clauses with empty statements (fall-through)
    const caseExprs: ts.Expression[] = [clause.expression!];
    let bodyClause: ts.CaseClause = clause as ts.CaseClause;
    while (bodyClause.statements.length === 0 && i + 1 < clauseArr.length) {
      i++;
      const next = clauseArr[i]!;
      if (ts.isDefaultClause(next)) {
        defaultClause = next;
        break;
      }
      caseExprs.push((next as ts.CaseClause).expression!);
      bodyClause = next as ts.CaseClause;
    }

    // Build OR'd condition: switchVal === case1 || switchVal === case2 || ...
    for (let j = 0; j < caseExprs.length; j++) {
      fctx.body.push({ op: "local.get", index: switchLocal });
      compileExpression(ctx, fctx, caseExprs[j]!);
      if (switchExprType.kind === "f64") {
        fctx.body.push({ op: "f64.eq" });
      } else {
        fctx.body.push({ op: "i32.eq" });
      }
      if (j > 0) {
        fctx.body.push({ op: "i32.or" });
      }
    }

    // Then body
    const thenBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = thenBody;
    if (matchedLocal !== undefined) {
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: matchedLocal });
    }
    for (const s of bodyClause.statements) {
      compileStatement(ctx, fctx, s);
    }
    fctx.body = savedBody;

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenBody,
    });

    i++;
  }

  // Default clause — only execute if no case matched
  if (defaultClause) {
    if (matchedLocal !== undefined) {
      fctx.body.push({ op: "local.get", index: matchedLocal });
      fctx.body.push({ op: "i32.eqz" });
      const defaultBody: Instr[] = [];
      const savedBody = fctx.body;
      fctx.body = defaultBody;
      for (const s of defaultClause.statements) {
        compileStatement(ctx, fctx, s);
      }
      fctx.body = savedBody;
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultBody,
      });
    } else {
      for (const s of defaultClause.statements) {
        compileStatement(ctx, fctx, s);
      }
    }
  }
}

export function compileExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  if (ts.isNumericLiteral(expr)) {
    fctx.body.push({ op: "f64.const", value: Number(expr.text) });
  } else if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    compileStringLiteral(ctx, fctx, expr.text);
  } else if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    // `this` is the first parameter (index 0) in class methods/constructors
    fctx.body.push({ op: "local.get", index: 0 });
  } else if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "f64.const", value: 1 });
  } else if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (expr.kind === ts.SyntaxKind.NullKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else if (ts.isBigIntLiteral(expr)) {
    const text = expr.text.replace(/n$/, "");
    fctx.body.push({ op: "f64.const", value: Number(text) });
  } else if (ts.isBinaryExpression(expr)) {
    compileBinaryExpression(ctx, fctx, expr);
  } else if (ts.isParenthesizedExpression(expr)) {
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (name === "undefined") {
      // undefined is represented as i32 0 (null pointer)
      fctx.body.push({ op: "i32.const", value: 0 });
    } else if (name === "Infinity") {
      fctx.body.push({ op: "f64.const", value: Infinity });
    } else if (name === "NaN") {
      fctx.body.push({ op: "f64.const", value: NaN });
    } else {
      const localIdx = fctx.localMap.get(name);
      if (localIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: localIdx });
      } else {
        // Check module-level globals
        const globalIdx = ctx.moduleGlobals.get(name);
        if (globalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: globalIdx });
        } else {
          ctx.errors.push({
            message: `Unknown identifier: ${name}`,
            line: 0,
            column: 0,
          });
        }
      }
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
      compileExprToI32(ctx, fctx, expr.operand);
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
    } else if (
      ts.isPropertyAccessExpression(expr.operand) &&
      expr.operand.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      // this.field++ / this.field--
      const propName = expr.operand.name.text;
      const className = inferClassName(ctx, fctx, expr.operand.expression);
      if (className) {
        const layout = ctx.classLayouts.get(className);
        if (layout) {
          const field = layout.fields.get(propName);
          if (field) {
            const tempLocal = addLocal(fctx, `$postfix_${propName}`, { kind: field.type });
            const thisIdx = fctx.localMap.get("this") ?? 0;
            // Load old value into temp
            fctx.body.push({ op: "local.get", index: thisIdx });
            if (field.type === "f64") {
              fctx.body.push({ op: "f64.load", align: 3, offset: field.offset });
            } else {
              fctx.body.push({ op: "i32.load", align: 2, offset: field.offset });
            }
            fctx.body.push({ op: "local.set", index: tempLocal });
            // Compute new value and store back
            fctx.body.push({ op: "local.get", index: thisIdx });
            fctx.body.push({ op: "local.get", index: tempLocal });
            if (field.type === "f64") {
              fctx.body.push({ op: "f64.const", value: expr.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1 });
              fctx.body.push({ op: "f64.add" });
              fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
            } else {
              fctx.body.push({ op: "i32.const", value: expr.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1 });
              fctx.body.push({ op: "i32.add" });
              fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
            }
            // Return old value
            fctx.body.push({ op: "local.get", index: tempLocal });
          }
        }
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
      // Built-in type conversion functions → just compile the argument
      if (funcName === "Number" || funcName === "Boolean") {
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]);
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
      } else if (funcName === "String") {
        // String() conversion — pass through for string args, else convert
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]);
        } else {
          compileStringLiteral(ctx, fctx, "");
        }
      } else {
        // Check if this is a callback parameter (indirect call)
        const cbTypeIdx = fctx.callbackParams.get(funcName);
        if (cbTypeIdx !== undefined) {
          // Push arguments first, then the table index
          for (const arg of expr.arguments) {
            compileCallArg(ctx, fctx, arg);
          }
          const localIdx = fctx.localMap.get(funcName)!;
          fctx.body.push({ op: "local.get", index: localIdx }); // table index
          fctx.body.push({ op: "call_indirect", typeIdx: cbTypeIdx, tableIdx: 0 });
        } else {
          const funcIdx = ctx.funcMap.get(funcName);
          if (funcIdx !== undefined) {
            for (const arg of expr.arguments) {
              compileCallArg(ctx, fctx, arg);
            }
            // Fill default values for missing parameters
            emitDefaultArgs(ctx, fctx, funcName, expr.arguments.length);
            fctx.body.push({ op: "call", funcIdx });
          } else {
            ctx.errors.push({
              message: `Unknown function: ${funcName}`,
              line: 0,
              column: 0,
            });
          }
        }
      }
    }
  } else if (ts.isNonNullExpression(expr)) {
    // Handle `expr!` (non-null assertion) - just compile the inner expression
    compileExpression(ctx, fctx, expr.expression);
  } else if (ts.isTemplateExpression(expr)) {
    compileTemplateExpression(ctx, fctx, expr);
  } else if (ts.isConditionalExpression(expr)) {
    // ternary: cond ? then : else
    compileExpression(ctx, fctx, expr.condition);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, expr.condition));

    const resultType = inferExprType(ctx, fctx, expr.whenTrue);

    const thenBody: Instr[] = [];
    const elseBody: Instr[] = [];
    const savedBody = fctx.body;

    fctx.body = thenBody;
    compileExpression(ctx, fctx, expr.whenTrue);
    fctx.body = elseBody;
    compileExpression(ctx, fctx, expr.whenFalse);
    // Ensure else branch matches the block result type
    const elseType = inferExprType(ctx, fctx, expr.whenFalse);
    if (resultType.kind === "f64" && elseType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (resultType.kind === "i32" && elseType.kind === "f64") {
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenBody,
      else: elseBody,
    });
  } else if (ts.isObjectLiteralExpression(expr)) {
    compileObjectLiteral(ctx, fctx, expr);
  }
}

/** Check if a call expression returns void (using TypeChecker + compiled function fallback) */
function isCallVoid(ctx: LinearContext, expr: ts.CallExpression): boolean {
  // First try TypeChecker
  try {
    const callType = ctx.checker.getTypeAtLocation(expr);
    const typeStr = ctx.checker.typeToString(callType);
    if (typeStr === "void") return true;
  } catch {
    /* fall through */
  }
  // Fallback: check compiled function
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;
    const wasmFunc = ctx.mod.functions.find((f) => f.name === funcName);
    if (wasmFunc) {
      const funcType = ctx.mod.types[wasmFunc.typeIdx];
      if (funcType && funcType.kind === "func" && funcType.results.length === 0) return true;
    }
  }
  return false;
}

/**
 * Check if an expression produces no value (void) when compiled.
 * Used by expression statement handler to decide whether to emit `drop`.
 *
 * NOTE: Collection method calls (.push(), .set(), etc.) are NOT considered void
 * here because their handlers push a dummy value to match TS semantics.
 * Only direct function calls and class method calls that truly return void
 * are detected.
 */
function isVoidExpression(ctx: LinearContext, expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;

  // For method calls (property access), use TypeChecker.
  // But skip collection methods (.push() etc.) — their handlers always push a value.
  if (ts.isPropertyAccessExpression(expr.expression)) {
    try {
      const callType = ctx.checker.getTypeAtLocation(expr);
      const typeStr = ctx.checker.typeToString(callType);
      if (typeStr === "void") return true;
    } catch {
      /* fall through */
    }
    return false;
  }

  // For direct function calls, check TypeChecker + compiled function
  return isCallVoid(ctx, expr);
}

/** Emit zero/default values for missing function arguments (for default params) */
function emitDefaultArgs(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  funcName: string,
  providedArgCount: number,
): void {
  const wasmFunc = ctx.mod.functions.find((f) => f.name === funcName);
  if (!wasmFunc) return;
  const funcType = ctx.mod.types[wasmFunc.typeIdx];
  if (!funcType || funcType.kind !== "func") return;
  const expectedArgCount = funcType.params.length;
  for (let i = providedArgCount; i < expectedArgCount; i++) {
    const paramType = funcType.params[i];
    if (paramType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "f64.const", value: 0 });
    }
  }
}

/** Classify a TypeScript property type string into wasm field type */
function classifyFieldType(
  typeStr: string,
  baseType: ts.Type,
  collKinds: Map<string, "Array" | "Uint8Array" | "Map" | "Set">,
  propName: string,
): "i32" | "f64" {
  // Collection types → i32 pointer
  if (typeStr.endsWith("[]") || typeStr.startsWith("Array<")) {
    collKinds.set(propName, "Array");
    return "i32";
  }
  if (typeStr === "Uint8Array" || typeStr.includes("Uint8Array")) {
    collKinds.set(propName, "Uint8Array");
    return "i32";
  }
  if (typeStr.startsWith("Map<") || typeStr === "Map") {
    collKinds.set(propName, "Map");
    return "i32";
  }
  if (typeStr.startsWith("Set<") || typeStr === "Set") {
    collKinds.set(propName, "Set");
    return "i32";
  }
  // Primitives
  if (typeStr === "string") return "i32"; // string = pointer
  if (typeStr === "number") return "f64";
  if (typeStr === "boolean") return "f64";
  // Numeric literal types (e.g., 0 | 1 | 2 | 3 | 4 | 5)
  if (/^\d+(\s*\|\s*\d+)*$/.test(typeStr)) return "f64";
  // Check TypeFlags for numeric types
  if (baseType.getFlags() & ts.TypeFlags.NumberLike) return "f64";
  if (baseType.getFlags() & ts.TypeFlags.BooleanLike) return "f64";
  // Everything else is a pointer (objects, arrays, etc.)
  return "i32";
}

/** Compile an object literal expression as a heap-allocated struct */
function compileObjectLiteral(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.ObjectLiteralExpression): void {
  // Determine the type name from the TypeChecker
  // Use contextual type (from variable annotation or parameter type) first,
  // since getTypeAtLocation on object literals returns the anonymous structural type
  let typeName: string | undefined;
  try {
    const ctxType = ctx.checker.getContextualType(expr);
    if (ctxType) {
      const sym = ctxType.getSymbol() ?? ctxType.aliasSymbol;
      if (sym) {
        const name = sym.getName();
        if (name && name !== "__object" && name !== "__type") typeName = name;
      }
    }
    // Fallback: check parent node for type annotation
    if (!typeName && expr.parent && ts.isVariableDeclaration(expr.parent) && expr.parent.type) {
      const annotText = expr.parent.type.getText();
      if (annotText && !annotText.includes("{")) typeName = annotText;
    }
    // Last resort: getTypeAtLocation
    if (!typeName) {
      const type = ctx.checker.getTypeAtLocation(expr);
      const sym = type.getSymbol() ?? type.aliasSymbol;
      if (sym) {
        const name = sym.getName();
        if (name && name !== "__object" && name !== "__type") typeName = name;
      }
    }
  } catch {
    /* ignore */
  }

  // Collect ALL property definitions from the interface type (not just the literal).
  // This ensures optional fields that get assigned later have proper offsets.
  const propDefs: { name: string; type: "i32" | "f64" }[] = [];
  const collKinds = new Map<string, "Array" | "Uint8Array" | "Map" | "Set">();

  // First, try to get all fields from the contextual/interface type
  let usedInterfaceFields = false;
  try {
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const props = ctxType.getProperties();
      if (props && props.length > 0) {
        usedInterfaceFields = true;
        for (const prop of props) {
          const propName = prop.getName();
          // Determine the type of the property, stripping null/undefined
          const rawType = ctx.checker.getTypeOfSymbolAtLocation(prop, expr);
          const baseType = ctx.checker.getNonNullableType(rawType);
          const typeStr = ctx.checker.typeToString(baseType);
          // Classify the field type
          const fieldType = classifyFieldType(typeStr, baseType, collKinds, propName);
          propDefs.push({ name: propName, type: fieldType });
        }
      }
    }
  } catch {
    /* fall through to literal-based approach */
  }

  // Fallback: collect from literal properties if interface fields couldn't be resolved
  if (!usedInterfaceFields) {
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const propName = prop.name.text;
        const exprType = inferExprType(ctx, fctx, prop.initializer);
        propDefs.push({ name: propName, type: exprType.kind === "i32" ? "i32" : "f64" });
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const propName = prop.name.text;
        const exprType = inferExprType(ctx, fctx, prop.name);
        propDefs.push({ name: propName, type: exprType.kind === "i32" ? "i32" : "f64" });
      }
    }
  }

  // Create or reuse a layout for this type
  if (typeName && !ctx.classLayouts.has(typeName)) {
    const layout = computeClassLayout(typeName, propDefs);
    for (const [k, v] of collKinds) layout.fieldCollectionKinds.set(k, v);
    ctx.classLayouts.set(typeName, layout);
  }

  // For anonymous types without a name, create an ephemeral layout from propDefs
  if (!typeName && propDefs.length > 0) {
    typeName = `__anon_${ctx.lambdaCounter++}`;
    const anonLayout = computeClassLayout(typeName, propDefs);
    for (const [k, v] of collKinds) anonLayout.fieldCollectionKinds.set(k, v);
    ctx.classLayouts.set(typeName, anonLayout);
  }

  // Use the layout to determine total size (includes ALL interface fields)
  const layout = typeName ? ctx.classLayouts.get(typeName) : undefined;
  const HEADER_SIZE = 8;
  const FIELD_SIZE = 8;
  const totalSize = layout ? layout.totalSize : HEADER_SIZE + FIELD_SIZE * propDefs.length;
  const mallocIdx = ctx.funcMap.get("__malloc")!;

  // Allocate (zeroed by __malloc)
  fctx.body.push({ op: "i32.const", value: totalSize });
  fctx.body.push({ op: "call", funcIdx: mallocIdx });

  // Store in a temp local
  const tmpLocal = addLocal(fctx, `__obj_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: tmpLocal });

  // Store header: tag byte (use a generic tag, e.g., 0x10 for anonymous objects)
  fctx.body.push({ op: "i32.const", value: 0x10 });
  fctx.body.push({ op: "i32.store8", align: 0, offset: 0 });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  fctx.body.push({ op: "i32.const", value: totalSize - HEADER_SIZE });
  fctx.body.push({ op: "i32.store", align: 2, offset: 4 });

  // Store each property from the literal (uses layout offsets when available)
  for (const prop of expr.properties) {
    let pName: string | undefined;
    let initExpr: ts.Expression | undefined;
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      pName = prop.name.text;
      initExpr = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      pName = prop.name.text;
      initExpr = prop.name;
    }
    if (!pName || !initExpr) continue;

    const field = layout?.fields.get(pName);
    const fieldOffset = field ? field.offset : undefined;
    if (fieldOffset === undefined) continue; // skip unknown fields

    fctx.body.push({ op: "local.get", index: tmpLocal });
    compileExpression(ctx, fctx, initExpr);
    const valType = inferExprType(ctx, fctx, initExpr);
    if (field!.type === "i32") {
      if (valType.kind !== "i32") {
        fctx.body.push({ op: "i32.trunc_f64_s" });
      }
      fctx.body.push({ op: "i32.store", align: 2, offset: fieldOffset });
    } else {
      if (valType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      fctx.body.push({ op: "f64.store", align: 3, offset: fieldOffset });
    }
  }

  // Leave pointer on stack
  fctx.body.push({ op: "local.get", index: tmpLocal });
}

/**
 * Compile a function call argument. If the argument is an arrow function,
 * compile it as a lambda and emit the closure setup + table index.
 * Otherwise, just compile the expression normally.
 */
function compileCallArg(ctx: LinearContext, fctx: LinearFuncContext, arg: ts.Expression): void {
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    emitClosureSetup(ctx, fctx, arg);
  } else {
    compileExpression(ctx, fctx, arg);
  }
}

function compileBinaryExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.BinaryExpression): void {
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
      // Check module globals
      const gIdx = ctx.moduleGlobals.get(expr.left.text);
      if (gIdx !== undefined) {
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push({ op: "global.set", index: gIdx });
        fctx.body.push({ op: "global.get", index: gIdx });
        return;
      }
    }
  }

  // Handle compound assignment (+=, -=, *=, /=, |=, &=, etc.)
  if (isCompoundAssignment(op) && ts.isIdentifier(expr.left)) {
    const idx = fctx.localMap.get(expr.left.text);
    if (idx !== undefined) {
      if (isBitwiseCompoundAssignment(op)) {
        // Bitwise compound: operate in i32, store f64 result
        compileExprToI32(ctx, fctx, expr.left);
        compileExprToI32(ctx, fctx, expr.right);
        fctx.body.push(bitwiseOp(bitwiseCompoundToOp(op)));
        if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken) {
          fctx.body.push({ op: "f64.convert_i32_u" });
        } else {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        fctx.body.push({ op: "local.tee", index: idx });
      } else {
        fctx.body.push({ op: "local.get", index: idx });
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push(compoundAssignmentOp(op));
        fctx.body.push({ op: "local.tee", index: idx });
      }
      return;
    }
    // Check module globals for compound assignment
    const gIdx = ctx.moduleGlobals.get(expr.left.text);
    if (gIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: gIdx });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push(compoundAssignmentOp(op));
      fctx.body.push({ op: "global.set", index: gIdx });
      fctx.body.push({ op: "global.get", index: gIdx });
      return;
    }
  }

  // Handle compound assignment on property access (e.g. this.pos += n)
  if (isCompoundAssignment(op) && ts.isPropertyAccessExpression(expr.left)) {
    const propName = expr.left.name.text;
    const className = inferClassName(ctx, fctx, expr.left.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      const field = layout?.fields.get(propName);
      if (field) {
        // Load current value: obj.field
        compileExpression(ctx, fctx, expr.left.expression);
        const objLocal = addLocal(fctx, `$compound_obj`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: objLocal });
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.load", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.load", align: 2, offset: field.offset });
        }
        // Compute new value: current op rhs
        compileExpression(ctx, fctx, expr.right);
        fctx.body.push(compoundAssignmentOp(op));
        // Store new value back
        const tempLocal = addLocal(fctx, `$compound_val`, field.type === "f64" ? { kind: "f64" } : { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: tempLocal });
        // Swap: need obj ptr on stack first, then value
        const objLocal2 = objLocal; // reuse
        fctx.body.push({ op: "local.set", index: tempLocal }); // save value
        fctx.body.push({ op: "local.get", index: objLocal2 }); // obj ptr
        fctx.body.push({ op: "local.get", index: tempLocal }); // value
        if (field.type === "f64") {
          fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
        } else {
          fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
        }
        // Leave value on stack as expression result
        fctx.body.push({ op: "local.get", index: tempLocal });
        return;
      }
    }
  }

  // Bitwise operators: need i32 truncation
  if (isBitwiseOp(op)) {
    compileExprToI32(ctx, fctx, expr.left);
    compileExprToI32(ctx, fctx, expr.right);
    fctx.body.push(bitwiseOp(op));
    // Unsigned right shift converts back with unsigned conversion
    if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      fctx.body.push({ op: "f64.convert_i32_u" });
    } else {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return;
  }

  // Check for comparison with undefined/null — use type-appropriate zero check
  const isUndefinedOrNull = (e: ts.Expression) =>
    (ts.isIdentifier(e) && e.text === "undefined") || e.kind === ts.SyntaxKind.NullKeyword;
  if (isComparisonOp(op) && (isUndefinedOrNull(expr.left) || isUndefinedOrNull(expr.right))) {
    const valueExpr = isUndefinedOrNull(expr.left) ? expr.right : expr.left;
    const valueType = inferExprType(ctx, fctx, valueExpr);
    compileExpression(ctx, fctx, valueExpr);
    if (valueType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        fctx.body.push({ op: "i32.eq" });
      } else {
        fctx.body.push({ op: "i32.ne" });
      }
    } else {
      // For f64 optional fields, use f64.const 0 as sentinel for undefined
      fctx.body.push({ op: "f64.const", value: 0 });
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        fctx.body.push({ op: "f64.eq" });
      } else {
        fctx.body.push({ op: "f64.ne" });
      }
    }
    fctx.body.push({ op: "f64.convert_i32_s" });
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

  // Logical AND / OR: short-circuit evaluation producing f64
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    compileExpression(ctx, fctx, expr.left);
    const leftType = inferExprType(ctx, fctx, expr.left);
    emitTruthyCoercion(fctx, leftType);
    const thenBody: Instr[] = [];
    const elseBody: Instr[] = [];
    const savedBody = fctx.body;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      // &&: if left truthy → evaluate right; else → 0
      fctx.body = thenBody;
      compileExprToF64(ctx, fctx, expr.right);
      fctx.body = savedBody;
      elseBody.push({ op: "f64.const", value: 0 });
    } else {
      // ||: if left truthy → 1; else → evaluate right
      thenBody.push({ op: "f64.const", value: 1 });
      fctx.body = elseBody;
      compileExprToF64(ctx, fctx, expr.right);
      fctx.body = savedBody;
    }
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenBody,
      else: elseBody,
    });
    return;
  }

  // Check if both operands are i32 (pointers/non-numeric) for comparison ops
  const leftType = inferExprType(ctx, fctx, expr.left);
  const rightType = inferExprType(ctx, fctx, expr.right);
  const bothI32 = leftType.kind === "i32" && rightType.kind === "i32";

  if (bothI32 && isComparisonOp(op)) {
    // Use i32 comparison operators for pointer/non-numeric types
    compileExpression(ctx, fctx, expr.left);
    compileExpression(ctx, fctx, expr.right);
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        fctx.body.push({ op: "i32.eq" });
        break;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        fctx.body.push({ op: "i32.ne" });
        break;
      case ts.SyntaxKind.LessThanToken:
        fctx.body.push({ op: "i32.lt_s" });
        break;
      case ts.SyntaxKind.LessThanEqualsToken:
        fctx.body.push({ op: "i32.le_s" });
        break;
      case ts.SyntaxKind.GreaterThanToken:
        fctx.body.push({ op: "i32.gt_s" });
        break;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        fctx.body.push({ op: "i32.ge_s" });
        break;
    }
    // i32 comparison returns i32, convert to f64 like other comparisons
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
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

/** Convert a bitwise compound assignment token to its corresponding bitwise operator token */
function bitwiseCompoundToOp(op: ts.SyntaxKind): ts.SyntaxKind {
  switch (op) {
    case ts.SyntaxKind.BarEqualsToken:
      return ts.SyntaxKind.BarToken;
    case ts.SyntaxKind.AmpersandEqualsToken:
      return ts.SyntaxKind.AmpersandToken;
    case ts.SyntaxKind.CaretEqualsToken:
      return ts.SyntaxKind.CaretToken;
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
      return ts.SyntaxKind.LessThanLessThanToken;
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanToken;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    default:
      return op;
  }
}

function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

/** Is this a bitwise compound assignment (|=, &=, ^=, <<=, >>=, >>>=)? */
function isBitwiseCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
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
function detectCollectionKind(ctx: LinearContext, decl: ts.VariableDeclaration): CollectionKind | null {
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
    // Detect new TextEncoder().encode(...) → Uint8Array
    if (ts.isCallExpression(decl.initializer) && ts.isPropertyAccessExpression(decl.initializer.expression)) {
      const pa = decl.initializer.expression;
      if (
        pa.name.text === "encode" &&
        ts.isNewExpression(pa.expression) &&
        ts.isIdentifier(pa.expression.expression) &&
        pa.expression.expression.text === "TextEncoder"
      ) {
        return "Uint8Array";
      }
    }
    // Use TypeChecker for initializer expressions (handles method calls, etc.)
    try {
      const rawType = ctx.checker.getTypeAtLocation(decl.initializer);
      const type = ctx.checker.getNonNullableType(rawType);
      const typeStr = ctx.checker.typeToString(type);
      if (typeStr === "Uint8Array" || typeStr.includes("Uint8Array")) return "Uint8Array";
      if (typeStr.startsWith("Map<") || typeStr === "Map") return "Map";
      if (typeStr.startsWith("Set<") || typeStr === "Set") return "Set";
      if (typeStr === "number[]" || typeStr.endsWith("[]") || typeStr.startsWith("Array<")) return "Array";
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Get the collection kind for an expression (typically an identifier) */
function getExprCollectionKind(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.Expression,
): CollectionKind | null {
  if (ts.isIdentifier(expr)) {
    return fctx.collectionTypes.get(expr.text) ?? ctx.moduleCollectionTypes.get(expr.text) ?? null;
  }
  // Handle property access on class instances: this.data or obj.items
  if (ts.isPropertyAccessExpression(expr)) {
    const className = inferClassName(ctx, fctx, expr.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const kind = layout.fieldCollectionKinds.get(expr.name.text);
        if (kind) return kind;
      }
    }
  }
  // Array literal expressions are always arrays
  if (ts.isArrayLiteralExpression(expr)) {
    return "Array";
  }
  // new Map() / new Set() / new Uint8Array()
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (name === "Map") return "Map";
    if (name === "Set") return "Set";
    if (name === "Uint8Array") return "Uint8Array";
  }
  // TypeChecker fallback for method calls and other expressions
  try {
    const rawType = ctx.checker.getTypeAtLocation(expr);
    const type = ctx.checker.getNonNullableType(rawType);
    const typeStr = ctx.checker.typeToString(type);
    if (typeStr === "Uint8Array" || typeStr.includes("Uint8Array")) return "Uint8Array";
    if (typeStr.startsWith("Map<") || typeStr === "Map") return "Map";
    if (typeStr.startsWith("Set<") || typeStr === "Set") return "Set";
    if (typeStr.endsWith("[]") || typeStr.startsWith("Array<")) return "Array";
  } catch {
    /* fall through */
  }
  return null;
}

// ── Array literal ────────────────────────────────────────────────────

function compileArrayLiteral(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.ArrayLiteralExpression): void {
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
      compileExprToI32(ctx, fctx, elem); // value → i32 for storage
      fctx.body.push({ op: "call", funcIdx: arrPushIdx });
    }

    // Leave the array pointer on the stack as the expression result
    fctx.body.push({ op: "local.get", index: tmpLocal });
  }
  // If empty array, __arr_new already left ptr on stack
}

// ── Array destructuring ──────────────────────────────────────────────

function compileObjectDestructuring(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  pattern: ts.ObjectBindingPattern,
  initializer: ts.Expression,
): void {
  // Compile initializer to get object pointer
  compileExpression(ctx, fctx, initializer);
  const objLocal = addLocal(fctx, `__obj_destr_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Use TypeChecker to get the type of the initializer and compute field offsets
  let objType: ts.Type | null = null;
  try {
    objType = ctx.checker.getTypeAtLocation(initializer);
  } catch {
    /* ignore */
  }

  // Build property list with offsets (matching the TypeChecker-based property access fallback)
  const propOffsets = new Map<string, { offset: number; type: "i32" | "f64" }>();
  if (objType) {
    const props = objType.getProperties();
    let offset = 0;
    for (const prop of props) {
      let isF64 = false;
      try {
        const propType = ctx.checker.getTypeOfSymbolAtLocation(prop, initializer);
        const baseType = ctx.checker.getNonNullableType(propType);
        if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) {
          isF64 = true;
        }
      } catch {
        /* default: i32 */
      }
      const fieldSize = isF64 ? 8 : 4;
      if (isF64 && offset % 8 !== 0) offset = Math.ceil(offset / 8) * 8;
      else if (!isF64 && offset % 4 !== 0) offset = Math.ceil(offset / 4) * 4;
      propOffsets.set(prop.getName(), { offset, type: isF64 ? "f64" : "i32" });
      offset += fieldSize;
    }
  }

  // For each binding element, extract the property value
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (!ts.isBindingElement(element)) continue;

    // Get property name and variable name
    const propName =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
    const varName = ts.isIdentifier(element.name) ? element.name.text : null;

    if (!propName || !varName) continue;

    const fieldInfo = propOffsets.get(propName);
    if (!fieldInfo) {
      ctx.errors.push({ message: `Object destructuring: unknown property "${propName}"`, line: 0, column: 0 });
      continue;
    }

    const localType: ValType = fieldInfo.type === "f64" ? { kind: "f64" } : { kind: "i32" };
    const localIdx = addLocal(fctx, varName, localType);

    // Load field from object
    fctx.body.push({ op: "local.get", index: objLocal });
    if (fieldInfo.type === "f64") {
      fctx.body.push({ op: "f64.load", align: 3, offset: fieldInfo.offset });
    } else {
      fctx.body.push({ op: "i32.load", align: 2, offset: fieldInfo.offset });
    }
    fctx.body.push({ op: "local.set", index: localIdx });

    // Track collection types
    try {
      const propType = ctx.checker.getTypeAtLocation(element);
      const typeStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(propType));
      if (typeStr.endsWith("[]")) fctx.collectionTypes.set(varName, "Array");
    } catch {
      /* ignore */
    }
  }
}

function compileArrayDestructuring(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  pattern: ts.ArrayBindingPattern,
  initializer: ts.Expression,
): void {
  // Compile the initializer (the array expression)
  compileExpression(ctx, fctx, initializer);
  const arrLocal = addLocal(fctx, `__destr_arr_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: arrLocal });

  const arrGetIdx = ctx.funcMap.get("__arr_get")!;

  // Determine element type via TypeChecker
  let elemIsI32 = false;
  try {
    const type = ctx.checker.getTypeAtLocation(initializer);
    const typeStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(type));
    if (typeStr.endsWith("[]") && !typeStr.startsWith("number") && !typeStr.startsWith("boolean")) {
      elemIsI32 = true;
    }
    if (typeStr === "string[]") elemIsI32 = true;
  } catch {
    /* default: f64 */
  }

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i];
    if (ts.isOmittedExpression(element)) continue;
    if (!ts.isBindingElement(element)) continue;

    // Check for rest element: ...name
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        const varName = element.name.text;
        const localIdx = addLocal(fctx, varName, { kind: "i32" });
        // rest = __arr_slice(arr, i, __arr_len(arr))
        const arrSliceIdx = ctx.funcMap.get("__arr_slice")!;
        const arrLenIdx = ctx.funcMap.get("__arr_len")!;
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "i32.const", value: i });
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "call", funcIdx: arrLenIdx });
        fctx.body.push({ op: "call", funcIdx: arrSliceIdx });
        fctx.body.push({ op: "local.set", index: localIdx });
        // Register as Array collection type
        fctx.collectionTypes.set(varName, "Array");
      }
      continue;
    }

    if (ts.isIdentifier(element.name)) {
      const varName = element.name.text;
      const localIdx = addLocal(fctx, varName, elemIsI32 ? { kind: "i32" } : { kind: "f64" });

      // x = __arr_get(arr, i)
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "call", funcIdx: arrGetIdx });
      if (!elemIsI32) {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
  }
}

// ── NewExpression ────────────────────────────────────────────────────

function compileNewExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.NewExpression): void {
  if (!ts.isIdentifier(expr.expression)) {
    ctx.errors.push({ message: "Unsupported new expression", line: 0, column: 0 });
    return;
  }
  const ctorName = expr.expression.text;

  if (ctorName === "Uint8Array") {
    if (expr.arguments && expr.arguments.length > 0) {
      const argType = inferExprType(ctx, fctx, expr.arguments[0]);
      // Check if arg is an ArrayBuffer (i32 pointer) vs a number (f64 size)
      // ArrayBuffer variables are i32 pointers; numeric sizes are f64
      // Use TypeChecker to distinguish
      let isArrayBuffer = false;
      try {
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]);
        const argTypeStr = ctx.checker.typeToString(argTsType);
        isArrayBuffer = argTypeStr === "ArrayBuffer";
      } catch {
        /* fallback: not ArrayBuffer */
      }

      if (isArrayBuffer) {
        // new Uint8Array(arrayBuffer) → __u8arr_from_raw(buf+4, buf[0])
        const fromRawIdx = ctx.funcMap.get("__u8arr_from_raw")!;
        const abTmp = addLocal(fctx, "$u8_ab_tmp", { kind: "i32" });
        compileExpression(ctx, fctx, expr.arguments[0]); // buf ptr
        fctx.body.push({ op: "local.tee", index: abTmp });
        fctx.body.push({ op: "i32.const", value: 4 });
        fctx.body.push({ op: "i32.add" }); // data = buf + 4
        fctx.body.push({ op: "local.get", index: abTmp });
        fctx.body.push({ op: "i32.load", align: 2, offset: 0 }); // len = buf[0]
        fctx.body.push({ op: "call", funcIdx: fromRawIdx });
      } else {
        // Check if arg is a number[] (array) → __u8arr_from_arr(arrPtr)
        let isNumberArray = false;
        try {
          const argTypeStr = ctx.checker.typeToString(ctx.checker.getTypeAtLocation(expr.arguments[0]));
          isNumberArray = argTypeStr === "number[]" || argTypeStr.endsWith("[]");
        } catch {
          /* fallback */
        }
        if (isNumberArray) {
          const fromArrIdx = ctx.funcMap.get("__u8arr_from_arr")!;
          compileExpression(ctx, fctx, expr.arguments[0]);
          fctx.body.push({ op: "call", funcIdx: fromArrIdx });
        } else {
          // new Uint8Array(n) → __u8arr_new(n)
          const u8NewIdx = ctx.funcMap.get("__u8arr_new")!;
          compileExprToI32(ctx, fctx, expr.arguments[0]);
          fctx.body.push({ op: "call", funcIdx: u8NewIdx });
        }
      }
    } else {
      const u8NewIdx = ctx.funcMap.get("__u8arr_new")!;
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "call", funcIdx: u8NewIdx });
    }
  } else if (ctorName === "ArrayBuffer") {
    // new ArrayBuffer(n) → allocate [len:i32 at +0][data at +4], return pointer
    const mallocIdx = ctx.funcMap.get("__malloc")!;
    const tmpPtr = addLocal(fctx, "$ab_ptr", { kind: "i32" });
    if (expr.arguments && expr.arguments.length > 0) {
      compileExprToI32(ctx, fctx, expr.arguments[0]);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    // Allocate 4 + n bytes (4 for the length prefix)
    const tmpLen = addLocal(fctx, "$ab_len", { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: tmpLen });
    fctx.body.push({ op: "i32.const", value: 4 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "call", funcIdx: mallocIdx });
    fctx.body.push({ op: "local.tee", index: tmpPtr });
    // Store length at offset 0
    fctx.body.push({ op: "local.get", index: tmpLen });
    fctx.body.push({ op: "i32.store", align: 2, offset: 0 });
    fctx.body.push({ op: "local.get", index: tmpPtr });
  } else if (ctorName === "Float64Array" || ctorName === "Float32Array") {
    // new Float64Array(buf) / new Float32Array(buf) → returns buf+4 (data pointer)
    // The ArrayBuffer layout is [len at +0][data at +4]
    if (expr.arguments && expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
      fctx.body.push({ op: "i32.const", value: 4 });
      fctx.body.push({ op: "i32.add" }); // skip length prefix to get data ptr
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
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

function compilePropertyAccess(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.PropertyAccessExpression): void {
  const propName = expr.name.text;

  // Try to resolve compile-time constant values (e.g., SECTION.type from `as const` objects)
  try {
    const type = ctx.checker.getTypeAtLocation(expr);
    if (type.isNumberLiteral()) {
      fctx.body.push({ op: "f64.const", value: (type as any).value });
      return;
    }
    if (type.isStringLiteral()) {
      compileStringLiteral(ctx, fctx, (type as any).value);
      return;
    }
  } catch {
    /* fall through to runtime access */
  }

  const objKind = getExprCollectionKind(ctx, fctx, expr.expression);

  if (propName === "length" && (objKind === "Array" || objKind === "Uint8Array" || objKind === "ArrayOrUint8Array")) {
    // arr.length or u8.length → call __arr_len / __u8arr_len
    compileExpression(ctx, fctx, expr.expression);
    if (objKind === "ArrayOrUint8Array") {
      // Runtime dispatch via tag byte
      const arrLenIdx = ctx.funcMap.get("__arr_len")!;
      const u8LenIdx = ctx.funcMap.get("__u8arr_len")!;
      const ptrLocal = addLocal(fctx, `__len_tmp_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: ptrLocal });
      fctx.body.push({ op: "i32.load8_u", align: 0, offset: 0 });
      fctx.body.push({ op: "i32.const", value: 0x02 });
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: ptrLocal },
          { op: "call", funcIdx: u8LenIdx },
        ],
        else: [
          { op: "local.get", index: ptrLocal },
          { op: "call", funcIdx: arrLenIdx },
        ],
      });
    } else {
      const lenFunc = objKind === "Array" ? "__arr_len" : "__u8arr_len";
      const funcIdx = ctx.funcMap.get(lenFunc)!;
      fctx.body.push({ op: "call", funcIdx });
    }
    // Convert i32 result to f64 (since our numeric values are f64)
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }

  // string.length → call __str_len(str) → i32, convert to f64
  if (propName === "length" && isStringExpr(ctx, fctx, expr.expression)) {
    compileExpression(ctx, fctx, expr.expression);
    const strLenIdx = ctx.funcMap.get("__str_len")!;
    fctx.body.push({ op: "call", funcIdx: strLenIdx });
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

  // Check if it's a class field access or getter
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

      // Check for getter
      const getterFuncName = layout.getters.get(propName);
      if (getterFuncName) {
        const funcIdx = ctx.funcMap.get(getterFuncName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, expr.expression);
          fctx.body.push({ op: "call", funcIdx });
          return;
        }
      }
    }
  }

  // TypeChecker-based fallback for anonymous object types
  try {
    const objType = ctx.checker.getTypeAtLocation(expr.expression);
    const baseType = ctx.checker.getNonNullableType(objType);
    const props = baseType.getProperties();
    if (props.length > 0) {
      // Calculate field offset by iterating properties in order
      // Start after the 8-byte header (tag + payload_size)
      const HEADER_SIZE = 8;
      const FIELD_SIZE = 8;
      let offset = HEADER_SIZE;
      let foundField: { offset: number; type: "i32" | "f64" } | null = null;
      for (const prop of props) {
        const rawPropType = ctx.checker.getTypeOfSymbolAtLocation(prop, expr);
        const propType = ctx.checker.getNonNullableType(rawPropType);
        const typeStr = ctx.checker.typeToString(propType);
        const isF64 =
          typeStr === "number" ||
          typeStr === "boolean" ||
          (propType.getFlags() & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0;

        if (prop.getName() === propName) {
          foundField = { offset, type: isF64 ? "f64" : "i32" };
          break;
        }
        offset += FIELD_SIZE; // uniform 8-byte fields to match computeClassLayout
      }
      if (foundField) {
        compileExpression(ctx, fctx, expr.expression);
        if (foundField.type === "f64") {
          fctx.body.push({ op: "f64.load", align: 3, offset: foundField.offset });
        } else {
          fctx.body.push({ op: "i32.load", align: 2, offset: foundField.offset });
        }
        return;
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback: just report error for unsupported property access
  ctx.errors.push({
    message: `Unsupported property access: .${propName}`,
    line: 0,
    column: 0,
  });
}

// ── ElementAccessExpression ──────────────────────────────────────────

function compileElementAccess(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.ElementAccessExpression): void {
  const objKind = getExprCollectionKind(ctx, fctx, expr.expression);

  if (objKind === "Array") {
    // arr[i] → __arr_get(arr, i) → i32
    const getIdx = ctx.funcMap.get("__arr_get")!;
    compileExpression(ctx, fctx, expr.expression); // arr ptr (i32)
    compileExprToI32(ctx, fctx, expr.argumentExpression); // index → i32
    fctx.body.push({ op: "call", funcIdx: getIdx });
    // Only convert to f64 for number/boolean arrays; object/string arrays stay i32
    let elemIsNum = true;
    try {
      const elemType = ctx.checker.getTypeAtLocation(expr);
      const typeStr = ctx.checker.typeToString(elemType);
      if (typeStr !== "number" && typeStr !== "boolean") elemIsNum = false;
    } catch {
      /* default: assume number */
    }
    if (elemIsNum) {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
  } else if (objKind === "Uint8Array") {
    // u8[i] → __u8arr_get(u8, i) → i32, convert to f64 (always numeric)
    const getIdx = ctx.funcMap.get("__u8arr_get")!;
    compileExpression(ctx, fctx, expr.expression);
    compileExprToI32(ctx, fctx, expr.argumentExpression); // index → i32
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
  // Handle typed array views: new Float64Array(buf)[i] = v, new Float32Array(buf)[i] = v
  if (ts.isNewExpression(left.expression) && ts.isIdentifier(left.expression.expression)) {
    const typeName = left.expression.expression.text;
    if (typeName === "Float64Array" && left.expression.arguments?.length) {
      // new Float64Array(buf)[i] = value → buf + i*8, f64.store(value)
      compileExpression(ctx, fctx, left.expression.arguments[0]); // buf ptr
      compileExprToI32(ctx, fctx, left.argumentExpression); // index
      fctx.body.push({ op: "i32.const", value: 3 }); // *8 = <<3
      fctx.body.push({ op: "i32.shl" });
      fctx.body.push({ op: "i32.add" }); // buf + index*8
      compileExpression(ctx, fctx, right); // value (f64)
      fctx.body.push({ op: "f64.store", align: 3, offset: 0 });
      compileExpression(ctx, fctx, right); // return value for expression result
      return;
    }
    if (typeName === "Float32Array" && left.expression.arguments?.length) {
      compileExpression(ctx, fctx, left.expression.arguments[0]);
      compileExprToI32(ctx, fctx, left.argumentExpression);
      fctx.body.push({ op: "i32.const", value: 2 }); // *4 = <<2
      fctx.body.push({ op: "i32.shl" });
      fctx.body.push({ op: "i32.add" });
      compileExpression(ctx, fctx, right); // value (f64)
      fctx.body.push({ op: "f32.demote_f64" });
      fctx.body.push({ op: "f32.store", align: 2, offset: 0 });
      compileExpression(ctx, fctx, right);
      return;
    }
  }

  const objKind = getExprCollectionKind(ctx, fctx, left.expression);

  if (objKind === "Array") {
    // arr[i] = v → __arr_set(arr, i, v)
    const setIdx = ctx.funcMap.get("__arr_set")!;
    compileExpression(ctx, fctx, left.expression); // arr ptr (i32)
    compileExprToI32(ctx, fctx, left.argumentExpression); // index → i32
    compileExprToI32(ctx, fctx, right); // value → i32
    fctx.body.push({ op: "call", funcIdx: setIdx });
    // Assignment expressions should return the assigned value
    compileExpression(ctx, fctx, right);
  } else if (objKind === "Uint8Array") {
    // u8[i] = v → __u8arr_set(u8, i, v)
    const setIdx = ctx.funcMap.get("__u8arr_set")!;
    compileExpression(ctx, fctx, left.expression);
    compileExprToI32(ctx, fctx, left.argumentExpression); // index → i32
    compileExprToI32(ctx, fctx, right); // value → i32
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

function compileMethodCall(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.CallExpression): void {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Handle new TextDecoder().decode(bytes) → __str_from_u8arr(bytes)
  if (
    methodName === "decode" &&
    ts.isNewExpression(propAccess.expression) &&
    ts.isIdentifier(propAccess.expression.expression) &&
    propAccess.expression.expression.text === "TextDecoder"
  ) {
    const strFromU8Idx = ctx.funcMap.get("__str_from_u8arr")!;
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "call", funcIdx: strFromU8Idx });
    return;
  }

  // Handle new TextEncoder().encode(s) → __str_from_u8arr(s) (same layout copy)
  if (
    methodName === "encode" &&
    ts.isNewExpression(propAccess.expression) &&
    ts.isIdentifier(propAccess.expression.expression) &&
    propAccess.expression.expression.text === "TextEncoder"
  ) {
    const strFromU8Idx = ctx.funcMap.get("__str_from_u8arr")!;
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "call", funcIdx: strFromU8Idx });
    return;
  }

  const objKind = getExprCollectionKind(ctx, fctx, propAccess.expression);

  if (objKind === "Array") {
    compileArrayMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Uint8Array") {
    compileUint8ArrayMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Map") {
    compileMapMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (objKind === "Set") {
    compileSetMethodCall(ctx, fctx, expr, propAccess, methodName);
  } else if (methodName === "split" && isStringExpr(ctx, fctx, propAccess.expression)) {
    // string.split(sep) → __str_split(str, sep) → i32 (array pointer)
    const splitIdx = ctx.funcMap.get("__str_split")!;
    compileExpression(ctx, fctx, propAccess.expression); // str
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]); // sep
    } else {
      compileStringLiteral(ctx, fctx, "");
    }
    fctx.body.push({ op: "call", funcIdx: splitIdx });
    return;
  } else if (methodName === "slice" && isStringExpr(ctx, fctx, propAccess.expression)) {
    // string.slice(start, end) → __str_slice(str, start, end)
    const sliceIdx = ctx.funcMap.get("__str_slice")!;
    compileExpression(ctx, fctx, propAccess.expression); // str
    compileExprToI32(ctx, fctx, expr.arguments[0]); // start → i32
    if (expr.arguments.length > 1) {
      compileExprToI32(ctx, fctx, expr.arguments[1]); // end → i32
    } else {
      // end = str.length
      compileExpression(ctx, fctx, propAccess.expression);
      const strLenIdx = ctx.funcMap.get("__str_len")!;
      fctx.body.push({ op: "call", funcIdx: strLenIdx });
    }
    fctx.body.push({ op: "call", funcIdx: sliceIdx });
    return;
  } else if (methodName === "indexOf" && isStringExpr(ctx, fctx, propAccess.expression)) {
    // string.indexOf(search) → __str_index_of(str, search, 0) → i32, convert to f64
    const indexOfIdx = ctx.funcMap.get("__str_index_of")!;
    compileExpression(ctx, fctx, propAccess.expression); // str
    compileExpression(ctx, fctx, expr.arguments[0]); // search
    if (expr.arguments.length > 1) {
      compileExprToI32(ctx, fctx, expr.arguments[1]); // fromIdx
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    fctx.body.push({ op: "call", funcIdx: indexOfIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  } else if (methodName === "startsWith" && isStringExpr(ctx, fctx, propAccess.expression)) {
    // string.startsWith(prefix) → __str_starts_with(str, prefix)
    const startsWithIdx = ctx.funcMap.get("__str_starts_with")!;
    compileExpression(ctx, fctx, propAccess.expression); // str
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]); // prefix
    } else {
      compileStringLiteral(ctx, fctx, "");
    }
    fctx.body.push({ op: "call", funcIdx: startsWithIdx });
    // Convert i32 result to f64
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  } else if (methodName === "toString") {
    // x.toString(...) — for numbers, just compile x (it's already a value)
    compileExpression(ctx, fctx, propAccess.expression);
    return;
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
            // Push arguments (handles arrow function args as closures)
            for (const arg of expr.arguments) {
              compileCallArg(ctx, fctx, arg);
            }
            // Fill default values for missing parameters (skip `this`)
            emitDefaultArgs(ctx, fctx, wasmMethodName, expr.arguments.length + 1);
            fctx.body.push({ op: "call", funcIdx });
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
    compileExprToI32(ctx, fctx, expr.arguments[0]); // value → i32
    fctx.body.push({ op: "call", funcIdx: pushIdx });
    // push returns void in runtime, but expression needs a value for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (
    methodName === "filter" ||
    methodName === "map" ||
    methodName === "some" ||
    methodName === "find" ||
    methodName === "flatMap"
  ) {
    // Inline expansion of higher-order array methods
    compileArrayHOF(ctx, fctx, expr, propAccess, methodName as "filter" | "map" | "some" | "find" | "flatMap");
  } else if (methodName === "join") {
    // arr.join(sep) → inline string concatenation
    compileArrayJoin(ctx, fctx, expr, propAccess);
  } else if (methodName === "length") {
    // arr.length (handled as property, but just in case)
    compileExpression(ctx, fctx, propAccess.expression);
    const lenIdx = ctx.funcMap.get("__arr_len")!;
    fctx.body.push({ op: "call", funcIdx: lenIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    ctx.errors.push({
      message: `Unsupported Array method: .${methodName}()`,
      line: 0,
      column: 0,
    });
  }
}

// ── Inline higher-order Array methods (filter/map/some/find) ──────────

function compileArrayHOF(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: "filter" | "map" | "some" | "find" | "flatMap",
): void {
  const arrLenIdx = ctx.funcMap.get("__arr_len")!;
  const arrGetIdx = ctx.funcMap.get("__arr_get")!;
  const arrNewIdx = ctx.funcMap.get("__arr_new")!;
  const arrPushIdx = ctx.funcMap.get("__arr_push")!;

  // Extract lambda parameter and body
  const callback = expr.arguments[0];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    ctx.errors.push({ message: `Array.${method}() requires inline arrow function`, line: 0, column: 0 });
    return;
  }
  const paramName =
    callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)
      ? callback.parameters[0].name.text
      : "__hof_param";
  // Optional second parameter (index)
  const indexParamName =
    callback.parameters[1] && ts.isIdentifier(callback.parameters[1].name) ? callback.parameters[1].name.text : null;

  // Determine element type (i32 for objects/strings, f64 for numbers)
  let elemIsI32 = true;
  try {
    const arrType = ctx.checker.getTypeAtLocation(propAccess.expression);
    const arrStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(arrType));
    if (arrStr === "number[]" || arrStr === "boolean[]") elemIsI32 = false;
  } catch {
    /* default: i32 */
  }
  const elemType: ValType = elemIsI32 ? { kind: "i32" } : { kind: "f64" };

  // Create temp locals
  const arrLocal = addLocal(fctx, `__hof_arr_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = addLocal(fctx, `__hof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = addLocal(fctx, `__hof_len_${fctx.locals.length}`, { kind: "i32" });
  const elemLocal = addLocal(fctx, paramName, elemType);
  const indexLocal = indexParamName ? addLocal(fctx, indexParamName, { kind: "f64" }) : undefined;

  let resultLocal: number | undefined;
  if (method === "filter" || method === "map" || method === "flatMap") {
    resultLocal = addLocal(fctx, `__hof_result_${fctx.locals.length}`, { kind: "i32" });
  } else if (method === "some") {
    resultLocal = addLocal(fctx, `__hof_result_${fctx.locals.length}`, { kind: "f64" });
  } else if (method === "find") {
    resultLocal = addLocal(fctx, `__hof_result_${fctx.locals.length}`, { kind: "i32" });
  }

  // Initialize: arrLocal = source array
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // lenLocal = __arr_len(arrLocal)
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "call", funcIdx: arrLenIdx });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // iLocal = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  if (method === "filter" || method === "map" || method === "flatMap") {
    // resultLocal = __arr_new(16)
    fctx.body.push({ op: "i32.const", value: 16 });
    fctx.body.push({ op: "call", funcIdx: arrNewIdx });
    fctx.body.push({ op: "local.set", index: resultLocal! });
  } else if (method === "some") {
    // resultLocal = 0.0 (false)
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "local.set", index: resultLocal! });
  } else if (method === "find") {
    // resultLocal = 0 (null pointer)
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: resultLocal! });
  }

  // Build loop body
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break: if (i >= len) break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // elem = __arr_get(arr, i)
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "call", funcIdx: arrGetIdx });
  if (!elemIsI32) {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }
  fctx.body.push({ op: "local.set", index: elemLocal });

  // Set index param if present
  if (indexLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: indexLocal });
  }

  // Compile callback body expression
  const bodyExpr = ts.isBlock(callback.body)
    ? callback.body.statements[0] && ts.isReturnStatement(callback.body.statements[0])
      ? callback.body.statements[0].expression
      : undefined
    : callback.body;

  if (!bodyExpr) {
    ctx.errors.push({ message: `Array.${method}() callback must have a simple expression body`, line: 0, column: 0 });
    fctx.body = savedBody;
    return;
  }

  if (method === "filter") {
    // if (callback(elem)) __arr_push(result, elem)
    compileExpression(ctx, fctx, bodyExpr);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, bodyExpr));
    const pushBody: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = pushBody;
    fctx.body.push({ op: "local.get", index: resultLocal! });
    fctx.body.push({ op: "local.get", index: elemLocal });
    if (!elemIsI32) {
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
    fctx.body = savedBody2;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: pushBody });
  } else if (method === "map") {
    // __arr_push(result, callback(elem))
    fctx.body.push({ op: "local.get", index: resultLocal! });
    compileExpression(ctx, fctx, bodyExpr);
    // Convert mapped value to i32 for storage
    const mappedType = inferExprType(ctx, fctx, bodyExpr);
    if (mappedType.kind === "f64") {
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  } else if (method === "some") {
    // if (callback(elem)) { result = 1.0; break; }
    compileExpression(ctx, fctx, bodyExpr);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, bodyExpr));
    const foundBody: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = foundBody;
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: "local.set", index: resultLocal! });
    fctx.body.push({ op: "br", depth: 2 }); // break out of block+loop
    fctx.body = savedBody2;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: foundBody });
  } else if (method === "find") {
    // if (callback(elem)) { result = elem; break; }
    compileExpression(ctx, fctx, bodyExpr);
    emitTruthyCoercion(fctx, inferExprType(ctx, fctx, bodyExpr));
    const foundBody: Instr[] = [];
    const savedBody2 = fctx.body;
    fctx.body = foundBody;
    fctx.body.push({ op: "local.get", index: elemLocal });
    fctx.body.push({ op: "local.set", index: resultLocal! });
    fctx.body.push({ op: "br", depth: 2 }); // break out of block+loop
    fctx.body = savedBody2;
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: foundBody });
  } else if (method === "flatMap") {
    // innerArr = callback(elem); for j in innerArr: __arr_push(result, innerArr[j])
    const innerArrLocal = addLocal(fctx, `__hof_inner_${fctx.locals.length}`, { kind: "i32" });
    const jLocal = addLocal(fctx, `__hof_j_${fctx.locals.length}`, { kind: "i32" });
    const innerLenLocal = addLocal(fctx, `__hof_ilen_${fctx.locals.length}`, { kind: "i32" });
    compileExpression(ctx, fctx, bodyExpr);
    const innerType = inferExprType(ctx, fctx, bodyExpr);
    if (innerType.kind === "f64") {
      fctx.body.push({ op: "i32.trunc_f64_s" });
    }
    fctx.body.push({ op: "local.set", index: innerArrLocal });
    // innerLen = __arr_len(innerArr)
    fctx.body.push({ op: "local.get", index: innerArrLocal });
    fctx.body.push({ op: "call", funcIdx: arrLenIdx });
    fctx.body.push({ op: "local.set", index: innerLenLocal });
    // j = 0
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: jLocal });
    // Inner loop: for j in innerArr
    const innerLoopBody: Instr[] = [];
    // break: if (j >= innerLen) break
    innerLoopBody.push({ op: "local.get", index: jLocal });
    innerLoopBody.push({ op: "local.get", index: innerLenLocal });
    innerLoopBody.push({ op: "i32.ge_s" });
    innerLoopBody.push({ op: "br_if", depth: 1 });
    // __arr_push(result, __arr_get(innerArr, j))
    innerLoopBody.push({ op: "local.get", index: resultLocal! });
    innerLoopBody.push({ op: "local.get", index: innerArrLocal });
    innerLoopBody.push({ op: "local.get", index: jLocal });
    innerLoopBody.push({ op: "call", funcIdx: arrGetIdx });
    innerLoopBody.push({ op: "call", funcIdx: arrPushIdx });
    // j++
    innerLoopBody.push({ op: "local.get", index: jLocal });
    innerLoopBody.push({ op: "i32.const", value: 1 });
    innerLoopBody.push({ op: "i32.add" });
    innerLoopBody.push({ op: "local.set", index: jLocal });
    innerLoopBody.push({ op: "br", depth: 0 });

    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: innerLoopBody,
        },
      ],
    });
  }

  // i++
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });
  fctx.body.push({ op: "br", depth: 0 });

  fctx.body = savedBody;

  // Emit block+loop structure
  fctx.blockDepth += 2;
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
  fctx.blockDepth -= 2;

  // Push result
  if (method === "filter" || method === "map" || method === "find" || method === "flatMap") {
    fctx.body.push({ op: "local.get", index: resultLocal! });
  } else if (method === "some") {
    fctx.body.push({ op: "local.get", index: resultLocal! });
  }

  // Clean up the lambda param from localMap so it doesn't conflict
  // (it stays in locals array but won't be resolved by name)
}

// ── Array.join() ──────────────────────────────────────────────────────

function compileArrayJoin(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): void {
  const arrLenIdx = ctx.funcMap.get("__arr_len")!;
  const arrGetIdx = ctx.funcMap.get("__arr_get")!;
  const strConcatIdx = ctx.funcMap.get("__str_concat")!;

  // Get separator (default ",")
  const sepArg = expr.arguments[0];

  // Create temp locals
  const arrLocal = addLocal(fctx, `__join_arr_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = addLocal(fctx, `__join_i_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = addLocal(fctx, `__join_len_${fctx.locals.length}`, { kind: "i32" });
  const resultLocal = addLocal(fctx, `__join_result_${fctx.locals.length}`, { kind: "i32" });
  const sepLocal = addLocal(fctx, `__join_sep_${fctx.locals.length}`, { kind: "i32" });

  // arrLocal = source array
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // lenLocal = __arr_len(arrLocal)
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "call", funcIdx: arrLenIdx });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // iLocal = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // resultLocal = "" (empty string)
  fctx.body.push({ op: "i32.const", value: 0 }); // empty string = null ptr (length 0)
  fctx.body.push({ op: "local.set", index: resultLocal });

  // sepLocal = separator string
  if (sepArg) {
    compileExprToI32(ctx, fctx, sepArg);
  } else {
    // Default separator is ","
    fctx.body.push({ op: "i32.const", value: 0 }); // placeholder
  }
  fctx.body.push({ op: "local.set", index: sepLocal });

  // Build loop body
  const loopBody: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = loopBody;

  // Break: if (i >= len) break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // If i > 0, append separator
  const appendSepBody: Instr[] = [];
  const savedBody2 = fctx.body;
  fctx.body = appendSepBody;
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: sepLocal });
  fctx.body.push({ op: "call", funcIdx: strConcatIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });
  fctx.body = savedBody2;

  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: appendSepBody });

  // Append element: result = __str_concat(result, arr[i])
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "call", funcIdx: arrGetIdx });
  // arr[i] returns i32 (string pointer for string arrays)
  fctx.body.push({ op: "call", funcIdx: strConcatIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // i++
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });
  fctx.body.push({ op: "br", depth: 0 });

  fctx.body = savedBody;

  // Emit block+loop
  fctx.blockDepth += 2;
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
  fctx.blockDepth -= 2;

  // Push result (string pointer)
  fctx.body.push({ op: "local.get", index: resultLocal });
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
    const sliceIdx = ctx.funcMap.get("__u8arr_slice")!;
    compileExpression(ctx, fctx, propAccess.expression); // u8 ptr
    if (expr.arguments.length >= 2) {
      compileExprToI32(ctx, fctx, expr.arguments[0]!); // start → i32
      compileExprToI32(ctx, fctx, expr.arguments[1]!); // end → i32
    } else if (expr.arguments.length === 1) {
      compileExprToI32(ctx, fctx, expr.arguments[0]!); // start → i32
      // end = length
      compileExpression(ctx, fctx, propAccess.expression);
      const lenIdx = ctx.funcMap.get("__u8arr_len")!;
      fctx.body.push({ op: "call", funcIdx: lenIdx });
    } else {
      // Full copy: start=0, end=length
      fctx.body.push({ op: "i32.const", value: 0 });
      compileExpression(ctx, fctx, propAccess.expression);
      const lenIdx = ctx.funcMap.get("__u8arr_len")!;
      fctx.body.push({ op: "call", funcIdx: lenIdx });
    }
    fctx.body.push({ op: "call", funcIdx: sliceIdx });
  } else if (methodName === "set") {
    // u8.set(source) → copy source bytes into u8
    // Inline loop: for (let i = 0; i < src.len; i++) dest[12+i] = src[12+i]
    const u8LenIdx = ctx.funcMap.get("__u8arr_len")!;
    const destLocal = addLocal(fctx, `__u8set_dest_${fctx.locals.length}`, { kind: "i32" });
    const srcLocal = addLocal(fctx, `__u8set_src_${fctx.locals.length}`, { kind: "i32" });
    const lenLocal = addLocal(fctx, `__u8set_len_${fctx.locals.length}`, { kind: "i32" });
    const iLocal = addLocal(fctx, `__u8set_i_${fctx.locals.length}`, { kind: "i32" });

    compileExpression(ctx, fctx, propAccess.expression); // dest u8 ptr
    fctx.body.push({ op: "local.set", index: destLocal });
    compileExprToI32(ctx, fctx, expr.arguments[0]!); // source u8 ptr
    fctx.body.push({ op: "local.set", index: srcLocal });

    // len = __u8arr_len(src)
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "call", funcIdx: u8LenIdx });
    fctx.body.push({ op: "local.set", index: lenLocal });

    // i = 0
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iLocal });

    // Copy loop
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iLocal },
            { op: "local.get", index: lenLocal },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            // dest[12+i] = src[12+i]
            { op: "local.get", index: destLocal },
            { op: "local.get", index: iLocal },
            { op: "i32.add" },
            { op: "local.get", index: srcLocal },
            { op: "local.get", index: iLocal },
            { op: "i32.add" },
            { op: "i32.load8_u", align: 0, offset: 12 },
            { op: "i32.store8", align: 0, offset: 12 },
            // i++
            { op: "local.get", index: iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
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
    compileExprToI32(ctx, fctx, expr.arguments[0]); // key → i32
    compileExprToI32(ctx, fctx, expr.arguments[1]); // val → i32
    fctx.body.push({ op: "call", funcIdx: setIdx });
    // map.set returns void in runtime, push dummy for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (methodName === "get") {
    // map.get(key) → __nmap_get(map, i32(key)) → i32
    const getIdx = ctx.funcMap.get("__nmap_get")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // key → i32
    fctx.body.push({ op: "call", funcIdx: getIdx });
    // Only convert to f64 for numeric/boolean map values; object/array values stay i32
    let valIsNum = true;
    try {
      const retType = ctx.checker.getTypeAtLocation(expr);
      const retStr = ctx.checker.typeToString(ctx.checker.getNonNullableType(retType));
      if (retStr !== "number" && retStr !== "boolean") valIsNum = false;
    } catch {
      /* default: assume number */
    }
    if (valIsNum) {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
  } else if (methodName === "has") {
    // map.has(key) → __nmap_has(map, i32(key)) → i32, convert to f64
    const hasIdx = ctx.funcMap.get("__nmap_has")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // key → i32
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
    compileExprToI32(ctx, fctx, expr.arguments[0]); // val → i32
    fctx.body.push({ op: "call", funcIdx: addIdx });
    // void return, push dummy for drop
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (methodName === "has") {
    // set.has(val) → __nset_has(set, i32(val)) → i32, convert to f64
    const hasIdx = ctx.funcMap.get("__nset_has")!;
    compileExpression(ctx, fctx, propAccess.expression);
    compileExprToI32(ctx, fctx, expr.arguments[0]); // val → i32
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

/**
 * Compile an expression and convert to i32 if needed.
 * If the expression produces f64, emit i32.trunc_f64_s; if i32, no-op.
 */
function compileExprToI32(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  const exprType = inferExprType(ctx, fctx, expr);
  compileExpression(ctx, fctx, expr);
  if (exprType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
}

/**
 * Compile an expression and convert to f64 if needed.
 * If the expression produces i32, emit f64.convert_i32_s; if f64, no-op.
 */
function compileExprToF64(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  const exprType = inferExprType(ctx, fctx, expr);
  compileExpression(ctx, fctx, expr);
  if (exprType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }
}

// ── Type inference and resolution ────────────────────────────────────

/** Infer the wasm type of an expression (simple heuristic) */
function inferExprType(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): ValType {
  // String literals and template expressions are i32 (pointers)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) {
    return { kind: "i32" };
  }

  // `this` is always an i32 pointer
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return { kind: "i32" };
  }

  // undefined and null are i32 (null pointer)
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "i32" };
  }
  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    return { kind: "i32" };
  }

  // Collections and object literals produce i32 pointers
  if (ts.isArrayLiteralExpression(expr)) return { kind: "i32" };
  if (ts.isObjectLiteralExpression(expr)) return { kind: "i32" };
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    if (
      name === "Uint8Array" ||
      name === "Map" ||
      name === "Set" ||
      name === "ArrayBuffer" ||
      name === "Float64Array" ||
      name === "Float32Array"
    ) {
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
    // Check module globals
    const gIdx = ctx.moduleGlobals.get(expr.text);
    if (gIdx !== undefined) {
      return ctx.mod.globals[gIdx].type;
    }
  }

  // Property access — check field type
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    // Check collection length/size
    const objKind = getExprCollectionKind(ctx, fctx, expr.expression);
    if (
      (propName === "length" && (objKind === "Array" || objKind === "Uint8Array" || objKind === "ArrayOrUint8Array")) ||
      (propName === "size" && (objKind === "Map" || objKind === "Set"))
    ) {
      return { kind: "f64" }; // length/size are returned as f64
    }
    if (propName === "length" && isStringExpr(ctx, fctx, expr.expression)) {
      return { kind: "f64" };
    }
    // Check class layout
    const className = inferClassName(ctx, fctx, expr.expression);
    if (className) {
      const layout = ctx.classLayouts.get(className);
      if (layout) {
        const field = layout.fields.get(propName);
        if (field) {
          return { kind: field.type };
        }
      }
    }
    // TypeChecker fallback for anonymous object types
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const baseType = ctx.checker.getNonNullableType(type);
      if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return { kind: "f64" };
      return { kind: "i32" }; // strings, objects, arrays → pointer
    } catch {
      /* fall through */
    }
  }

  // NonNull assertion: unwrap
  if (ts.isNonNullExpression(expr)) {
    return inferExprType(ctx, fctx, expr.expression);
  }

  // Parenthesized: unwrap
  if (ts.isParenthesizedExpression(expr)) {
    return inferExprType(ctx, fctx, expr.expression);
  }

  // Element access: check TypeChecker for element type
  if (ts.isElementAccessExpression(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const typeStr = ctx.checker.typeToString(type);
      if (typeStr === "number" || typeStr === "boolean") return { kind: "f64" };
      return { kind: "i32" }; // objects, strings → pointer
    } catch {
      /* fall through */
    }
  }

  // Postfix/prefix unary
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
    // ! and ~ always convert result to f64 (via f64.convert_i32_s)
    if (
      ts.isPrefixUnaryExpression(expr) &&
      (expr.operator === ts.SyntaxKind.ExclamationToken || expr.operator === ts.SyntaxKind.TildeToken)
    ) {
      return { kind: "f64" };
    }
    return inferExprType(ctx, fctx, expr.operand);
  }

  // Call expression: check return type via TypeChecker
  if (ts.isCallExpression(expr)) {
    try {
      const type = ctx.checker.getTypeAtLocation(expr);
      const baseType = ctx.checker.getNonNullableType(type);
      if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return { kind: "f64" };
      const typeStr = ctx.checker.typeToString(baseType);
      if (typeStr !== "void") return { kind: "i32" };
    } catch {
      /* fall through */
    }
  }

  // Conditional (ternary) expression: type of the result
  if (ts.isConditionalExpression(expr)) {
    return inferExprType(ctx, fctx, expr.whenTrue);
  }

  // For the linear backend, numbers are f64 by default
  // Comparison results are i32 but get converted to f64
  return { kind: "f64" };
}

/** Resolve a TS type annotation to a ValType */
function resolveType(_ctx: LinearContext, typeNode: ts.TypeNode | undefined): ValType | null {
  if (!typeNode) return null;
  // Strip "| undefined" and "| null" for optional types
  const text = typeNode
    .getText()
    .replace(/\s*\|\s*(undefined|null)/g, "")
    .trim();
  switch (text) {
    case "number":
      return { kind: "f64" };
    case "boolean":
      return { kind: "f64" }; // booleans as f64 (0.0/1.0)
    case "bigint":
      return { kind: "f64" }; // bigints as f64 (best-effort)
    case "void":
      return null;
    case "string":
      return { kind: "i32" }; // strings are pointers
    default:
      return { kind: "i32" }; // pointers for objects
  }
}

/** Resolve parameter type using TypeChecker (for params without explicit type annotations) */
function resolveParamTypeFromChecker(ctx: LinearContext, param: ts.ParameterDeclaration): ValType {
  // First try explicit type annotation
  if (param.type) {
    const resolved = resolveType(ctx, param.type);
    if (resolved) return resolved;
  }
  // Fall back to checker inference
  try {
    const type = ctx.checker.getTypeAtLocation(param);
    const typeStr = ctx.checker.typeToString(type);
    if (typeStr === "number" || typeStr === "boolean" || typeStr === "bigint") return { kind: "f64" };
    if (typeStr === "void") return { kind: "f64" }; // shouldn't happen for params
    return { kind: "i32" }; // strings, objects, arrays → pointers
  } catch {
    return { kind: "f64" }; // default fallback
  }
}

// ── Class support ────────────────────────────────────────────────────

/** Scan a class declaration to extract field names and types, then compute layout. */
function scanClassDeclaration(ctx: LinearContext, classDecl: ts.ClassDeclaration): void {
  const className = classDecl.name!.text;
  const fieldDefs: { name: string; type: "i32" | "f64" }[] = [];
  const seenFields = new Set<string>();

  // Track collection kinds for fields
  const fieldCollectionKinds = new Map<string, "Array" | "Uint8Array" | "Map" | "Set">();

  // First: explicit property declarations
  for (const member of classDecl.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const fieldName = member.name.text;
      const fieldType = resolveFieldType(member.type);
      fieldDefs.push({ name: fieldName, type: fieldType });
      seenFields.add(fieldName);
      // Detect collection kind from type annotation
      if (member.type) {
        const typeText = member.type.getText();
        if (typeText.endsWith("[]") || typeText.startsWith("Array<")) {
          fieldCollectionKinds.set(fieldName, "Array");
        } else if (typeText === "Uint8Array") {
          fieldCollectionKinds.set(fieldName, "Uint8Array");
        } else if (typeText.startsWith("Map<") || typeText === "Map") {
          fieldCollectionKinds.set(fieldName, "Map");
        } else if (typeText.startsWith("Set<") || typeText === "Set") {
          fieldCollectionKinds.set(fieldName, "Set");
        }
      }
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
  // Store collection kinds for fields
  for (const [fieldName, kind] of fieldCollectionKinds) {
    layout.fieldCollectionKinds.set(fieldName, kind);
  }
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

  compileClassCtor(ctx, className, layout, ctorDecl, classDecl);

  for (const member of classDecl.members) {
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      compileClassMethod(ctx, className, layout, member);
    }
    if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      compileClassGetter(ctx, className, layout, member);
    }
  }
}

/** Compile a class constructor. Receives `this` as first parameter. */
function compileClassCtor(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  ctorDecl: ts.ConstructorDeclaration | undefined,
  classDecl?: ts.ClassDeclaration,
): void {
  const ctorName = layout.ctorFuncName;

  const params: { name: string; type: ValType }[] = [{ name: "this", type: { kind: "i32" } }];

  if (ctorDecl) {
    for (const p of ctorDecl.parameters) {
      const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
      const type = resolveParamTypeFromChecker(ctx, p);
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
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  // Compile field initializers (e.g., `private buf: number[] = []`)
  if (classDecl) {
    for (const member of classDecl.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer && member.name && ts.isIdentifier(member.name)) {
        const fieldName = member.name.text;
        const field = layout.fields.get(fieldName);
        if (field) {
          fctx.body.push({ op: "local.get", index: 0 }); // this
          compileExpression(ctx, fctx, member.initializer);
          const valType = inferExprType(ctx, fctx, member.initializer);
          if (field.type === "i32") {
            if (valType.kind !== "i32") {
              fctx.body.push({ op: "i32.trunc_f64_s" });
            }
            fctx.body.push({ op: "i32.store", align: 2, offset: field.offset });
          } else {
            if (valType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            }
            fctx.body.push({ op: "f64.store", align: 3, offset: field.offset });
          }
        }
      }
    }
  }

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

  const params: { name: string; type: ValType }[] = [{ name: "this", type: { kind: "i32" } }];

  for (const p of methodDecl.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
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
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;
  detectCallbackParams(ctx, fctx, methodDecl.parameters);
  detectParamCollectionTypes(ctx, fctx, methodDecl.parameters);

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

/** Compile a class getter. Receives `this` as first parameter. */
function compileClassGetter(
  ctx: LinearContext,
  _className: string,
  layout: ClassLayout,
  getterDecl: ts.GetAccessorDeclaration,
): void {
  const getterName = (getterDecl.name as ts.Identifier).text;
  const wasmGetterName = layout.getters.get(getterName)!;

  const params: { name: string; type: ValType }[] = [{ name: "this", type: { kind: "i32" } }];

  const returnType = resolveType(ctx, getterDecl.type);
  const isVoid = returnType === null;

  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${wasmGetterName}`,
    params: paramTypes,
    results: resultTypes,
  });

  const fctx: LinearFuncContext = {
    name: wasmGetterName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  ctx.currentFunc = fctx;

  if (getterDecl.body) {
    for (const stmt of getterDecl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  ctx.mod.functions.push({
    name: wasmGetterName,
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
  const providedArgCount = expr.arguments ? expr.arguments.length : 0;
  if (expr.arguments) {
    for (const arg of expr.arguments) {
      compileExpression(ctx, fctx, arg);
    }
  }
  // Fill in default values for missing parameters
  const ctorTypeIdx = ctx.mod.functions.find((f) => f.name === layout.ctorFuncName)?.typeIdx;
  if (ctorTypeIdx !== undefined) {
    const ctorType = ctx.mod.types[ctorTypeIdx];
    if (ctorType && ctorType.kind === "func") {
      const expectedArgCount = ctorType.params.length - 1; // subtract `this`
      for (let i = providedArgCount; i < expectedArgCount; i++) {
        const paramType = ctorType.params[i + 1]; // +1 to skip `this`
        if (paramType.kind === "i32") {
          fctx.body.push({ op: "i32.const", value: 0 });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
      }
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
function inferClassName(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): string | undefined {
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
function compileStringLiteral(ctx: LinearContext, fctx: LinearFuncContext, value: string): void {
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

/** Compile a template expression: `hello ${name}` → __str_concat chain */
function compileTemplateExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.TemplateExpression): void {
  const strConcatIdx = ctx.funcMap.get("__str_concat")!;

  // Start with the head text
  compileStringLiteral(ctx, fctx, expr.head.text);

  for (const span of expr.templateSpans) {
    // Compile the expression in this span
    const spanExprType = inferExprType(ctx, fctx, span.expression);
    if (spanExprType.kind === "i32") {
      // Already a string pointer (i32), just compile
      compileExpression(ctx, fctx, span.expression);
    } else {
      // It's an f64 number — need to convert to string
      // For now, use __str_from_i32 if available, otherwise just truncate and convert
      const strFromI32Idx = ctx.funcMap.get("__str_from_i32");
      if (strFromI32Idx !== undefined) {
        compileExprToI32(ctx, fctx, span.expression);
        fctx.body.push({ op: "call", funcIdx: strFromI32Idx });
      } else {
        // Fallback: compile as empty string (shouldn't normally happen)
        compileStringLiteral(ctx, fctx, "");
      }
    }
    fctx.body.push({ op: "call", funcIdx: strConcatIdx });

    // If this span has trailing text, concat it too
    if (span.literal.text.length > 0) {
      compileStringLiteral(ctx, fctx, span.literal.text);
      fctx.body.push({ op: "call", funcIdx: strConcatIdx });
    }
  }
}

/** Check if an expression is a string type */
function isStringExpr(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): boolean {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) {
    return true;
  }
  // Use TypeChecker for any expression
  try {
    const type = ctx.checker.getTypeAtLocation(expr);
    if (type.flags & ts.TypeFlags.StringLike) {
      return true;
    }
    // Also check non-nullable type for expressions like map.get() that return string | undefined
    const nonNull = ctx.checker.getNonNullableType(type);
    if (nonNull.flags & ts.TypeFlags.StringLike) {
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

// ── Closure / callback support ──────────────────────────────────────────

/** Emit funcref table and element segment if any lambdas were compiled */
/** Collect module-level variable declarations as wasm globals */
function collectModuleGlobals(ctx: LinearContext, sf: ts.SourceFile): void {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    // Skip declare statements
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (ctx.funcMap.has(name)) continue;
      if (ctx.moduleGlobals.has(name)) continue;
      if (ctx.classLayouts.has(name)) continue;

      // Determine the wasm type
      const wasmType = inferDeclType(ctx, decl);

      // Try to extract a constant initializer for immutable globals
      let initInstr: Instr[];
      if (isConst && decl.initializer && ts.isNumericLiteral(decl.initializer)) {
        const val = Number(decl.initializer.text);
        initInstr =
          wasmType.kind === "i32"
            ? [{ op: "i32.const" as const, value: val | 0 }]
            : [{ op: "f64.const" as const, value: val }];
      } else {
        initInstr =
          wasmType.kind === "i32" ? [{ op: "i32.const" as const, value: 0 }] : [{ op: "f64.const" as const, value: 0 }];
      }

      const globalIdx = ctx.mod.globals.length;
      ctx.mod.globals.push({
        name: `__mod_${name}`,
        type: wasmType,
        mutable: !isConst || !decl.initializer || !ts.isNumericLiteral(decl.initializer),
        init: initInstr,
      });
      ctx.moduleGlobals.set(name, globalIdx);

      // Detect collection kind for module-level variables
      if (decl.initializer) {
        if (ts.isNewExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
          const ctorName = decl.initializer.expression.text;
          if (ctorName === "Set") ctx.moduleCollectionTypes.set(name, "Set");
          else if (ctorName === "Map") ctx.moduleCollectionTypes.set(name, "Map");
          else if (ctorName === "Uint8Array") ctx.moduleCollectionTypes.set(name, "Uint8Array");
        } else if (ts.isArrayLiteralExpression(decl.initializer)) {
          ctx.moduleCollectionTypes.set(name, "Array");
        }
      }
      if (decl.type) {
        const text = decl.type.getText();
        if (text.startsWith("Set<") || text === "Set") ctx.moduleCollectionTypes.set(name, "Set");
        else if (text.startsWith("Map<") || text === "Map") ctx.moduleCollectionTypes.set(name, "Map");
        else if (text === "Uint8Array") ctx.moduleCollectionTypes.set(name, "Uint8Array");
        else if (text.endsWith("[]") || text.startsWith("Array<")) ctx.moduleCollectionTypes.set(name, "Array");
      }
    }
  }
}

/** Infer the wasm type for a variable declaration */
function inferDeclType(ctx: LinearContext, decl: ts.VariableDeclaration): ValType {
  if (decl.initializer) {
    // For new expressions of known object types, use i32
    if (ts.isNewExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression)) {
      return { kind: "i32" };
    }
  }
  // Use TypeChecker
  try {
    const type = ctx.checker.getTypeAtLocation(decl);
    const baseType = ctx.checker.getNonNullableType(type);
    // Check type flags for number-like types (includes literal types like `1`, `2`, etc.)
    if (baseType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return { kind: "f64" };
    // Everything else (strings, objects, arrays, classes, etc.) is i32 pointers
    return { kind: "i32" };
  } catch {
    /* fall through */
  }
  return { kind: "f64" };
}

/** Rebuild funcMap from actual function positions and patch all call/ref.func indices */
function fixupFuncIndices(ctx: LinearContext): void {
  // Build old→new index mapping
  const oldToNew = new Map<number, number>();
  const newFuncMap = new Map<string, number>();

  for (let i = 0; i < ctx.mod.functions.length; i++) {
    const fn = ctx.mod.functions[i];
    const newIdx = ctx.numImportFuncs + i;
    const oldIdx = ctx.funcMap.get(fn.name);
    if (oldIdx !== undefined && oldIdx !== newIdx) {
      oldToNew.set(oldIdx, newIdx);
    }
    newFuncMap.set(fn.name, newIdx);
  }

  if (oldToNew.size === 0) return; // No fixups needed

  // Update funcMap
  ctx.funcMap = newFuncMap;

  // Note: tableEntries are NOT remapped here because they store the correct
  // final position in mod.functions (set right before push in compileArrowFunctionArg).
  // The oldToNew map may contain colliding indices from non-lambda functions
  // that were registered in funcMap before lambdas shifted their positions.

  // Patch all call and ref.func instructions in all function bodies
  function patchInstrs(instrs: Instr[]): void {
    for (const instr of instrs) {
      if (instr.op === "call") {
        const mapped = oldToNew.get(instr.funcIdx);
        if (mapped !== undefined) instr.funcIdx = mapped;
      } else if (instr.op === "ref.func") {
        const mapped = oldToNew.get(instr.funcIdx);
        if (mapped !== undefined) instr.funcIdx = mapped;
      } else if (instr.op === "block" || instr.op === "loop") {
        patchInstrs(instr.body);
      } else if (instr.op === "if") {
        patchInstrs(instr.then);
        if (instr.else) patchInstrs(instr.else);
      } else if (instr.op === "try") {
        patchInstrs(instr.body);
        for (const c of instr.catches) patchInstrs(c.body);
        if (instr.catchAll) patchInstrs(instr.catchAll);
      }
    }
  }

  for (const fn of ctx.mod.functions) {
    patchInstrs(fn.body);
  }

  // Fix up export indices
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func") {
      const mapped = oldToNew.get(exp.desc.index);
      if (mapped !== undefined) exp.desc.index = mapped;
    }
  }
}

function emitClosureTable(ctx: LinearContext): void {
  if (ctx.tableEntries.length === 0) return;
  // Add a funcref table large enough for all lambdas
  ctx.mod.tables.push({
    elementType: "funcref",
    min: ctx.tableEntries.length,
    max: ctx.tableEntries.length,
  });
  // Add element segment to populate the table at offset 0
  ctx.mod.elements.push({
    tableIdx: 0,
    offset: [{ op: "i32.const", value: 0 }],
    funcIndices: ctx.tableEntries,
  });
}

/**
 * Detect collection-typed parameters (arrays, Uint8Array, Map, Set)
 * and register them in fctx.collectionTypes.
 */
function detectParamCollectionTypes(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
): void {
  for (const param of params) {
    if (!ts.isIdentifier(param.name)) continue;
    const paramName = param.name.text;
    // Check explicit type annotation
    if (param.type) {
      const text = param.type.getText();
      if (text === "number[] | Uint8Array" || text === "Uint8Array | number[]") {
        fctx.collectionTypes.set(paramName, "ArrayOrUint8Array");
        continue;
      }
      if (text === "number[]" || text.endsWith("[]") || text.startsWith("Array<")) {
        fctx.collectionTypes.set(paramName, "Array");
        continue;
      }
      if (text === "Uint8Array") {
        fctx.collectionTypes.set(paramName, "Uint8Array");
        continue;
      }
      if (text.startsWith("Map<") || text === "Map") {
        fctx.collectionTypes.set(paramName, "Map");
        continue;
      }
      if (text.startsWith("Set<") || text === "Set") {
        fctx.collectionTypes.set(paramName, "Set");
        continue;
      }
    }
    // TypeChecker fallback
    try {
      const type = ctx.checker.getTypeAtLocation(param);
      const typeStr = ctx.checker.typeToString(type);
      if (typeStr === "number[] | Uint8Array" || typeStr === "Uint8Array | number[]") {
        fctx.collectionTypes.set(paramName, "ArrayOrUint8Array");
        continue;
      }
      if (typeStr === "Uint8Array") {
        fctx.collectionTypes.set(paramName, "Uint8Array");
        continue;
      }
      if (typeStr.startsWith("Map<")) {
        fctx.collectionTypes.set(paramName, "Map");
        continue;
      }
      if (typeStr.startsWith("Set<")) {
        fctx.collectionTypes.set(paramName, "Set");
        continue;
      }
      if (typeStr.endsWith("[]") || typeStr.startsWith("Array<")) {
        fctx.collectionTypes.set(paramName, "Array");
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Detect function-typed parameters and register them as callback params.
 * Called during function compilation setup.
 */
function detectCallbackParams(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
): void {
  for (const param of params) {
    if (!param.type || !ts.isIdentifier(param.name)) continue;
    // Check if the type is a function type: (x: T) => R
    if (ts.isFunctionTypeNode(param.type)) {
      const paramName = param.name.text;
      // Build the call_indirect type signature from the function type
      const cbParams: ValType[] = [];
      for (const p of param.type.parameters) {
        cbParams.push(resolveParamTypeFromChecker(ctx, p));
      }
      const cbReturn = resolveType(ctx, param.type.type);
      const cbResults: ValType[] = cbReturn ? [cbReturn] : [];

      // Find or create a type index for this callback signature
      let typeIdx = -1;
      for (let ti = 0; ti < ctx.mod.types.length; ti++) {
        const t = ctx.mod.types[ti]!;
        if (t.kind !== "func") continue;
        if (
          t.params.length === cbParams.length &&
          t.results.length === cbResults.length &&
          t.params.every((p: ValType, j: number) => p.kind === cbParams[j]!.kind) &&
          t.results.every((r: ValType, j: number) => r.kind === cbResults[j]!.kind)
        ) {
          typeIdx = ti;
          break;
        }
      }
      if (typeIdx < 0) {
        typeIdx = ctx.mod.types.length;
        ctx.mod.types.push({
          kind: "func",
          name: `$cb_type_${paramName}`,
          params: cbParams,
          results: cbResults,
        });
      }
      fctx.callbackParams.set(paramName, typeIdx);
    }
  }
}

/**
 * Compile an arrow function expression as a separate Wasm function.
 * Returns the table index for the compiled function.
 *
 * Captures from the enclosing scope are passed via the __closure_env global.
 * The lambda reads them at function entry and stores in locals.
 */
function compileArrowFunctionArg(
  ctx: LinearContext,
  outerFctx: LinearFuncContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): number {
  const lambdaName = `$lambda_${ctx.lambdaCounter++}`;

  // Detect captured variables by scanning the arrow body for identifiers
  // that reference the outer scope (locals, params, or 'this')
  const captures: { name: string; outerIdx: number; type: ValType }[] = [];
  const capturedNames = new Set<string>();

  function scanCaptures(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (capturedNames.has(name)) return;
      // Check if this identifier is from the outer scope (not an arrow param)
      const isArrowParam = arrow.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (!isArrowParam) {
        const outerIdx = outerFctx.localMap.get(name);
        if (outerIdx !== undefined) {
          capturedNames.add(name);
          const outerType =
            outerIdx < outerFctx.params.length
              ? outerFctx.params[outerIdx].type
              : (outerFctx.locals[outerIdx - outerFctx.params.length]?.type ?? { kind: "f64" as const });
          captures.push({ name, outerIdx, type: outerType });
        }
      }
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (!capturedNames.has("this")) {
        const outerIdx = outerFctx.localMap.get("this");
        if (outerIdx !== undefined) {
          capturedNames.add("this");
          captures.push({ name: "this", outerIdx, type: { kind: "i32" } });
        }
      }
    }
    ts.forEachChild(node, scanCaptures);
  }
  if (arrow.body) scanCaptures(arrow.body);

  // Build parameter list for the lambda function
  const params: { name: string; type: ValType }[] = [];
  for (const p of arrow.parameters) {
    const paramName = ts.isIdentifier(p.name) ? p.name.text : "_";
    const type = resolveParamTypeFromChecker(ctx, p);
    params.push({ name: paramName, type });
  }

  // Determine return type
  const returnType = arrow.type ? resolveType(ctx, arrow.type) : null;
  const isVoid = returnType === null;
  const paramTypes = params.map((p) => p.type);
  const resultTypes: ValType[] = isVoid ? [] : [returnType];

  // Create type and function context — reuse existing type if structurally identical
  // (required for call_indirect type checking in WebAssembly)
  let typeIdx = -1;
  for (let ti = 0; ti < ctx.mod.types.length; ti++) {
    const t = ctx.mod.types[ti]!;
    if (t.kind !== "func") continue;
    if (
      t.params.length === paramTypes.length &&
      t.results.length === resultTypes.length &&
      t.params.every((p: ValType, j: number) => p.kind === paramTypes[j]!.kind) &&
      t.results.every((r: ValType, j: number) => r.kind === resultTypes[j]!.kind)
    ) {
      typeIdx = ti;
      break;
    }
  }
  if (typeIdx < 0) {
    typeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      name: `$type_${lambdaName}`,
      params: paramTypes,
      results: resultTypes,
    });
  }

  const fctx: LinearFuncContext = {
    name: lambdaName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoid ? null : returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    collectionTypes: new Map(),
    callbackParams: new Map(),
  };

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i].name, i);
  }

  // Add locals for captured variables and load them from __closure_env
  if (captures.length > 0) {
    // Read env pointer from global at function entry
    const envLocal = addLocal(fctx, "$env", { kind: "i32" });
    fctx.body.push({ op: "global.get", index: ctx.closureEnvGlobalIdx });
    fctx.body.push({ op: "local.set", index: envLocal });

    // Load each captured variable from the env struct
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i];
      const capLocal = addLocal(fctx, cap.name, cap.type);
      fctx.body.push({ op: "local.get", index: envLocal });
      if (cap.type.kind === "f64") {
        fctx.body.push({ op: "f64.load", align: 3, offset: i * 8 });
      } else {
        fctx.body.push({ op: "i32.load", align: 2, offset: i * 8 });
      }
      fctx.body.push({ op: "local.set", index: capLocal });
      // Copy collection types from outer scope
      const outerCollKind = outerFctx.collectionTypes.get(cap.name);
      if (outerCollKind) {
        fctx.collectionTypes.set(cap.name, outerCollKind);
      }
    }
  }

  // Compile the arrow body
  ctx.currentFunc = fctx;
  if (ts.isBlock(arrow.body)) {
    for (const stmt of arrow.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  } else {
    // Expression body: () => expr
    compileExpression(ctx, fctx, arrow.body);
  }

  if (!isVoid) {
    fctx.body.push({ op: "unreachable" });
  }

  // Register the function
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(lambdaName, funcIdx);
  ctx.mod.functions.push({
    name: lambdaName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });

  // Add to table and return table index
  const tableIdx = ctx.tableEntries.length;
  ctx.tableEntries.push(funcIdx);

  // Restore outer context
  ctx.currentFunc = outerFctx;

  return tableIdx;
}

/**
 * Emit code to set up __closure_env and push the table index for an arrow
 * function argument. Used at call sites where an arrow function is passed.
 */
function emitClosureSetup(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): void {
  const tableIdx = compileArrowFunctionArg(ctx, fctx, arrow);

  // Detect captures to set up env
  const captures: { name: string; outerIdx: number; type: ValType }[] = [];
  const capturedNames = new Set<string>();

  function scanCaptures(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (capturedNames.has(name)) return;
      const isArrowParam = arrow.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (!isArrowParam) {
        const outerIdx = fctx.localMap.get(name);
        if (outerIdx !== undefined) {
          capturedNames.add(name);
          const outerType =
            outerIdx < fctx.params.length
              ? fctx.params[outerIdx].type
              : (fctx.locals[outerIdx - fctx.params.length]?.type ?? { kind: "f64" as const });
          captures.push({ name, outerIdx, type: outerType });
        }
      }
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
      if (!capturedNames.has("this")) {
        const outerIdx = fctx.localMap.get("this");
        if (outerIdx !== undefined) {
          capturedNames.add("this");
          captures.push({ name: "this", outerIdx, type: { kind: "i32" } });
        }
      }
    }
    ts.forEachChild(node, scanCaptures);
  }
  if (arrow.body) scanCaptures(arrow.body);

  if (captures.length > 0) {
    // Allocate env struct and store captured values
    // Use uniform 8-byte slots for simplicity (f64 needs 8, i32 needs 4 but we align to 8)
    const envSize = captures.length * 8;
    const envLocal = addLocal(fctx, `$env_${ctx.lambdaCounter}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: envSize });
    const mallocIdx = ctx.funcMap.get("__malloc")!;
    fctx.body.push({ op: "call", funcIdx: mallocIdx });
    fctx.body.push({ op: "local.set", index: envLocal });

    // Store each captured variable
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i];
      fctx.body.push({ op: "local.get", index: envLocal });
      fctx.body.push({ op: "local.get", index: cap.outerIdx });
      if (cap.type.kind === "f64") {
        fctx.body.push({ op: "f64.store", align: 3, offset: i * 8 });
      } else {
        fctx.body.push({ op: "i32.store", align: 2, offset: i * 8 });
      }
    }

    // Set __closure_env global
    fctx.body.push({ op: "local.get", index: envLocal });
    fctx.body.push({ op: "global.set", index: ctx.closureEnvGlobalIdx });
  }

  // Push the table index as the i32 argument value
  fctx.body.push({ op: "i32.const", value: tableIdx });
}
