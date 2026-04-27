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

import { addGeneratorImports, addIteratorImports, addStringImports } from "../codegen/index.js";
import { ensureNativeStringHelpers } from "../codegen/native-strings.js";
import { addStringConstantGlobal } from "../codegen/registry/imports.js";
import { addFuncType, getOrRegisterRefCellType } from "../codegen/registry/types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { lowerFunctionAstToIr } from "./from-ast.js";
import {
  lowerIrFunctionToWasm,
  lowerIrTypeToValType,
  type IrClassLowering,
  type IrClosureLowering,
  type IrLowerResolver,
  type IrObjectStructLowering,
  type IrRefCellLowering,
  type IrUnionLowering,
} from "./lower.js";
import type {
  IrClassShape,
  IrClosureSignature,
  IrFuncRef,
  IrFunction,
  IrGlobalRef,
  IrInstr,
  IrModule,
  IrObjectShape,
  IrType,
  IrTypeRef,
} from "./nodes.js";
import { constantFold } from "./passes/constant-fold.js";
import { deadCode } from "./passes/dead-code.js";
import { inlineSmall } from "./passes/inline-small.js";
import { monomorphize } from "./passes/monomorphize.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import { UnionStructRegistry } from "./passes/tagged-union-types.js";
import { taggedUnions } from "./passes/tagged-unions.js";
import { planIrCompilation, type IrSelection } from "./select.js";
import { verifyIrFunction } from "./verify.js";
import type { FieldDef, FuncTypeDef, Instr, StructTypeDef, ValType } from "./types.js";

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
  classShapes?: ReadonlyMap<string, IrClassShape>,
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
    /**
     * Slice 3 (#1169c): set when `fn` is a lifted closure or nested
     * function rather than a top-level FunctionDeclaration. Synthesized
     * fns have no ts.FunctionDeclaration and no pre-allocated funcIdx —
     * the integration loop allocates a fresh slot in `ctx.mod.functions`
     * (mirrors the monomorphize-clone path).
     */
    readonly synthesized?: boolean;
  }
  const built: BuiltFn[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    const name = stmt.name.text;
    if (!selected.funcs.has(name)) continue;

    try {
      const o = overrides?.get(name);
      const result = lowerFunctionAstToIr(stmt, {
        exported: hasExportModifier(stmt),
        paramTypeOverrides: o?.params,
        returnTypeOverride: o?.returnType,
        calleeTypes,
        classShapes,
        // Slice 6 part 4 (#1183): thread the nativeStrings flag and
        // AnyString typeIdx so `lowerForOfStatement`'s string arm can
        // pick the native counter loop and declare slot ValTypes
        // without round-tripping through a full LowerResolver.
        nativeStrings: ctx.nativeStrings,
        anyStrTypeIdx: ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : undefined,
      });
      const mainErrors = verifyIrFunction(result.main);
      if (mainErrors.length > 0) {
        for (const e of mainErrors) errors.push({ func: name, message: e.message });
        continue;
      }
      // Slice 3 (#1169c): verify each lifted function before pushing.
      let anyLiftedFailed = false;
      for (const lifted of result.lifted) {
        const liftedErrors = verifyIrFunction(lifted);
        if (liftedErrors.length > 0) {
          for (const e of liftedErrors) errors.push({ func: lifted.name, message: e.message });
          anyLiftedFailed = true;
        }
      }
      if (anyLiftedFailed) continue;

      built.push({ name, fn: result.main });
      for (const lifted of result.lifted) {
        built.push({ name: lifted.name, fn: lifted, synthesized: true });
      }
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
    afterHygiene.push({ name: entry.name, fn: optimized, synthesized: entry.synthesized });
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
    afterInline.push({ name: before.name, fn: final, synthesized: before.synthesized });
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
  const afterInlineByName = new Map<string, BuiltFn>();
  for (const e of afterInline) afterInlineByName.set(e.name, e);

  for (const fn of modAfterTU.functions) {
    const before = afterInlineByName.get(fn.name);
    const wasCloned = before === undefined;
    const changed = wasCloned || fn !== before.fn;
    const final = changed ? runHygienePasses(fn) : fn;
    const verifyErrors = verifyIrFunction(final);
    if (verifyErrors.length > 0) {
      for (const e of verifyErrors) {
        errors.push({ func: fn.name, message: `post-mono verify: ${e.message}` });
      }
      continue;
    }
    // Slice 3 (#1169c): clones from monomorphize don't have synthesized
    // info from the build phase; treat them as synthesized iff the
    // pre-mono entry was synthesized OR the function is brand-new (a
    // cloned specialization for a new param-type tuple).
    readyForLower.push({
      name: fn.name,
      fn: final,
      synthesized: before?.synthesized || wasCloned,
    });
  }

  if (readyForLower.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // Register monomorphized clones in `ctx` — append a placeholder
  // WasmFunction slot and record the assigned funcIdx in `ctx.funcMap`.
  // The placeholder body is overwritten with the real lowered body in the
  // Phase-3 loop below.
  // -------------------------------------------------------------------------
  for (const entry of readyForLower) {
    // Top-level (non-synthesized) functions already have a funcIdx
    // allocated by `compileDeclarations`. Skip them.
    if (originalNames.has(entry.name) && !entry.synthesized) continue;
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
  // Slice 6 part 3 (#1182) — iterator host imports.
  //
  // Walk every IR function for any `iter.*` / `forof.iter` / coercion-to-
  // externref instruction; if found, call `addIteratorImports(ctx)` so the
  // resolver can map `__iterator` / `__iterator_next` / `__iterator_done` /
  // `__iterator_value` / `__iterator_return` to concrete funcIdx values
  // BEFORE Phase 3 resolves IrFuncRef symbols. This pre-registration
  // matches `preregisterStringSupport`'s rationale.
  // -------------------------------------------------------------------------
  preregisterIteratorSupport(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // Slice 7a (#1169f) — pre-register generator host imports if any IR
  // function will emit `gen.push` / `gen.epilogue`. Same rationale as
  // the string + iterator pre-registration above: late-import shifting
  // is expensive and can invalidate the lowerer's local op buffer if
  // it fires mid-emission. `addGeneratorImports` is idempotent on
  // `ctx.funcMap` membership, so the legacy-source detection at
  // `codegen/index.ts:4031` (which fires whenever the source contains
  // any `function*`) makes this call a no-op in practice — but the
  // call here is the supported entry point for IR-only test fixtures
  // that don't trigger legacy detection (e.g. an IR test that
  // synthesises a generator without the AST scan running).
  // -------------------------------------------------------------------------
  if (readyForLower.some((e) => e.fn.funcKind === "generator")) {
    addGeneratorImports(ctx);
  }
  // -------------------------------------------------------------------------
  // Slice 6 part 4 (#1183) — native-string helpers (notably __str_charAt).
  //
  // Walk every IR function for any `forof.string` instr; if found, call
  // `ensureNativeStringHelpers(ctx)` so `__str_charAt` (and the rest of
  // the native-string helper family) is registered before the lowerer
  // resolves the funcref. The helper itself is idempotent, but calling
  // it eagerly avoids late-import shifts during Phase 3 emission.
  // -------------------------------------------------------------------------
  preregisterNativeStringHelpers(ctx, readyForLower);

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
  // Build the resolver in two steps so the resolver and the
  // ObjectStructRegistry / ClosureStructRegistry can refer to each
  // other without a circular direct reference: the registries need
  // `lowerIrTypeToValType` (which calls `resolver.resolveString` /
  // `resolveObject` / `resolveClosure`), and the resolver delegates
  // back to the registries. We hand the resolver `Deferred*Resolver`
  // shells whose `resolve` callbacks are filled in after the
  // registries exist.
  const deferredObj: DeferredObjectResolver = {
    resolve: (_shape: IrObjectShape) => null,
  };
  const deferredCl: DeferredClosureResolver = {
    resolveBase: () => null,
    resolveSubtype: () => null,
  };
  const deferredCell: DeferredRefCellResolver = {
    resolve: () => null,
  };
  const deferredClass: DeferredClassResolver = {
    resolve: () => null,
  };
  const resolver = makeResolver(
    ctx,
    unionRegistry,
    stringBackend,
    deferredObj,
    deferredCl,
    deferredCell,
    deferredClass,
  );
  const objectRegistry = new ObjectStructRegistry(ctx, (t) => lowerIrTypeToValType(t, resolver, "<obj-registry>"));
  deferredObj.resolve = (shape) => objectRegistry.resolve(shape);
  const closureRegistry = new ClosureStructRegistry(ctx, (t) =>
    lowerIrTypeToValType(t, resolver, "<closure-registry>"),
  );
  deferredCl.resolveBase = (sig) => closureRegistry.resolveBase(sig);
  deferredCl.resolveSubtype = (sig, fields) => closureRegistry.resolveSubtype(sig, fields);
  const refCellRegistry = new RefCellRegistry(ctx);
  deferredCell.resolve = (inner) => refCellRegistry.resolve(inner);
  // Slice 4 (#1169d): the class registry is a thin lookup over the
  // legacy class-collection state — `ctx.structMap`, `ctx.structFields`,
  // and `ctx.funcMap` carry everything we need.
  const classRegistry = new ClassRegistry(ctx);
  deferredClass.resolve = (shape) => classRegistry.resolve(shape);
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

/**
 * Late-bound resolver delegate — used so the recursive struct registry
 * (which needs to lower IrType→ValType, including string types via the
 * resolver) and the resolver (whose resolveObject delegates to the
 * registry) can both refer to each other without a circular import.
 */
interface DeferredObjectResolver {
  resolve: (shape: IrObjectShape) => IrObjectStructLowering | null;
}

interface DeferredClosureResolver {
  resolveBase: (sig: IrClosureSignature) => IrClosureLowering | null;
  resolveSubtype: (sig: IrClosureSignature, fields: readonly IrType[]) => IrClosureLowering | null;
}

interface DeferredRefCellResolver {
  resolve: (inner: ValType) => IrRefCellLowering | null;
}

interface DeferredClassResolver {
  resolve: (shape: IrClassShape) => IrClassLowering | null;
}

function makeResolver(
  ctx: CodegenContext,
  unionRegistry: UnionStructRegistry,
  stringBackend: StringBackendIndices,
  objResolver: DeferredObjectResolver,
  closureResolver: DeferredClosureResolver,
  refCellResolver: DeferredRefCellResolver,
  classResolver: DeferredClassResolver,
): IrLowerResolver {
  return {
    resolveFunc(ref: IrFuncRef): number {
      const idx = ctx.funcMap.get(ref.name);
      if (idx !== undefined) return idx;
      // Slice 6 part 4 (#1183): native-string helpers (`__str_charAt`,
      // `__str_concat`, `__str_equals`, `__str_flatten`, etc.) are
      // registered in `ctx.nativeStrHelpers`, not `ctx.funcMap`. The
      // helper map captures funcIdx at registration time and does NOT
      // get re-shifted by late-import passes, so we re-resolve by name
      // against the post-shift `ctx.mod.functions` (parallel to
      // `computeStringBackend`'s rationale for the host string ops).
      for (let i = 0; i < ctx.mod.functions.length; i++) {
        if (ctx.mod.functions[i]!.name === ref.name) {
          return ctx.numImportFuncs + i;
        }
      }
      // Last fallback: the (potentially stale) helpers map. Used when
      // a name doesn't appear in `ctx.mod.functions` because it's a
      // host import rather than a defined helper.
      const helperIdx = ctx.nativeStrHelpers.get(ref.name);
      if (helperIdx !== undefined) return helperIdx;
      throw new Error(`ir/integration: unknown function ref "${ref.name}"`);
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
    resolveObject(shape: IrObjectShape): IrObjectStructLowering | null {
      return objResolver.resolve(shape);
    },
    // -------------------------------------------------------------------
    // Closure / ref-cell dispatch (#1169c).
    // -------------------------------------------------------------------
    resolveClosure(sig: IrClosureSignature): IrClosureLowering | null {
      return closureResolver.resolveBase(sig);
    },
    resolveClosureSubtype(sig: IrClosureSignature, fields: readonly IrType[]): IrClosureLowering | null {
      return closureResolver.resolveSubtype(sig, fields);
    },
    resolveRefCell(inner: ValType): IrRefCellLowering | null {
      return refCellResolver.resolve(inner);
    },
    // -------------------------------------------------------------------
    // Class dispatch (#1169d).
    // -------------------------------------------------------------------
    resolveClass(shape: IrClassShape): IrClassLowering | null {
      return classResolver.resolve(shape);
    },
    // -------------------------------------------------------------------
    // Vec dispatch (slice 6 part 2 — #1181).
    //
    // Walks the legacy `ctx.mod.types` registry to recover the layout the
    // for-of vec fast path needs from a `(ref $vec_*)` ValType. The legacy
    // `getOrRegisterVecType` always shapes a vec as
    //   { length: i32, data: (ref $arr_<elem>) }
    // so we just verify that shape and read the element ValType off the
    // backing array type. Returns null when the input isn't a recognisable
    // vec — the caller treats that as a selector bug (the for-of selector
    // should have rejected the function).
    // -------------------------------------------------------------------
    resolveVec(valType: ValType): import("./lower.js").IrVecLowering | null {
      if (valType.kind !== "ref" && valType.kind !== "ref_null") return null;
      const typeIdx = (valType as { typeIdx: number }).typeIdx;
      const vecDef = ctx.mod.types[typeIdx];
      if (!vecDef || vecDef.kind !== "struct") return null;
      if (vecDef.fields.length < 2) return null;
      const lengthField = vecDef.fields[0]!;
      const dataField = vecDef.fields[1]!;
      if (lengthField.type.kind !== "i32") return null;
      if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
      const arrayTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      if (!arrayDef || arrayDef.kind !== "array") return null;
      return {
        vecStructTypeIdx: typeIdx,
        lengthFieldIdx: 0,
        dataFieldIdx: 1,
        arrayTypeIdx,
        elementValType: arrayDef.element,
      };
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

// ---------------------------------------------------------------------------
// Iterator pre-registration (#1182)
// ---------------------------------------------------------------------------

/**
 * Slice 6 part 3 (#1182): pre-register the iterator host imports if any
 * IR function emits an `iter.*` or `forof.iter` instr. Same pattern and
 * rationale as `preregisterStringSupport`: late import registration
 * shifts function indices, and we want the shift to be a no-op on the
 * IR path's `IrFuncRef` resolution.
 *
 * `addIteratorImports` is idempotent on `ctx.funcMap.has("__iterator")`,
 * so it's safe to call repeatedly.
 */
function preregisterIteratorSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  const usesIter = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "iter.new":
      case "iter.next":
      case "iter.done":
      case "iter.value":
      case "iter.return":
        return true;
      case "forof.iter": {
        // forof.iter is itself an iter user, but ALSO walk the body in
        // case the IR ever materialises iter.* directly inside.
        for (const sub of instr.body) {
          if (usesIter(sub)) return true;
        }
        return true;
      }
      case "forof.vec": {
        // A vec for-of body can syntactically contain nested iter ops.
        for (const sub of instr.body) {
          if (usesIter(sub)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesIter(instr)) {
          addIteratorImports(ctx);
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Native-string helper pre-registration (#1183)
// ---------------------------------------------------------------------------

/**
 * Slice 6 part 4 (#1183): pre-register native-string helpers
 * (`__str_charAt`, `__str_concat`, `__str_equals`, `__str_flatten`, …)
 * if any IR function emits a `forof.string` instr. Same rationale as
 * `preregisterStringSupport` and `preregisterIteratorSupport` —
 * idempotent helper, called eagerly so Phase 3's funcref resolution
 * sees stable indices.
 *
 * `forof.string` is only produced by from-ast in native-strings mode,
 * so the helper call here is a no-op in host-strings mode.
 */
function preregisterNativeStringHelpers(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  if (!ctx.nativeStrings) return;
  const usesForOfString = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "forof.string":
        return true;
      case "forof.vec":
      case "forof.iter":
        for (const sub of instr.body) {
          if (usesForOfString(sub)) return true;
        }
        return false;
      default:
        return false;
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesForOfString(instr)) {
          ensureNativeStringHelpers(ctx);
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Object struct registry (#1169b)
// ---------------------------------------------------------------------------

/**
 * Hash-based registry for `IrObjectShape` → WasmGC struct mappings.
 *
 * Slice-2 invariants:
 *   - Same canonical shape always maps to the same struct typeIdx.
 *   - The registry hashes shapes the same way as the legacy
 *     `fieldsHashKey` in `codegen/index.ts`, so a shape registered by
 *     legacy `ensureStructForType` and a shape registered through the IR
 *     converge on a single anonymous struct (`__anon_<n>`).
 *   - Field reference types are widened from `ref` to `ref_null` so
 *     `struct.new` defaults match the legacy `ensureStructForType`
 *     pattern (`codegen/index.ts:4584-4589`).
 *
 * Resolution can fail with `null` when a field IrType cannot be lowered
 * to a ValType — the lowerer surfaces that as a clean error, so the
 * containing function falls back to legacy.
 */
class ObjectStructRegistry {
  private readonly cache = new Map<string, IrObjectStructLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (t: IrType) => ValType,
  ) {}

  resolve(shape: IrObjectShape): IrObjectStructLowering | null {
    const key = this.hashKey(shape);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Lower each field IrType to a ValType. If any field is a kind we
    // can't lower, bail with null so the caller throws a clean error
    // and the function falls back to legacy.
    const fields: FieldDef[] = [];
    for (const f of shape.fields) {
      let wasm: ValType;
      try {
        wasm = this.resolveValType(f.type);
      } catch {
        return null;
      }
      // Widen non-null refs to ref_null so struct.new with default
      // initialization works — matches `codegen/index.ts:4584-4589`.
      if (wasm.kind === "ref") {
        wasm = { kind: "ref_null", typeIdx: wasm.typeIdx };
      }
      fields.push({ name: f.name, type: wasm, mutable: true });
    }

    // Reuse an existing anonymous struct with the same legacy hash key
    // if one was already registered (legacy↔IR convergence).
    const legacyKey = legacyFieldsHashKey(fields);
    let structName = this.ctx.anonStructHash.get(legacyKey);
    let typeIdx: number;
    if (structName !== undefined) {
      typeIdx = this.ctx.structMap.get(structName)!;
      // The structFields entry already exists from the legacy
      // registration; reuse it rather than overwriting.
    } else {
      structName = `__anon_${this.ctx.anonTypeCounter++}`;
      typeIdx = this.ctx.mod.types.length;
      this.ctx.mod.types.push({
        kind: "struct",
        name: structName,
        fields,
      } as StructTypeDef);
      this.ctx.structMap.set(structName, typeIdx);
      this.ctx.typeIdxToStructName.set(typeIdx, structName);
      this.ctx.structFields.set(structName, fields);
      this.ctx.anonStructHash.set(legacyKey, structName);
    }

    const fieldIdxByName = new Map<string, number>();
    fields.forEach((f, i) => fieldIdxByName.set(f.name, i));
    const lowering: IrObjectStructLowering = {
      typeIdx,
      fieldIdx: (name: string): number => {
        const idx = fieldIdxByName.get(name);
        if (idx === undefined) {
          throw new Error(`ir/integration: shape has no field "${name}"`);
        }
        return idx;
      },
    };
    this.cache.set(key, lowering);
    return lowering;
  }

  /**
   * Canonical hash for a shape — names + recursive IR-type keys, joined
   * with stable separators. Different shapes always hash differently;
   * structurally identical shapes (already pre-sorted by name in the
   * builder) always hash identically.
   */
  private hashKey(shape: IrObjectShape): string {
    return shape.fields.map((f) => `${f.name}:${irTypeKey(f.type)}`).join("|");
  }
}

/**
 * Recursive IrType→string key for shape hashing. Mirrors the legacy
 * `fieldsHashKey` format closely so identical shapes registered through
 * either path collide on a single struct (although the actual
 * legacy/IR convergence is enforced via `legacyFieldsHashKey` on the
 * lowered ValTypes — this key is the IR-side memo).
 */
function irTypeKey(t: IrType): string {
  if (t.kind === "val") {
    if (t.val.kind === "ref" || t.val.kind === "ref_null") {
      return `${t.val.kind}:${(t.val as { typeIdx: number }).typeIdx}`;
    }
    return t.val.kind;
  }
  if (t.kind === "string") return "string";
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${irTypeKey(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure") {
    const ps = t.signature.params.map(irTypeKey).join(",");
    return `closure(${ps})->${irTypeKey(t.signature.returnType)}`;
  }
  // Slice 4 (#1169d): class is keyed by name — uniqueness across the
  // compilation unit makes this safe.
  if (t.kind === "class") return `class:${t.shape.className}`;
  if (t.kind === "union") return `union<${t.members.map((m) => m.kind).join(",")}>`;
  return `boxed<${t.inner.kind}>`;
}

/**
 * Mirror of `fieldsHashKey` in `src/codegen/index.ts`. Re-implemented
 * locally so the IR module doesn't pull on `codegen/index.ts`'s public
 * surface (which is large). The two implementations must stay in sync —
 * they're the legacy↔IR struct-dedup contract.
 */
function legacyFieldsHashKey(fields: readonly FieldDef[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const t = f.type;
    if (t.kind === "ref" || t.kind === "ref_null") {
      parts.push(`${f.name}:${t.kind}:${(t as { typeIdx: number }).typeIdx}`);
    } else {
      parts.push(`${f.name}:${t.kind}`);
    }
  }
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// Closure / ref-cell registries (#1169c)
// ---------------------------------------------------------------------------

/**
 * Slice 3 (#1169c): per-signature closure struct registry. Maintains:
 *   - **base** structs (one per signature) — single-funcref-field
 *     supertype; carried by `IrType.closure` so all closures of the same
 *     signature share one Wasm value type.
 *   - **subtype** structs (one per `(signature, captureFieldTypes)`
 *     pair) — extends the base with capture fields. Constructed at
 *     each `closure.new` site; lifted bodies `ref.cast` __self to
 *     their corresponding subtype to read captures.
 */
class ClosureStructRegistry {
  private readonly baseCache = new Map<string, IrClosureLowering>();
  private readonly subCache = new Map<string, IrClosureLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (t: IrType) => ValType,
  ) {}

  resolveBase(sig: IrClosureSignature): IrClosureLowering | null {
    const key = sigKey(sig);
    const cached = this.baseCache.get(key);
    if (cached) return cached;

    // Synthesize the base struct: just the funcref field, no captures.
    // Mark as `superTypeIdx: -1` (root of hierarchy, non-final) so
    // subtypes can extend it. A bare struct with `superTypeIdx`
    // undefined is emitted as final by the Wasm spec, which would
    // make the subtype declaration invalid (`type N extends final
    // type M`).
    const baseStructIdx = this.ctx.mod.types.length;
    const baseStructName = `__ir_closure_base_${this.baseCache.size}`;
    const baseFields: FieldDef[] = [{ name: "func", type: { kind: "funcref" }, mutable: false }];
    this.ctx.mod.types.push({
      kind: "struct",
      name: baseStructName,
      fields: baseFields,
      superTypeIdx: -1,
    } as StructTypeDef);
    this.ctx.structMap.set(baseStructName, baseStructIdx);
    this.ctx.typeIdxToStructName.set(baseStructIdx, baseStructName);
    this.ctx.structFields.set(baseStructName, baseFields);

    // Lifted func type: (ref $base, ...sig.params) -> sig.returnType.
    let paramTypes: ValType[];
    let resultTypes: ValType[];
    try {
      paramTypes = sig.params.map((p) => this.resolveValType(p));
      resultTypes = [this.resolveValType(sig.returnType)];
    } catch {
      return null;
    }
    const liftedFuncTypeIdx = addFuncType(
      this.ctx,
      [{ kind: "ref", typeIdx: baseStructIdx }, ...paramTypes],
      resultTypes,
      `${baseStructName}_funcType`,
    );

    const lowering: IrClosureLowering = {
      structTypeIdx: baseStructIdx,
      funcFieldIdx: 0,
      capFieldIdx: () => {
        throw new Error("ir/integration: base closure struct has no captures");
      },
      funcTypeIdx: liftedFuncTypeIdx,
    };
    this.baseCache.set(key, lowering);
    return lowering;
  }

  resolveSubtype(sig: IrClosureSignature, captureFieldTypes: readonly IrType[]): IrClosureLowering | null {
    const key = `${sigKey(sig)}#${captureFieldTypes.map(irTypeKey).join(",")}`;
    const cached = this.subCache.get(key);
    if (cached) return cached;

    const base = this.resolveBase(sig);
    if (!base) return null;

    const fields: FieldDef[] = [{ name: "func", type: { kind: "funcref" }, mutable: false }];
    for (let i = 0; i < captureFieldTypes.length; i++) {
      let ft: ValType;
      try {
        ft = this.resolveValType(captureFieldTypes[i]!);
      } catch {
        return null;
      }
      fields.push({ name: `cap${i}`, type: ft, mutable: false });
    }

    const subIdx = this.ctx.mod.types.length;
    const subName = `__ir_closure_${this.subCache.size}`;
    this.ctx.mod.types.push({
      kind: "struct",
      name: subName,
      fields,
      superTypeIdx: base.structTypeIdx,
    } as StructTypeDef);
    this.ctx.structMap.set(subName, subIdx);
    this.ctx.typeIdxToStructName.set(subIdx, subName);
    this.ctx.structFields.set(subName, fields);

    const fieldIdxByCap = new Map<number, number>();
    for (let i = 0; i < captureFieldTypes.length; i++) fieldIdxByCap.set(i, i + 1);

    const lowering: IrClosureLowering = {
      structTypeIdx: subIdx,
      funcFieldIdx: 0,
      capFieldIdx: (i: number): number => {
        const v = fieldIdxByCap.get(i);
        if (v === undefined) throw new Error(`ir/integration: closure subtype has no capture index ${i}`);
        return v;
      },
      // call_ref dispatches via the BASE func type — subtype shares it.
      funcTypeIdx: base.funcTypeIdx,
    };
    this.subCache.set(key, lowering);
    return lowering;
  }
}

function sigKey(sig: IrClosureSignature): string {
  const ps = sig.params.map(irTypeKey).join(",");
  return `(${ps})->${irTypeKey(sig.returnType)}`;
}

/**
 * Slice 3 (#1169c): trivial wrapper around the legacy
 * `getOrRegisterRefCellType` so legacy and IR ref cells share a single
 * WasmGC struct per inner ValType.
 */
class RefCellRegistry {
  constructor(private readonly ctx: CodegenContext) {}

  resolve(inner: ValType): IrRefCellLowering | null {
    const typeIdx = getOrRegisterRefCellType(this.ctx, inner);
    return { typeIdx, fieldIdx: 0 };
  }
}

/**
 * Slice 4 (#1169d): per-class lookup over the legacy class registry.
 *
 * The legacy `collectClassDeclaration` pass (in `class-bodies.ts`)
 * registers, for each class declared in source:
 *   - a struct type in `ctx.structMap` (key = className)
 *   - the canonical fields list in `ctx.structFields` (with `__tag` at
 *     field 0 for root classes)
 *   - a constructor function `<className>_new` in `ctx.funcMap`
 *   - one method function `<className>_<methodName>` per instance
 *     method in `ctx.funcMap`
 *
 * `ClassRegistry.resolve` maps an `IrClassShape` to that legacy state
 * via the `className`, with one defensive lookup per resolution call so
 * a class that wasn't registered (e.g. shape was synthesized incorrectly)
 * surfaces as `null` and the caller falls back to legacy.
 *
 * Cached per className for cheap re-resolution.
 */
class ClassRegistry {
  private readonly cache = new Map<string, IrClassLowering>();

  constructor(private readonly ctx: CodegenContext) {}

  resolve(shape: IrClassShape): IrClassLowering | null {
    const cached = this.cache.get(shape.className);
    if (cached) return cached;

    const structTypeIdx = this.ctx.structMap.get(shape.className);
    if (structTypeIdx === undefined) return null;
    const legacyFields = this.ctx.structFields.get(shape.className);
    if (!legacyFields) return null;

    // Build a name → wasm-field-index map directly from the legacy
    // struct field list so the IR sees the same indices the legacy
    // path uses for `struct.get` / `struct.set`. The `__tag` prefix
    // (at index 0 for root classes) is included in legacyFields, so a
    // user field "x" at IR position 0 corresponds to legacy field
    // index 1 (or higher, depending on the parent chain). Slice 4
    // doesn't claim functions referencing inherited classes, so
    // legacyFields[0] is always `__tag`; user fields start at index 1.
    const fieldIdxByName = new Map<string, number>();
    for (let i = 0; i < legacyFields.length; i++) {
      fieldIdxByName.set(legacyFields[i]!.name, i);
    }

    const constructorFuncName = `${shape.className}_new`;

    const lowering: IrClassLowering = {
      structTypeIdx,
      fieldIdx: (name: string): number => {
        const idx = fieldIdxByName.get(name);
        if (idx === undefined) {
          throw new Error(`ir/integration: class ${shape.className} has no field "${name}"`);
        }
        return idx;
      },
      constructorFuncName,
      methodFuncName: (name: string): string => {
        // Returns a NAME — the resolver's `resolveFunc` maps it to the
        // funcIdx via `ctx.funcMap`, which the legacy collection pass
        // populated with stable indices.
        return `${shape.className}_${name}`;
      },
    };
    this.cache.set(shape.className, lowering);
    return lowering;
  }
}
