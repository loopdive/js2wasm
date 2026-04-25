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

import { addStringImports } from "../codegen/index.js";
import { addStringConstantGlobal } from "../codegen/registry/imports.js";
import { addFuncType } from "../codegen/registry/types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { lowerFunctionAstToIr } from "./from-ast.js";
import { lowerIrFunctionToWasm, type IrLowerResolver, type IrUnionLowering } from "./lower.js";
import type { IrFuncRef, IrFunction, IrGlobalRef, IrInstr, IrModule, IrType, IrTypeRef } from "./nodes.js";
import { constantFold } from "./passes/constant-fold.js";
import { deadCode } from "./passes/dead-code.js";
import { inlineSmall } from "./passes/inline-small.js";
import { monomorphize } from "./passes/monomorphize.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import { UnionStructRegistry } from "./passes/tagged-union-types.js";
import { taggedUnions } from "./passes/tagged-unions.js";
import { planIrCompilation, type IrSelection } from "./select.js";
import { verifyIrFunction } from "./verify.js";
import type { FuncTypeDef, Instr, StructTypeDef, ValType } from "./types.js";

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
  // Targeted typeIdx-mismatch guard (#1169a follow-up).
  //
  // If a function A in `selected.funcs` failed Phase 1, A keeps its legacy
  // body — but the legacy body still issues `call`s against any callee B
  // it references. If B succeeded Phase 1 and reaches Phase 3, B's typeIdx
  // gets replaced with the IR signature → A's legacy `call B` op fails
  // Wasm validation ("not enough arguments on the stack").
  //
  // Walk each failed function's AST once, collect the names of its
  // direct local callees that are also in `selected.funcs`. In Phase 3
  // below, those callees are skipped — their slots keep their legacy
  // body / legacy typeIdx so A's call op stays well-typed. Non-failed
  // peers without a failed caller commit through IR as usual.
  //
  // Surgical scope: Phase-1 failures only. Phase-2/Phase-3 failures
  // (post-hygiene / post-mono / lowering throws) follow the same pattern
  // but are rarer; expand here if CI shows they matter.
  // -------------------------------------------------------------------------
  const builtNames = new Set(built.map((b) => b.name));
  const skipPhase3CommitFor = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    const failedName = stmt.name.text;
    if (!selected.funcs.has(failedName)) continue;
    if (builtNames.has(failedName)) continue; // not a Phase 1 failure
    if (!stmt.body) continue;
    const visit = (node: ts.Node): void => {
      if (node !== stmt && isFunctionLikeNodeForCallScan(node)) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (selected.funcs.has(callee)) skipPhase3CommitFor.add(callee);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(stmt.body, visit);
  }

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
  const afterInline: BuiltFn[] = [];
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
    afterInline.push({ name: before.name, fn: final });
  }

  if (afterInline.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // 2d. Monomorphize — specialize polymorphic callees across the module.
  // -------------------------------------------------------------------------
  // Clones live only in the IR — they have no ts.FunctionDeclaration and no
  // pre-allocated funcIdx from `compileDeclarations`. After monomorphize
  // produces clones, we allocate each a placeholder WasmFunction slot in
  // `ctx.mod.functions` and register it in `ctx.funcMap` so the Phase-3
  // lowerer's resolver can map the clone's `IrFuncRef` to a concrete index.
  // -------------------------------------------------------------------------
  const monoIn: IrModule = { functions: afterInline.map((e) => e.fn) };
  const monoResult = monomorphize(monoIn);
  const originalNames = new Set<string>(afterInline.map((e) => e.name));

  // -------------------------------------------------------------------------
  // 2e. Tagged-union representation pass (identity in V1 — see
  // `passes/tagged-unions.ts` for the scope note). Structurally wired so
  // follow-up extension work lands in a purpose-built module.
  // -------------------------------------------------------------------------
  const modAfterTU = taggedUnions(monoResult.module);

  // -------------------------------------------------------------------------
  // 2f. Re-run hygiene on any function whose reference changed across the
  // mono + TU stages. Clones are fresh and well-formed; callers whose
  // call targets were rewritten may benefit from a second hygiene pass
  // (usually a no-op but cheap).
  // -------------------------------------------------------------------------
  const readyForLower: BuiltFn[] = [];
  const afterInlineByName = new Map<string, IrFunction>();
  for (const e of afterInline) afterInlineByName.set(e.name, e.fn);

  for (const fn of modAfterTU.functions) {
    const before = afterInlineByName.get(fn.name);
    const wasCloned = before === undefined;
    const changed = wasCloned || fn !== before;
    const final = changed ? runHygienePasses(fn) : fn;
    const verifyErrors = verifyIrFunction(final);
    if (verifyErrors.length > 0) {
      for (const e of verifyErrors) {
        errors.push({ func: fn.name, message: `post-mono verify: ${e.message}` });
      }
      continue;
    }
    readyForLower.push({ name: fn.name, fn: final });
  }

  if (readyForLower.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // Register monomorphized clones in `ctx` — append a placeholder
  // WasmFunction slot and record the assigned funcIdx in `ctx.funcMap`.
  // The placeholder body is overwritten with the real lowered body in the
  // Phase-3 loop below.
  // -------------------------------------------------------------------------
  for (const entry of readyForLower) {
    if (originalNames.has(entry.name)) continue;
    if (ctx.funcMap.has(entry.name)) continue; // already registered (defensive)
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: entry.name,
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    });
    ctx.funcMap.set(entry.name, funcIdx);
  }

  // -------------------------------------------------------------------------
  // Phase 3 prep — Eagerly register string imports + literals BEFORE lowering.
  //
  // Rationale: `addStringImports` shifts existing function indices when called
  // late, and `addStringConstantGlobal` shifts global indices when called
  // after module globals exist. Both shift passes walk
  // `ctx.mod.functions[].body` AND `ctx.currentFunc.body`. They do NOT walk
  // the lowerer's local `out: Instr[]` buffer that holds the IR-lowered body
  // mid-emission. So if a `string.const` triggers `addStringConstantGlobal`
  // mid-emission, an earlier `global.get` we already pushed to `out` for this
  // function would carry a now-stale index.
  //
  // We avoid that race by pre-walking the IR BEFORE Phase 3 starts and
  // calling both registration helpers up front. Both are idempotent on
  // existing entries, so duplicate calls are safe and cheap.
  //
  // Native-strings mode bakes string globals inline as
  // `array.new_fixed`/`struct.new`, so it doesn't need the import shifting
  // machinery — but we still walk the IR for symmetry and to keep the
  // resolver path uniform.
  // -------------------------------------------------------------------------
  preregisterStringSupport(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // Phase 3 — Lower: translate each IrFunction to Wasm and install in ctx.
  // -------------------------------------------------------------------------
  //
  // String backend: capture concrete funcIdx values for the native-string
  // helpers (`__str_concat`, `__str_equals`) and the wasm:js-string imports
  // (`concat`, `equals`, `length`) AT THIS POINT — after all late imports
  // (e.g. `addPrimitiveTypeImports` triggered by legacy compileDeclarations)
  // have shifted the index space. `ctx.nativeStrHelpers` is a stale map
  // post-shift (the shift pass updates `funcMap` and call ops in bodies but
  // not the helpers map), so we resolve names against `ctx.mod.functions`
  // directly to pick up the current absolute index.
  const stringBackend = computeStringBackend(ctx);
  const resolver = makeResolver(ctx, unionRegistry, stringBackend);
  for (const entry of readyForLower) {
    const name = entry.name;
    // Targeted skip: if this function is called by a Phase-1 failure
    // (legacy body fallback), keep its slot at the legacy typeIdx so the
    // failed peer's `call` op stays well-typed. See `skipPhase3CommitFor`
    // construction above.
    if (skipPhase3CommitFor.has(name)) continue;
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

/**
 * Predicate matching the same node kinds that `select.ts:isFunctionLike`
 * uses. Inlined here so the targeted typeIdx-mismatch guard in
 * `compileIrPathFunctions` doesn't need to import from `select.ts`.
 *
 * The call-graph scan stops at any nested function-like boundary because
 * a nested arrow/function inside a top-level declaration is not part of
 * the top-level function's own outgoing-call set (its calls belong to
 * the inner scope).
 */
function isFunctionLikeNodeForCallScan(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
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

/**
 * String-backend funcIdx resolution captured at Phase-3 entry. Both maps
 * (`ctx.nativeStrHelpers`, `ctx.jsStringImports`) can be stale after late
 * import shifts triggered during legacy compileDeclarations; we resolve by
 * name against the current state of `ctx.funcMap` / `ctx.mod.functions` to
 * pick up the absolute index in the post-shift index space.
 */
interface StringBackendIndices {
  /** Native-string helper funcIdx by name — null when missing. */
  readonly nativeHelpers: ReadonlyMap<string, number>;
  /** wasm:js-string import funcIdx by op name — null when missing. */
  readonly hostImports: ReadonlyMap<string, number>;
}

function computeStringBackend(ctx: CodegenContext): StringBackendIndices {
  const nativeHelpers = new Map<string, number>();
  const hostImports = new Map<string, number>();

  // Native helpers are stored as defined functions in `ctx.mod.functions`
  // with a stable `name` field; convert their local index to absolute via
  // `numImportFuncs`.
  if (ctx.nativeStrings) {
    for (let i = 0; i < ctx.mod.functions.length; i++) {
      const f = ctx.mod.functions[i]!;
      if (f.name === "__str_concat" || f.name === "__str_equals") {
        nativeHelpers.set(f.name, ctx.numImportFuncs + i);
      }
    }
  } else {
    // wasm:js-string imports live in `ctx.funcMap` keyed by op name (see
    // `addStringImports`). `funcMap` IS shift-aware, so this lookup is
    // already in the post-shift index space.
    for (const op of ["concat", "equals", "length"] as const) {
      const idx = ctx.funcMap.get(op);
      if (idx !== undefined) hostImports.set(op, idx);
    }
  }
  return { nativeHelpers, hostImports };
}

function makeResolver(
  ctx: CodegenContext,
  unionRegistry: UnionStructRegistry,
  stringBackend: StringBackendIndices,
): IrLowerResolver {
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
    // -------------------------------------------------------------------
    // String backend dispatch (#1169a).
    // -------------------------------------------------------------------
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
    emitStringConst(value: string): readonly Instr[] {
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        // Native strings: inline `array.new_fixed` of WTF-16 code units +
        // `struct.new $NativeString(len, off, data)` — same shape as
        // `compileNativeStringLiteral` in the legacy path.
        const ops: Instr[] = [
          { op: "i32.const", value: value.length },
          { op: "i32.const", value: 0 },
        ];
        for (let i = 0; i < value.length; i++) {
          ops.push({ op: "i32.const", value: value.charCodeAt(i) });
        }
        ops.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: value.length });
        ops.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
        return ops;
      }
      // Host strings: pre-registration in `preregisterStringSupport` already
      // ensured the string global exists. Look up the (now-final) index.
      const globalIdx = ctx.stringGlobalMap.get(value);
      if (globalIdx === undefined || globalIdx < 0) {
        throw new Error(`ir/integration: string literal "${value}" was not pre-registered`);
      }
      return [{ op: "global.get", index: globalIdx }];
    },
    emitStringConcat(): readonly Instr[] {
      if (ctx.nativeStrings) {
        const idx = stringBackend.nativeHelpers.get("__str_concat");
        if (idx === undefined) {
          throw new Error("ir/integration: __str_concat helper not registered");
        }
        return [{ op: "call", funcIdx: idx }];
      }
      const idx = stringBackend.hostImports.get("concat");
      if (idx === undefined) throw new Error("ir/integration: wasm:js-string concat not registered");
      return [{ op: "call", funcIdx: idx }];
    },
    emitStringEquals(): readonly Instr[] {
      if (ctx.nativeStrings) {
        const idx = stringBackend.nativeHelpers.get("__str_equals");
        if (idx === undefined) {
          throw new Error("ir/integration: __str_equals helper not registered");
        }
        return [{ op: "call", funcIdx: idx }];
      }
      const idx = stringBackend.hostImports.get("equals");
      if (idx === undefined) throw new Error("ir/integration: wasm:js-string equals not registered");
      return [{ op: "call", funcIdx: idx }];
    },
    emitStringLen(): readonly Instr[] {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        // AnyString.length is field 0 (matches struct definition in
        // src/codegen/native-strings.ts).
        return [{ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 }];
      }
      const idx = stringBackend.hostImports.get("length");
      if (idx === undefined) throw new Error("ir/integration: wasm:js-string length not registered");
      return [{ op: "call", funcIdx: idx }];
    },
  };
}

