// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Integration point between the legacy codegen pipeline and the IR path.
//
// `compileIrPathFunctions` runs after `compileDeclarations`. For each
// function in the IR selection it:
//
//   1. Lowers the AST to middle-end IR (`lowerFunctionAstToIr`).
//   2. Verifies the IR (`verifyIrFunction`).
//   3. Lowers the IR to a WasmFunction (`lowerIrFunctionToWasm`) using
//      symbolic-ref resolvers backed by the live codegen context.
//   4. Replaces the corresponding entry in `ctx.mod.functions` — keeping
//      the already-allocated funcIdx/typeIdx/export state intact so the
//      legacy late-repair passes see a consistent module.
//
// Because the IR lowerer resolves IrFuncRef/IrGlobalRef symbols at this
// integration point (AFTER all imports have been registered), the legacy
// `shiftLateImportIndices` pass is a no-op for every body produced here.
// That's the whole point of the symbolic-ref design — spec #1131 §1.2.

import ts from "typescript";

import { addFuncType } from "../codegen/registry/types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { lowerFunctionAstToIr } from "./from-ast.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "./lower.js";
import type { IrFuncRef, IrGlobalRef, IrTypeRef } from "./nodes.js";
import { planIrCompilation, type IrSelection } from "./select.js";
import { verifyIrFunction } from "./verify.js";
import type { FuncTypeDef } from "./types.js";

export interface IrIntegrationReport {
  readonly compiled: readonly string[];
  readonly errors: readonly { func: string; message: string }[];
}

export function compileIrPathFunctions(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  selection?: IrSelection,
): IrIntegrationReport {
  const selected = selection ?? planIrCompilation(sourceFile, { experimentalIR: true });
  if (selected.funcs.size === 0) {
    return { compiled: [], errors: [] };
  }

  const compiled: string[] = [];
  const errors: { func: string; message: string }[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    const name = stmt.name.text;
    if (!selected.funcs.has(name)) continue;

    try {
      const ir = lowerFunctionAstToIr(stmt, { exported: hasExportModifier(stmt) });
      const verifyErrors = verifyIrFunction(ir);
      if (verifyErrors.length > 0) {
        for (const e of verifyErrors) errors.push({ func: name, message: e.message });
        continue;
      }

      const funcIdx = ctx.funcMap.get(name);
      if (funcIdx === undefined) {
        errors.push({ func: name, message: `no funcIdx allocated for ${name}` });
        continue;
      }
      const localIdx = funcIdx - ctx.numImportFuncs;
      if (localIdx < 0 || localIdx >= ctx.mod.functions.length) {
        errors.push({ func: name, message: `funcIdx ${funcIdx} out of local range for ${name}` });
        continue;
      }

      const resolver = makeResolver(ctx);
      const { func: wasmFunc } = lowerIrFunctionToWasm(ir, resolver);

      const existing = ctx.mod.functions[localIdx];
      ctx.mod.functions[localIdx] = {
        name: existing.name,
        typeIdx: wasmFunc.typeIdx,
        locals: wasmFunc.locals,
        body: wasmFunc.body,
        exported: existing.exported,
      };
      compiled.push(name);
    } catch (e) {
      errors.push({ func: name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { compiled, errors };
}

function hasExportModifier(fn: ts.FunctionDeclaration): boolean {
  return !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function makeResolver(ctx: CodegenContext): IrLowerResolver {
  return {
    resolveFunc(ref: IrFuncRef): number {
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) throw new Error(`ir/integration: unknown function ref "${ref.name}"`);
      return idx;
    },
    resolveGlobal(ref: IrGlobalRef): number {
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === ref.name);
      if (localIdx < 0) throw new Error(`ir/integration: unknown global ref "${ref.name}"`);
      return ctx.numImportGlobals + localIdx;
    },
    resolveType(ref: IrTypeRef): number {
      const idx = ctx.mod.types.findIndex((t) => "name" in t && (t as { name?: string }).name === ref.name);
      if (idx < 0) throw new Error(`ir/integration: unknown type ref "${ref.name}"`);
      return idx;
    },
    internFuncType(type: FuncTypeDef): number {
      return addFuncType(ctx, type.params, type.results, type.name);
    },
  };
}
