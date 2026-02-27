import ts from "typescript";
import type { TypedAST } from "../checker/index.js";
import {
  mapTsTypeToWasm,
  isVoidType,
  isNumberType,
  isBooleanType,
} from "../checker/type-mapper.js";
import type {
  WasmModule,
  WasmFunction,
  TypeDef,
  FuncTypeDef,
  StructTypeDef,
  ValType,
  Instr,
  LocalDef,
  Import,
  WasmExport,
  FieldDef,
} from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { compileExpression } from "./expressions.js";
import { compileStatement } from "./statements.js";

/** Context shared across all codegen */
export interface CodegenContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  /** Map from function name to its absolute index (imports + locals) */
  funcMap: Map<string, number>;
  /** Map from struct/interface name to type index */
  structMap: Map<string, number>;
  /** Map from struct name to field info */
  structFields: Map<string, FieldDef[]>;
  /** Number of imported functions */
  numImportFuncs: number;
  /** Current function context (set during function compilation) */
  currentFunc: FunctionContext | null;
  /** Errors accumulated during codegen */
  errors: { message: string; line: number; column: number }[];
}

/** Per-function context */
export interface FunctionContext {
  /** Function name */
  name: string;
  /** Parameters (these are the first N locals) */
  params: { name: string; type: ValType }[];
  /** Additional locals declared in the body */
  locals: LocalDef[];
  /** All local names → index (params first, then locals) */
  localMap: Map<string, number>;
  /** Return type */
  returnType: ValType | null; // null = void
  /** Accumulated body instructions */
  body: Instr[];
  /** Block depth for br labels */
  blockDepth: number;
  /** Break label depth stack */
  breakStack: number[];
  /** Continue label depth stack */
  continueStack: number[];
}

/** Compile a typed AST into a WasmModule IR */
export function generateModule(ast: TypedAST): WasmModule {
  const mod = createEmptyModule();

  const ctx: CodegenContext = {
    mod,
    checker: ast.checker,
    funcMap: new Map(),
    structMap: new Map(),
    structFields: new Map(),
    numImportFuncs: 0,
    currentFunc: null,
    errors: [],
  };

  // Add standard imports
  addStandardImports(ctx);

  // First pass: collect all function declarations and interfaces
  collectDeclarations(ctx, ast.sourceFile);

  // Second pass: compile function bodies
  compileDeclarations(ctx, ast.sourceFile);

  return mod;
}

function addStandardImports(ctx: CodegenContext): void {
  // console_log_number: (f64) -> void
  const logNumTypeIdx = addFuncType(ctx, [{ kind: "f64" }], []);
  addImport(ctx, "env", "console_log_number", {
    kind: "func",
    typeIdx: logNumTypeIdx,
  });

  // console_log_bool: (i32) -> void
  const logBoolTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  addImport(ctx, "env", "console_log_bool", {
    kind: "func",
    typeIdx: logBoolTypeIdx,
  });
}

function addImport(
  ctx: CodegenContext,
  module: string,
  name: string,
  desc: Import["desc"],
): void {
  ctx.mod.imports.push({ module, name, desc });
  if (desc.kind === "func") {
    ctx.funcMap.set(name, ctx.numImportFuncs);
    ctx.numImportFuncs++;
  }
}

export function addFuncType(
  ctx: CodegenContext,
  params: ValType[],
  results: ValType[],
  name?: string,
): number {
  // Check if an equivalent type already exists
  for (let i = 0; i < ctx.mod.types.length; i++) {
    const t = ctx.mod.types[i]!;
    if (t.kind === "func" && funcTypeEq(t, params, results)) {
      return i;
    }
  }
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: name ?? `type${idx}`,
    params,
    results,
  });
  return idx;
}

function funcTypeEq(
  t: FuncTypeDef,
  params: ValType[],
  results: ValType[],
): boolean {
  if (t.params.length !== params.length) return false;
  if (t.results.length !== results.length) return false;
  for (let i = 0; i < params.length; i++) {
    if (!valTypeEq(t.params[i]!, params[i]!)) return false;
  }
  for (let i = 0; i < results.length; i++) {
    if (!valTypeEq(t.results[i]!, results[i]!)) return false;
  }
  return true;
}

