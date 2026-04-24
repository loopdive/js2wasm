// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Integration point between the legacy codegen pipeline and the IR path.
//
// `compileIrPathFunctions` runs after `compileDeclarations`. It now runs in
// three explicit phases — driven by spec #1167b, which added module-scope
// inlining that requires seeing every IR function at once before any of
// them lower to Wasm:
//
//   1. Build — lower every selected AST function to an `IrFunction` and
//      collect them into an `IrModule`.
//   2. Pass — run per-function hygiene (CF → DCE → simplifyCFG), then
//      module-scope inlining (`inlineSmall`), then re-run hygiene on any
//      modified function. Each stage verifies.
//   3. Lower — replace each selected function's entry in `ctx.mod.functions`
//      with the Wasm body produced by `lowerIrFunctionToWasm`, keeping the
//      pre-allocated funcIdx/typeIdx/export state intact so the legacy
//      late-repair passes see a consistent module.
//
// Because the IR lowerer resolves IrFuncRef/IrGlobalRef symbols at this
// integration point (AFTER all imports have been registered), the legacy
// `shiftLateImportIndices` pass is a no-op for every body produced here.
// That's the whole point of the symbolic-ref design — spec #1131 §1.2.

import ts from "typescript";

import { addFuncType } from "../codegen/registry/types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { lowerFunctionAstToIr } from "./from-ast.js";
import { lowerIrFunctionToWasm, type IrLowerResolver, type IrUnionLowering } from "./lower.js";
import type { IrFuncRef, IrFunction, IrGlobalRef, IrModule, IrType, IrTypeRef } from "./nodes.js";
import { constantFold } from "./passes/constant-fold.js";
import { deadCode } from "./passes/dead-code.js";
import { inlineSmall } from "./passes/inline-small.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import { UnionStructRegistry } from "./passes/tagged-union-types.js";
import { planIrCompilation, type IrSelection } from "./select.js";
import { verifyIrFunction } from "./verify.js";
import type { FuncTypeDef, StructTypeDef, ValType } from "./types.js";

export interface IrIntegrationReport {
  readonly compiled: readonly string[];
  readonly errors: readonly { func: string; message: string }[];
}

/**
 * Per-function IR type overrides sourced from the Phase-2 propagation
 * pass. Indexed by function name. When present for a selected function,
 * these types are used in place of (or alongside) any explicit TS
 * annotations. They are also used to derive the `calleeTypes` map that
 * the AST→IR lowerer consults when lowering `CallExpression`.
 */
export interface IrTypeOverrideMap {
  get(name: string): { readonly params: readonly IrType[]; readonly returnType: IrType } | undefined;
}