// ---------------------------------------------------------------------------
// String pre-registration (#1169a)
// ---------------------------------------------------------------------------

interface BuiltFnRef {
  readonly fn: IrFunction;
}

/**
 * Walk every IR function the lowerer is about to emit and pre-register the
 * string-backend support it will need. This must run BEFORE Phase 3 starts
 * because both `addStringImports` and `addStringConstantGlobal` re-shift
 * function/global indices in already-compiled bodies; calling them
 * mid-emission risks invalidating the lowerer's local op buffer.
 *
 * Idempotent — repeat calls are no-ops, and the helpers themselves are
 * idempotent on `(ctx.hasStringImports, ctx.stringGlobalMap)`.
 */
function preregisterStringSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  // Find all distinct string literals + whether any string op is used at all.
  const literals = new Set<string>();
  let usesStringOp = false;
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (instrUsesStrings(instr)) usesStringOp = true;
        if (instr.kind === "string.const") literals.add(instr.value);
      }
    }
  }
  if (!usesStringOp) return;

  if (!ctx.nativeStrings) {
    // Host-string backend: ensure all five `wasm:js-string` imports exist.
    addStringImports(ctx);
    // Pre-register every string literal as a global import. The helper is
    // idempotent on `value`, so repeat calls (e.g. literals also collected
    // by the legacy path) are no-ops.
    for (const value of literals) {
      addStringConstantGlobal(ctx, value);
    }
  }
  // Native strings: nothing to pre-register here. The native-string struct
  // types and helpers (`__str_concat`, `__str_equals`, `__str_flatten`) are
  // emitted up front by the legacy codegen whenever any string literal /
  // operation appears in source. The IR selector accepts `string` only when
  // a string operation appears in source, so the helpers are guaranteed to
  // exist by the time Phase 3 runs. (If they don't, the resolver throws
  // with a clear message and the caller falls back to legacy.)
}

function instrUsesStrings(instr: IrInstr): boolean {
  return (
    instr.kind === "string.const" ||
    instr.kind === "string.concat" ||
    instr.kind === "string.eq" ||
    instr.kind === "string.len"
  );
}