function valTypeEq(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if (
    (a.kind === "ref" || a.kind === "ref_null") &&
    (b.kind === "ref" || b.kind === "ref_null")
  ) {
    return a.typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

/** First pass: register all declarations */
function collectDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const sig = ctx.checker.getSignatureFromDeclaration(stmt);
      if (!sig) continue;

      const params: ValType[] = [];
      for (const param of stmt.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        params.push(mapTsTypeToWasm(paramType, ctx.checker));
      }

      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const results: ValType[] = isVoidType(retType)
        ? []
        : [mapTsTypeToWasm(retType, ctx.checker)];

      const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
      const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(name, funcIdx);

      // Create placeholder function to be filled in second pass
      const isExported = hasExportModifier(stmt);
      const func: WasmFunction = {
        name,
        typeIdx,
        locals: [],
        body: [],
        exported: isExported,
      };
      ctx.mod.functions.push(func);

      if (isExported) {
        ctx.mod.exports.push({
          name,
          desc: { kind: "func", index: funcIdx },
        });
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      collectInterface(ctx, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      // Handle type aliases that resolve to object types
      const aliasType = ctx.checker.getTypeAtLocation(stmt);
      if (aliasType.flags & ts.TypeFlags.Object) {
        collectObjectType(ctx, stmt.name.text, aliasType);
      }
    }
  }
}

function collectInterface(
  ctx: CodegenContext,
  decl: ts.InterfaceDeclaration,
): void {
  const name = decl.name.text;
  const fields: FieldDef[] = [];

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const memberName = (member.name as ts.Identifier).text;
      const memberType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(memberType, ctx.checker);
      fields.push({
        name: memberName,
        type: wasmType,
        mutable: true,
      });
    }
  }

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(name, typeIdx);
  ctx.structFields.set(name, fields);
}

function collectObjectType(
  ctx: CodegenContext,
  name: string,
  type: ts.Type,
): void {
  const fields: FieldDef[] = [];
  for (const prop of type.getProperties()) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapTsTypeToWasm(propType, ctx.checker);
    fields.push({
      name: prop.name,
      type: wasmType,
      mutable: true,
    });
  }

  if (fields.length > 0) {
    const typeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name,
      fields,
    } as StructTypeDef);
    ctx.structMap.set(name, typeIdx);
    ctx.structFields.set(name, fields);
  }
}

/** Second pass: compile all function bodies */
function compileDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): void {
  let funcIdx = 0;
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const func = ctx.mod.functions[funcIdx]!;
      compileFunctionBody(ctx, stmt, func);
      funcIdx++;
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      funcIdx++;
    }
  }
}

function compileFunctionBody(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  func: WasmFunction,
): void {
  const sig = ctx.checker.getSignatureFromDeclaration(decl)!;
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  const params: { name: string; type: ValType }[] = [];
  for (const param of decl.parameters) {
    const paramName = (param.name as ts.Identifier).text;
    const paramType = ctx.checker.getTypeAtLocation(param);
    params.push({ name: paramName, type: mapTsTypeToWasm(paramType, ctx.checker) });
  }

  const fctx: FunctionContext = {
    name: func.name,
    params,
    locals: [],
    localMap: new Map(),
    returnType: isVoidType(retType) ? null : mapTsTypeToWasm(retType, ctx.checker),
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
  };

  // Register params as locals
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }

  ctx.currentFunc = fctx;

  // Compile body statements
  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  // Ensure there's always a valid return value at the end for non-void functions
  if (fctx.returnType) {
    // Check if the last instruction is already a return
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      // Add a default return value
      if (fctx.returnType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (fctx.returnType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      }
    }
  }

  func.locals = fctx.locals;
  func.body = fctx.body;

  ctx.currentFunc = null;
}

/** Allocate a new local in the current function */
export function allocLocal(
  fctx: FunctionContext,
  name: string,
  type: ValType,
): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, index);
  return index;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export { compileExpression } from "./expressions.js";
export { compileStatement } from "./statements.js";