export function compileIrPathFunctions(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  selection?: IrSelection,
  overrides?: IrTypeOverrideMap,
): IrIntegrationReport {
  const selected = selection ?? planIrCompilation(sourceFile, { experimentalIR: true });
  if (selected.funcs.size === 0) {
    return { compiled: [], errors: [] };
  }

  // Build the calleeTypes map once — every IR-path function's lowerer
  // sees the same view, keyed by every selected function's propagated
  // signature. This is how cross-function calls keep their signatures
  // consistent on the IR side.
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType }>();
  if (overrides) {
    for (const name of selected.funcs) {
      const o = overrides.get(name);
      if (o) calleeTypes.set(name, { params: o.params, returnType: o.returnType });
    }
  }

  const compiled: string[] = [];
  const errors: { func: string; message: string }[] = [];

  // Single shared union-struct registry across all IR-path functions in this
  // compilation. Registering a union once produces one WasmGC struct type;
  // subsequent `box`/`unbox`/`tag.test` uses from any function see the same
  // type index. The sink writes into `ctx.mod.types` directly so the
  // registered struct participates in the module's usual type emission.
  const unionRegistry = new UnionStructRegistry({
    push(def: StructTypeDef): number {
      const idx = ctx.mod.types.length;
      ctx.mod.types.push(def);
      return idx;
    },
  });

  // -------------------------------------------------------------------------
  // Phase 1 — Build: lower every selected AST function to an IrFunction.
  // -------------------------------------------------------------------------
  interface BuiltFn {
    readonly name: string;
    readonly fn: IrFunction;
  }
  const built: BuiltFn[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    const name = stmt.name.text;
    if (!selected.funcs.has(name)) continue;

    try {
      const o = overrides?.get(name);
      const ir = lowerFunctionAstToIr(stmt, {
        exported: hasExportModifier(stmt),
        paramTypeOverrides: o?.params,
        returnTypeOverride: o?.returnType,
        calleeTypes,
      });
      const verifyErrors = verifyIrFunction(ir);
      if (verifyErrors.length > 0) {
        for (const e of verifyErrors) errors.push({ func: name, message: e.message });
        continue;
      }
      built.push({ name, fn: ir });
    } catch (e) {
      errors.push({ func: name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (built.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // Phase 2 — Pass: per-function hygiene → module-scope inline → re-run
  // hygiene on modified functions. Verify between stages.
  // -------------------------------------------------------------------------

  // 2a. Per-function hygiene (CF → DCE → simplifyCFG to fixpoint).
  const afterHygiene: BuiltFn[] = [];
  for (const entry of built) {
    const optimized = runHygienePasses(entry.fn);
    const postErrors = verifyIrFunction(optimized);
    if (postErrors.length > 0) {
      for (const e of postErrors) {
        errors.push({ func: entry.name, message: `post-hygiene verify: ${e.message}` });
      }
      continue;
    }
    afterHygiene.push({ name: entry.name, fn: optimized });
  }

  if (afterHygiene.length === 0) return { compiled, errors };

  // 2b. Module-scope inlining (#1167b).
  const modIn: IrModule = { functions: afterHygiene.map((e) => e.fn) };
  const modOut = inlineSmall(modIn);

  // 2c. Re-run hygiene on functions the inline pass actually rewrote; verify.
  const readyForLower: BuiltFn[] = [];
  for (let i = 0; i < afterHygiene.length; i++) {
    const before = afterHygiene[i]!;
    const after = modOut.functions[i]!;
    const changed = after !== before.fn;
    const final = changed ? runHygienePasses(after) : after;
    const verifyErrors = verifyIrFunction(final);
    if (verifyErrors.length > 0) {
      for (const e of verifyErrors) {
        errors.push({ func: before.name, message: `post-inline verify: ${e.message}` });
      }
      continue;
    }
    readyForLower.push({ name: before.name, fn: final });
  }

  if (readyForLower.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // Phase 3 — Lower: translate each IrFunction to Wasm and install in ctx.
  // -------------------------------------------------------------------------
  const resolver = makeResolver(ctx, unionRegistry);
  for (const entry of readyForLower) {
    const name = entry.name;
    try {
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

      const { func: wasmFunc } = lowerIrFunctionToWasm(entry.fn, resolver);

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

/**
 * Run the Phase 3a IR hygiene pipeline to fixpoint.
 *
 * Pipeline order (spec #1167a):
 *   constantFold → deadCode → simplifyCFG
 *
 * Each pass returns the same IrFunction reference when it makes no
 * changes, so reference equality is a reliable "unchanged" signal. The
 * loop iterates until a full pass round is a no-op. An iteration cap
 * guards against pathological non-convergence — with the V1 passes each
 * loop strictly removes instructions or blocks, so real code converges
 * in a handful of rounds.
 */
function runHygienePasses(fn: IrFunction): IrFunction {
  const MAX_ITERS = 10;
  let cur = fn;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const afterCF = constantFold(cur);
    const afterDCE = deadCode(afterCF);
    const afterCFG = simplifyCFG(afterDCE);
    if (afterCFG === cur) return cur;
    cur = afterCFG;
  }
  return cur;
}

function makeResolver(ctx: CodegenContext, unionRegistry: UnionStructRegistry): IrLowerResolver {
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
    resolveUnion(members: readonly ValType[]): IrUnionLowering | null {
      return unionRegistry.resolve(members);
    },
  };
}
