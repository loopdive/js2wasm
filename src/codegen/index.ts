// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import {
  isBigIntType,
  isBooleanType,
  isExternalDeclaredClass,
  isHeterogeneousUnion,
  isNumberType,
  isStringType,
  isVoidType,
  mapTsTypeToWasm,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { compileIrPathFunctions } from "../ir/integration.js";
import { irVal, type IrType } from "../ir/nodes.js";
import { buildTypeMap, type LatticeType } from "../ir/propagate.js";
import { planIrCompilation } from "../ir/select.js";
import { createCodegenContext } from "./context/create-context.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import type {
  ClosureInfo,
  CodegenContext,
  CodegenOptions,
  ExternClassInfo,
  FunctionContext,
  OptionalParamInfo,
} from "./context/types.js";
import type { NodeBuiltinImport } from "../import-resolver.js";
import { eliminateDeadImports } from "./dead-elimination.js";
import { emitUndefined } from "./expressions/late-imports.js";
import {
  fixupExternConvertAny,
  fixupStructNewArgCounts,
  fixupStructNewResultCoercion,
  markLeafStructsFinal,
  repairStructTypeMismatches,
} from "./fixups.js";
import { emitInlineMathFunctions } from "./math-helpers.js";
import { peepholeOptimize } from "./peephole.js";
import { addImport, addStringConstantGlobal } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { registerAddStringImports } from "./shared.js";
import { stackBalance } from "./stack-balance.js";

// ── Extracted sub-modules ──────────────────────────────────────────────────
import {
  emitWrapperValueOfFunctions,
  ensureAnyHelpers,
  ensureAnyValueType,
  ensureWrapperTypes,
  isAnyValue,
} from "./any-helpers.js";
import {
  buildShapePropFlagsTable,
  collectClassDeclaration,
  collectDeclaredFuncRefs,
  compileClassBodies,
} from "./class-bodies.js";
import {
  applyShapeInference,
  collectDeclarations,
  inferNumericReturnTypes,
  collectEmptyObjectWidening,
  compileDeclarations,
  createUnifiedCollectorState,
  finalizeUnifiedCollector,
  unifiedVisitNode,
} from "./declarations.js";
import { destructureParamArray, destructureParamObject } from "./destructuring-params.js";
import {
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  flatStringType,
  nativeStringType,
  nativeStringTypeNullable,
} from "./native-strings.js";

// ── Re-exports for public API compatibility ─────────────────────────────────
export {
  collectClassDeclaration,
  compileClassBodies,
  destructureParamArray,
  destructureParamObject,
  ensureAnyHelpers,
  ensureAnyValueType,
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureWrapperTypes,
  flatStringType,
  isAnyValue,
  nativeStringType,
  nativeStringTypeNullable,
};
/**
 * Report a codegen error with source location extracted from an AST node.
 * Pushes the error into ctx.errors so it can be propagated to the caller.
 */
/**
 * Extract a compile-time constant from a parameter initializer (#869).
 * Returns the constant default info if the initializer is a numeric/boolean literal,
 * undefined/null, or a unary minus on a numeric literal. Returns undefined otherwise.
 */
function sourceContainsClass(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

export function extractConstantDefault(
  initializer: ts.Expression,
  paramType: ValType,
): OptionalParamInfo["constantDefault"] {
  if (paramType.kind === "f64") {
    if (ts.isNumericLiteral(initializer)) {
      return { kind: "f64", value: Number(initializer.text) };
    }
    // true/false → 1/0 in f64 context
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: "f64", value: 1 };
    }
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "f64", value: 0 };
    }
    // undefined → NaN in f64 context
    if (
      initializer.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(initializer) && initializer.text === "undefined")
    ) {
      return { kind: "f64", value: NaN };
    }
    // null → 0 in f64 context
    if (initializer.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: "f64", value: 0 };
    }
    // Unary minus: -42
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "f64", value: -Number(initializer.operand.text) };
    }
    // Unary plus: +42
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.PlusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "f64", value: Number(initializer.operand.text) };
    }
    return undefined;
  }
  if (paramType.kind === "i32") {
    if (ts.isNumericLiteral(initializer)) {
      return { kind: "i32", value: Number(initializer.text) | 0 };
    }
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: "i32", value: 1 };
    }
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "i32", value: 0 };
    }
    if (
      initializer.kind === ts.SyntaxKind.NullKeyword ||
      initializer.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(initializer) && initializer.text === "undefined")
    ) {
      return { kind: "i32", value: 0 };
    }
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "i32", value: -Number(initializer.operand.text) | 0 };
    }
    return undefined;
  }
  // For ref types (externref, ref_null, etc.), constant defaults not supported yet
  return undefined;
}

/**
 * Lift a propagated lattice type into the backend IrType used by the IR
 * lowerer. Only concrete primitives are valid here; the caller must have
 * ensured the lattice entry is `f64` or `bool`. Non-primitive entries
 * throw — the caller should guard with `isConcreteLattice` first.
 */
function latticeToIr(t: LatticeType): IrType {
  if (t.kind === "f64") return irVal({ kind: "f64" });
  if (t.kind === "bool") return irVal({ kind: "i32" });
  // #1169a — strings flow as the backend-agnostic `IrType.string`; the
  // resolver picks the concrete Wasm representation at lowering time.
  if (t.kind === "string") return { kind: "string" };
  throw new Error(`latticeToIr: non-primitive lattice type ${t.kind}`);
}

function isConcreteLattice(t: LatticeType | undefined): t is LatticeType & { kind: "f64" | "bool" | "string" } {
  return t !== undefined && (t.kind === "f64" || t.kind === "bool" || t.kind === "string");
}

/**
 * Resolve the IR type for a function's param or return position, using
 * the AST's explicit TypeNode first (authoritative) and the TypeMap
 * lattice entry only as a fallback. If neither yields a concrete
 * primitive (or, slice 2, a representable object shape) this is a
 * selector bug — throw so the caller can skip the function and fall
 * through to legacy.
 *
 * #1169b widens this to accept TypeLiteral / TypeReference TypeNodes
 * by deriving an `IrType.object` from the TS checker. Shapes that the
 * resolver can't faithfully represent (callable types, methods,
 * non-primitive non-object fields, empty objects) cause the helper to
 * return `null`; the caller then throws so the function falls back to
 * the legacy path.
 */
function resolvePositionType(
  node: ts.TypeNode | undefined,
  mapped: LatticeType | undefined,
  ctx: CodegenContext,
  classShapes?: ReadonlyMap<string, import("../ir/nodes.js").IrClassShape>,
): IrType {
  if (node) {
    if (node.kind === ts.SyntaxKind.NumberKeyword) return irVal({ kind: "f64" });
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return irVal({ kind: "i32" });
    if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
    // Slice 6 part 2 (#1181) — array type (T[] or Array<T>) resolves to a
    // vec ref. The legacy `getOrRegisterVecType` produces the same
    // (ref_null $vec_<elem>) struct ref the for-of vec fast path needs,
    // and the IR resolver's `resolveVec` (in integration.ts) reads the
    // struct shape back to recover element ValType. Numeric / boolean /
    // string element types are accepted; nested-vec or object-element
    // types throw and fall back to legacy.
    if (ts.isArrayTypeNode(node)) {
      const elemIr = resolvePositionType(node.elementType, undefined, ctx, classShapes);
      const elemVal =
        elemIr.kind === "val" ? elemIr.val : elemIr.kind === "string" ? ({ kind: "externref" } as ValType) : null;
      if (!elemVal) {
        throw new Error(
          `array element TypeNode ${ts.SyntaxKind[node.elementType.kind]} could not be lowered to a primitive ValType`,
        );
      }
      const elemKey =
        elemVal.kind === "ref" || elemVal.kind === "ref_null"
          ? `ref_${(elemVal as { typeIdx: number }).typeIdx}`
          : elemVal.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemVal);
      return irVal({ kind: "ref_null", typeIdx: vecIdx });
    }
    if (ts.isTypeLiteralNode(node) || ts.isTypeReferenceNode(node)) {
      // Slice 4 (#1169d) — TypeReferenceNode that names a local class
      // resolves to `IrType.class`. The classShapes registry is seeded
      // by `buildIrClassShapes` from the legacy class registry before
      // the IR runs. Take this path FIRST: classes also satisfy the
      // generic `objectIrTypeFromTsType` heuristic (they're "Object"
      // type-flag types), so without the explicit class detection we'd
      // fall into the data-object path, which doesn't carry method or
      // constructor info.
      if (classShapes && ts.isTypeReferenceNode(node)) {
        const ref = node.typeName;
        if (ts.isIdentifier(ref)) {
          const cs = classShapes.get(ref.text);
          if (cs) return { kind: "class", shape: cs };
        }
      }
      // Slice 6 part 2 (#1181) — `Array<T>` TypeReferenceNode resolves
      // to a vec ref, parallel to the `T[]` ArrayTypeNode arm above.
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "Array") {
        const typeArgs = node.typeArguments;
        if (typeArgs && typeArgs.length === 1) {
          const elemIr = resolvePositionType(typeArgs[0]!, undefined, ctx, classShapes);
          const elemVal =
            elemIr.kind === "val" ? elemIr.val : elemIr.kind === "string" ? ({ kind: "externref" } as ValType) : null;
          if (!elemVal) {
            throw new Error(
              `Array<T> element TypeNode ${ts.SyntaxKind[typeArgs[0]!.kind]} could not be lowered to a primitive ValType`,
            );
          }
          const elemKey =
            elemVal.kind === "ref" || elemVal.kind === "ref_null"
              ? `ref_${(elemVal as { typeIdx: number }).typeIdx}`
              : elemVal.kind;
          const vecIdx = getOrRegisterVecType(ctx, elemKey, elemVal);
          return irVal({ kind: "ref_null", typeIdx: vecIdx });
        }
      }
      // Slice 6 part 3 (#1182) — built-in generic iterables (Map / Set /
      // WeakMap / WeakSet / Iterable / Iterator / Generator / Async*).
      // These all have host-managed runtime representations and the IR
      // doesn't model their internal structure; treat them as opaque
      // externref values. The IR's iter-host arm of `lowerForOfStatement`
      // accepts externref iterables and routes them through the
      // `__iterator` host import.
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const name = node.typeName.text;
        if (
          name === "Map" ||
          name === "Set" ||
          name === "WeakMap" ||
          name === "WeakSet" ||
          name === "Iterable" ||
          name === "Iterator" ||
          name === "IterableIterator" ||
          name === "Generator" ||
          name === "AsyncIterable" ||
          name === "AsyncIterator" ||
          name === "AsyncGenerator"
        ) {
          return irVal({ kind: "externref" });
        }
      }
      const tsType = ctx.checker.getTypeFromTypeNode(node);
      const ir = objectIrTypeFromTsType(ctx, tsType);
      if (ir) return ir;
      throw new Error(`object TypeNode ${ts.SyntaxKind[node.kind]} could not be lowered to IrType.object`);
    }
    throw new Error(`unsupported TypeNode kind ${ts.SyntaxKind[node.kind]}`);
  }
  if (isConcreteLattice(mapped)) return latticeToIr(mapped);
  if (mapped?.kind === "object") {
    // The lattice carries a shape string but not the concrete field
    // list, so we can't reconstruct an IrType.object from it alone.
    // The selector accepts at the kind level; we need an explicit
    // TypeNode for shape evidence in slice 2.
    throw new Error(`object position type without explicit annotation — needs TypeNode in slice 2`);
  }
  throw new Error(`no concrete type (mapped=${mapped?.kind ?? "missing"})`);
}

/**
 * Convert a TypeScript object type to an `IrType.object` shape.
 * Returns `null` if the type isn't a plain "data" object — methods,
 * getters, callable types, external declared classes, tuples, and
 * shapes containing fields the IR can't represent fall back to legacy.
 *
 * Field names are sorted into canonical (ascending) order to match
 * the `IrObjectShape` invariant.
 */
function objectIrTypeFromTsType(ctx: CodegenContext, tsType: ts.Type): IrType | null {
  if (!(tsType.flags & ts.TypeFlags.Object)) return null;
  if (tsType.getCallSignatures().length > 0) return null; // callable
  if (isExternalDeclaredClass(tsType, ctx.checker)) return null;
  if (isTupleType(tsType)) return null;

  const props = tsType.getProperties();
  if (props.length === 0) return null; // empty object — defer to a future slice

  const fields: { name: string; type: IrType }[] = [];
  for (const prop of props) {
    const decl = prop.valueDeclaration;
    if (
      decl &&
      (ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl))
    ) {
      return null;
    }
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const fieldIr = tsTypeToFieldIr(ctx, propType);
    if (!fieldIr) return null;
    fields.push({ name: prop.name, type: fieldIr });
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "object", shape: { fields } };
}

/**
 * Field-type subset for object shapes: primitives + nested objects +
 * strings. Anything else (any/unknown/union/array/etc.) returns null,
 * which causes `objectIrTypeFromTsType` to bail and the function to
 * fall back to legacy.
 */
function tsTypeToFieldIr(ctx: CodegenContext, t: ts.Type): IrType | null {
  if (t.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (t.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32" });
  if (t.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  if (t.flags & ts.TypeFlags.Object) return objectIrTypeFromTsType(ctx, t);
  return null;
}

/**
 * Slice 4 (#1169d): build the per-class IR shape registry from the
 * legacy class collection state. Only top-level `ts.ClassDeclaration`
 * nodes are included (no class expressions, no nested-in-function
 * classes — same scope as the IR selector's `localClasses` set).
 *
 * The returned map carries:
 *   - `fields`: user-visible struct fields in canonical (alphabetical)
 *               order. The legacy `__tag` prefix is stripped here so
 *               consumers see only TS-source-level fields. The IR's
 *               `IrType.class` doesn't expose the tag; the resolver
 *               accounts for it when computing Wasm field indices.
 *   - `methods`: instance methods only (no static methods). Their
 *                signatures come from the legacy method func's typeIdx
 *                in the WasmGC type registry, but here we re-derive
 *                from the AST so the IR types are symbolic / shape-
 *                preserving (matching what `resolvePositionType` does
 *                for top-level functions).
 *   - `constructorParams`: the constructor's user-visible param list,
 *                          re-derived from the AST.
 *
 * Classes whose constructor or any field/method type can't be lowered
 * to a representable IrType are SKIPPED — the IR selector can still
 * accept the class name as a TypeReference, but `resolvePositionType`
 * will throw when the missing shape forces a fallback. That mirrors
 * the slice 2 / slice 3 behavior: best-effort acceptance with a clean
 * legacy fallback for unrepresentable shapes.
 */
function buildIrClassShapes(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): Map<string, import("../ir/nodes.js").IrClassShape> {
  const out = new Map<string, import("../ir/nodes.js").IrClassShape>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    if (stmt.heritageClauses && stmt.heritageClauses.length > 0) continue; // slice 4 defers inheritance
    const className = stmt.name.text;
    if (!ctx.classSet.has(className)) continue;
    if (!ctx.structFields.has(className)) continue;

    // Constructor params — re-derived from AST so types come through
    // the same `tsTypeToFieldIr`-style projection. Reject if any param
    // has a non-representable type (e.g. union, function, generic).
    const ctor = stmt.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
    const constructorParams: IrType[] = [];
    let ctorOk = true;
    if (ctor) {
      for (const p of ctor.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
          ctorOk = false;
          break;
        }
        const tsType = ctx.checker.getTypeAtLocation(p);
        const ir = tsTypeToClassPositionIr(ctx, tsType, out);
        if (!ir) {
          ctorOk = false;
          break;
        }
        constructorParams.push(ir);
      }
    }
    if (!ctorOk) continue;

    // Fields — read from the legacy `structFields` (already includes
    // type info that the IR cares about). Strip the `__tag` prefix and
    // map each remaining field's ValType back to an IrType. If any
    // field type can't be projected (e.g. tagged-union ref), skip the
    // whole class.
    const legacyFields = ctx.structFields.get(className)!;
    const fields: { name: string; type: IrType }[] = [];
    let fieldsOk = true;
    for (const f of legacyFields) {
      if (f.name === "__tag") continue;
      const ir = valTypeToIrField(ctx, f.type);
      if (!ir) {
        fieldsOk = false;
        break;
      }
      fields.push({ name: f.name, type: ir });
    }
    if (!fieldsOk) continue;
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Methods — instance methods only, re-derived from the AST.
    const methods: { name: string; params: IrType[]; returnType: IrType | null }[] = [];
    let methodsOk = true;
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      if (hasStaticModifier(member)) continue; // slice 4 defers static methods
      if (hasAbstractModifier(member)) continue;
      if (!ts.isIdentifier(member.name)) continue; // computed names → defer
      if (member.asteriskToken) continue; // generators → defer
      const methodName = member.name.text;
      const params: IrType[] = [];
      for (const p of member.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
          methodsOk = false;
          break;
        }
        const tsType = ctx.checker.getTypeAtLocation(p);
        const ir = tsTypeToClassPositionIr(ctx, tsType, out);
        if (!ir) {
          methodsOk = false;
          break;
        }
        params.push(ir);
      }
      if (!methodsOk) break;
      // Return type — null for void (matches IrClassMethodDescriptor).
      let returnType: IrType | null = null;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const retTs = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retTs)) {
          const ir = tsTypeToClassPositionIr(ctx, retTs, out);
          if (!ir) {
            methodsOk = false;
            break;
          }
          returnType = ir;
        }
      }
      methods.push({ name: methodName, params, returnType });
    }
    if (!methodsOk) continue;

    out.set(className, {
      className,
      fields,
      methods,
      constructorParams,
    });
  }
  return out;
}

/**
 * Slice 4 (#1169d): project a TypeScript type that appears in a class
 * member position (constructor param, method param, method return,
 * field) into an IrType. Returns `null` if the type isn't
 * representable — the caller skips the whole class in that case.
 *
 * Recognises:
 *   - primitives (number → f64, boolean → i32, string)
 *   - object shapes via `objectIrTypeFromTsType`
 *   - other locally-declared classes (forward references resolve
 *     against the in-progress `out` map; cross-class self-references
 *     come back as the class's own shape after a single pass)
 */
function tsTypeToClassPositionIr(
  ctx: CodegenContext,
  t: ts.Type,
  classShapes: ReadonlyMap<string, import("../ir/nodes.js").IrClassShape>,
): IrType | null {
  if (t.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (t.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32" });
  if (t.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  // Class type — resolved by symbol name.
  const sym = t.getSymbol();
  if (sym) {
    const cs = classShapes.get(sym.name);
    if (cs) return { kind: "class", shape: cs };
  }
  if (t.flags & ts.TypeFlags.Object) {
    const ir = objectIrTypeFromTsType(ctx, t);
    if (ir) return ir;
  }
  return null;
}

/**
 * Slice 4 (#1169d): map a legacy `ValType` (already lowered to Wasm)
 * back to an IrType for a class field descriptor. Used so the IR's
 * field-type discriminator stays consistent with what the legacy
 * struct emits.
 *
 * Conservative: only primitives + ref types pass. Ref types lower to
 * `IrType.val` carrying the same Wasm typeIdx — works for both
 * class-instance fields (typeIdx points at another class struct) and
 * anonymous struct fields. Field reads against these types return
 * `(ref $...)` values which the IR can compose with subsequent
 * operations only via the surrounding class.get / class.set; that's
 * fine for slice 4's surface.
 */
function valTypeToIrField(_ctx: CodegenContext, vt: import("../ir/types.js").ValType): IrType | null {
  if (vt.kind === "f64" || vt.kind === "i32") return irVal(vt);
  // Slice 4 defers `string`-typed class fields exposed as externref or
  // (ref $AnyString) — the IR's `IrType.string` is backend-agnostic
  // but the legacy `structFields` already commits to a backend ValType
  // (externref/ref). Returning null here lets the class fall back to
  // legacy if it has string fields.
  return null;
}

/** Compile a typed AST into a WasmModule IR */
export function generateModule(
  ast: TypedAST,
  options?: CodegenOptions,
): {
  module: WasmModule;
  errors: { message: string; line: number; column: number; severity?: "error" | "warning" }[];
} {
  const mod = createEmptyModule();
  const ctx = createCodegenContext(mod, ast.checker, options);
  try {
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, ast.sourceFile);
    }

    // $AnyValue struct type is now registered lazily via ensureAnyValueType()

    // Note: console imports handled by unified collector (skipped in WASI mode via registerWasiImports)
    // First pass: collect declare namespaces (registers imports before local funcs)
    collectExternDeclarations(ctx, ast.sourceFile);

    // WASI target: check for DOM-only globals and emit compile errors
    if (ctx.wasi) {
      checkWasiDomUsage(ctx, ast.sourceFile);
    }

    // Scan lib files for DOM extern classes + globals (only if user code uses DOM)
    // After lib.d.ts refactoring, TS loads individual lib files (lib.es5.d.ts, etc.)
    if (sourceUsesLibGlobals(ast.sourceFile)) {
      for (const sf of ast.program.getSourceFiles()) {
        const baseName = sf.fileName.split("/").pop() ?? sf.fileName;
        if (baseName.startsWith("lib.") && baseName.endsWith(".d.ts")) {
          collectExternDeclarations(ctx, sf);
          collectDeclaredGlobals(ctx, sf, ast.sourceFile);
        }
      }
    }

    // Register built-in collection types as extern classes if not already collected from lib files
    registerBuiltinExternClasses(ctx);

    // #1044 — Register Node builtin modules as externref host imports
    if (options?.nodeBuiltins && options.nodeBuiltins.length > 0) {
      registerNodeBuiltinImports(ctx, options.nodeBuiltins);
    }

    // Pre-pass: detect empty object literals that get properties assigned later
    // Must run before import collectors so that widened types are known
    collectEmptyObjectWidening(ctx, ast.checker, ast.sourceFile);

    // Register only the extern class imports actually used in source code
    collectUsedExternImports(ctx, ast.sourceFile);

    // Single-pass collection of all source imports (#592):
    // console, primitives, string literals, string methods, Math, parseInt/parseFloat,
    // String.fromCharCode, Promise, JSON, callbacks, functional array methods,
    // union types, generators, iterators, for-in/in-expr/Object.keys string literals,
    // wrapper constructors, unknown constructor imports.
    collectAllSourceImports(ctx, ast.sourceFile);

    // #1047 — register __register_prototype host import before any local function
    // is created so `emitLazyProtoGet` can look it up from funcMap without
    // triggering late-import index shifts mid-expression compilation.
    if (sourceContainsClass(ast.sourceFile)) {
      const regProtoTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_prototype", { kind: "func", typeIdx: regProtoTypeIdx });
    }

    // Emit inline Wasm implementations for Math methods (after all imports are registered)
    if (ctx.pendingMathMethods.size > 0) {
      emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
    }

    // Emit __toUint32 Wasm helper after all imports registered (bypasses bug
    // where direct addImport calls do not shift defined-function indices).
    emitToUint32Helper(ctx);

    // Emit wrapper valueOf functions (after all imports registered, before user funcs)
    emitWrapperValueOfFunctions(ctx);

    // #1121: Pre-compute return-type inference for recursive numeric kernels
    // (e.g. unannotated `function fib(n) { ... }`). This runs BEFORE
    // collectDeclarations so the inferred f64 return shows up directly in
    // the function's signature instead of being patched after the fact.
    ctx.numericReturnTypes = inferNumericReturnTypes(ctx, ast.sourceFile);

    // Second pass: collect all function declarations and interfaces
    collectDeclarations(ctx, ast.sourceFile);

    // Shape inference: detect array-like variables and override their types
    applyShapeInference(ctx, ast.checker, ast.sourceFile);

    // Third pass: compile function bodies
    compileDeclarations(ctx, ast.sourceFile);

    // Experimental IR path: for functions selected by `planIrCompilation`,
    // rebuild their bodies via the middle-end IR (AST → IR → Wasm). Runs
    // AFTER `compileDeclarations` so the symbolic-ref resolver sees final
    // funcIdx / globalIdx / typeIdx assignments — this is what makes
    // `shiftLateImportIndices` a no-op for IR-path bodies.
    //
    // Phase 2: the TypeMap is computed from `buildTypeMap`, which runs
    // context-insensitive interprocedural propagation across the source
    // file's call graph. That's what lets a recursive `fib` whose param
    // is untyped in source compile as `(f64) -> f64` when a typed caller
    // (e.g. `run(n: number)`) flows `number` into it. The selector then
    // uses the TypeMap to decide which functions to claim, and closes
    // the claim set under call-graph edges so the IR path never emits a
    // cross-signature `call` against a legacy-compiled callee.
    if (options?.experimentalIR) {
      const typeMap = buildTypeMap(ast.sourceFile, ast.checker);
      const selection = planIrCompilation(ast.sourceFile, { experimentalIR: true }, typeMap);
      // Slice 4 (#1169d) — build the class-shape registry from the
      // legacy class collection (`ctx.classSet`, `ctx.structFields`,
      // `ctx.funcMap`). Done BEFORE override resolution so class-typed
      // positions (`p: Point`) lower to `IrType.class` rather than
      // throwing in `resolvePositionType`.
      const classShapes = buildIrClassShapes(ctx, ast.sourceFile);
      // Build per-function IR type overrides from the propagated TypeMap.
      //
      // For a claimed function, the selector must have resolved each
      // param + return to a concrete primitive via either an explicit
      // TS annotation OR the TypeMap. We mirror that resolution here to
      // build the override map: for each position, prefer the AST
      // annotation (authoritative) and fall back to the TypeMap only
      // when the AST lacks one. If neither yields a concrete primitive,
      // that position is a compiler bug — the selector should not have
      // claimed this function.
      //
      // The override map also feeds the `calleeTypes` in the lowerer so
      // direct calls to IR-path callees see the right signature.
      const overrideMap = new Map<string, { params: IrType[]; returnType: IrType }>();
      const declByName = new Map<string, ts.FunctionDeclaration>();
      for (const stmt of ast.sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name) declByName.set(stmt.name.text, stmt);
      }
      for (const name of selection.funcs) {
        const fn = declByName.get(name);
        if (!fn) continue;
        const entry = typeMap.get(name);
        try {
          const returnType = resolvePositionType(fn.type, entry?.returnType, ctx, classShapes);
          const params: IrType[] = [];
          for (let i = 0; i < fn.parameters.length; i++) {
            const p = fn.parameters[i]!;
            params.push(resolvePositionType(p.type, entry?.params[i], ctx, classShapes));
          }
          overrideMap.set(name, { params, returnType });
        } catch (e) {
          // Selector claimed a function whose types can't be resolved —
          // skip the IR path for this one. Fall through to legacy.
          reportErrorNoNode(
            ctx,
            `IR path: could not resolve types for ${name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      // Only request IR compilation for functions we successfully built
      // overrides for (the selector may have claimed more, but if we
      // couldn't map types safely we leave them to legacy).
      const safeSelection = {
        funcs: new Set<string>([...selection.funcs].filter((n) => overrideMap.has(n))),
      };
      const report = compileIrPathFunctions(ctx, ast.sourceFile, safeSelection, overrideMap, classShapes);
      for (const err of report.errors) {
        reportErrorNoNode(ctx, `IR path failed for ${err.func}: ${err.message}`);
      }
    }

    // Fixup pass: reconcile struct.new argument counts with actual struct field counts.
    // Dynamic field additions during expression compilation can add fields to struct types
    // after the constructor's struct.new was already emitted (#516).
    fixupStructNewArgCounts(ctx);

    // Fixup pass: insert extern.convert_any after struct.new when the result
    // is stored into an externref local/global.
    fixupStructNewResultCoercion(ctx);

    // Build per-shape default property flags table for all user-visible structs
    buildShapePropFlagsTable(ctx);

    // Collect ref.func targets so the binary emitter can add a declarative element segment
    collectDeclaredFuncRefs(ctx);

    // Resolve deferred `export default <variable>` for module globals (#1108).
    // Must run AFTER compileDeclarations — string-constant imports added during
    // body compilation shift numImportGlobals, so indices aren't final until now.
    if (ctx.deferredDefaultGlobalExport) {
      const varName = ctx.deferredDefaultGlobalExport;
      const globalName = `__mod_${varName}`;
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === globalName);
      if (localIdx >= 0) {
        const absIdx = ctx.numImportGlobals + localIdx;
        const alreadyExported = ctx.mod.exports.some(
          (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
        );
        if (!alreadyExported) {
          ctx.mod.exports.push({ name: "default", desc: { kind: "global", index: absIdx } });
          ctx.mod.exports.push({ name: varName, desc: { kind: "global", index: absIdx } });
        }
      }
      ctx.deferredDefaultGlobalExport = undefined;
    }

    // Copy metadata for .d.ts / helper generation — only include actually-used extern classes
    const importNames = mod.imports.map((imp) => imp.name);
    for (const [key, info] of ctx.externClasses) {
      const prefix = `${info.importPrefix}_`;
      const isUsed = importNames.some((n) => n.startsWith(prefix));
      if (key === info.className && isUsed) {
        mod.externClasses.push({
          importPrefix: info.importPrefix,
          namespacePath: info.namespacePath,
          className: info.className,
          constructorParams: info.constructorParams,
          methods: info.methods,
          properties: info.properties,
        });
      }
    }
    mod.stringLiteralValues = ctx.stringLiteralValues;
    mod.asyncFunctions = ctx.asyncFunctions;

    // Emit exported struct field getter helpers for the runtime.
    // These allow JS host imports to read WasmGC struct fields that are
    // otherwise opaque to JS (V8 returns undefined for direct property access).
    emitStructFieldGetters(ctx);

    // Emit __vec_get / __vec_len exports for runtime iterator fallback on WasmGC arrays
    emitVecAccessExports(ctx);

    // Emit __dv_byte_{len,get,set} exports so the runtime can implement
    // DataView.prototype.{get,set}{Uint,Int,Float}* on i32_byte vec structs (#1056)
    emitDataViewByteExports(ctx);

    // Emit __call_@@iterator export for runtime Symbol.iterator dispatch on WasmGC structs
    emitIteratorMethodExport(ctx);

    // Emit __call_fn_0 export for calling zero-arg closures from JS (#851)
    emitClosureCallExport(ctx);

    // Emit __call_fn_1 export for calling one-arg closures from JS (#1090)
    emitClosureCallExport1(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch (#866)
    emitToPrimitiveMethodExports(ctx);

    // WASI: export _start entry point (before dead import elimination adjusts indices)
    if (ctx.wasi) {
      addWasiStartExport(ctx);
    }

    // Export the exception tag so the exec worker can extract thrown payloads
    // via WebAssembly.Exception.getArg(tag, 0).
    if (ctx.exnTagIdx >= 0) {
      const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;
      mod.exports.push({
        name: "__exn_tag",
        desc: { kind: "tag", index: numImportTags + ctx.exnTagIdx },
      });
    }

    // Mark leaf struct types as final for V8 devirtualization (#594).
    // Skipped for `--target wasi` so that downstream `wasm-opt --all-features`
    // does not convert refs to those types into `(ref exact $T)`, which
    // wasmtime ≤ 44 rejects (#1173).
    markLeafStructsFinal(mod, ctx.wasi);

    // Dead import and type elimination pass
    eliminateDeadImports(mod);

    // Repair struct.get/struct.set type mismatches (externref → struct ref conversion)
    repairStructTypeMismatches(mod);

    // Peephole optimization: remove redundant ref.as_non_null after ref.cast, etc.
    peepholeOptimize(mod);

    // Stack-balancing fixup: ensure all branches in if/try/block have matching stack states
    stackBalance(mod);

    // Late fixup: repair extern.convert_any applied to non-anyref values.
    // Must run after all other passes since they can introduce invalid coercions.
    fixupExternConvertAny(ctx);
  } catch (e) {
    reportErrorNoNode(ctx, `Codegen error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { module: mod, errors: ctx.errors };
}

/** Add a _start export for WASI — wraps __module_init or a no-arg main() (#1122) */
function addWasiStartExport(ctx: CodegenContext): void {
  // Prefer __module_init — it's always () -> void and handles all top-level code
  let targetIdx: number | undefined;
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    if (ctx.mod.functions[i]!.name === "__module_init") {
      targetIdx = ctx.numImportFuncs + i;
      break;
    }
  }

  // Fall back to main only if __module_init doesn't exist AND main is () -> void
  if (targetIdx === undefined) {
    const mainIdx = ctx.funcMap.get("main");
    if (mainIdx !== undefined) {
      // Check that the function takes no parameters and returns no values
      const funcArrayIdx = mainIdx - ctx.numImportFuncs;
      if (funcArrayIdx >= 0 && funcArrayIdx < ctx.mod.functions.length) {
        const func = ctx.mod.functions[funcArrayIdx]!;
        const funcType = ctx.mod.types[func.typeIdx];
        if (funcType && funcType.kind === "func" && funcType.params.length === 0 && funcType.results.length === 0) {
          targetIdx = mainIdx;
        }
      }
    }
  }

  if (targetIdx !== undefined) {
    // Create _start wrapper that calls the target function
    const startTypeIdx = addFuncType(ctx, [], [], "$wasi_start_type");
    const startFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    const body: Instr[] = [{ op: "call", funcIdx: targetIdx }];

    ctx.mod.functions.push({
      name: "_start",
      typeIdx: startTypeIdx,
      locals: [],
      body,
      exported: true,
    });

    ctx.mod.exports.push({
      name: "_start",
      desc: { kind: "func", index: startFuncIdx },
    });
  }
}

/**
 * Emit exported getter/setter helper functions so the JS runtime can read
 * WasmGC struct fields that are otherwise opaque to JavaScript.
 *
 * For each unique field name across all struct types, we emit:
 *   __sget_<name>(externref) -> externref
 * The function converts the externref to anyref, tries ref.test for each
 * struct type that has that field, extracts the field via struct.get,
 * and converts the result to externref.
 *
 * Numeric fields (f64, i32) are boxed via __box_number import.
 * Ref/ref_null fields are converted via extern.convert_any.
 * The runtime discovers these exports and uses them as fallback when
 * direct JS property access on a WasmGC struct returns undefined.
 */
function emitStructFieldGetters(ctx: CodegenContext): void {
  try {
    _emitStructFieldGettersInner(ctx);
  } catch (e: any) {
    // Non-fatal: if getter emission fails, the module still works
    // (the runtime just can't read struct fields from JS)
  }
}

function _emitStructFieldGettersInner(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect all (fieldName → [{structTypeIdx, fieldIdx, fieldType}]) mappings
  const fieldMap = new Map<string, { typeIdx: number; fieldIdx: number; fieldType: ValType }[]>();

  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    // Skip internal/wrapper types
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field || !field.type) continue;
      // Skip fields with names that would create invalid export names
      if (!field.name || field.name.startsWith("$")) continue;

      let entries = fieldMap.get(field.name);
      if (!entries) {
        entries = [];
        fieldMap.set(field.name, entries);
      }
      entries.push({ typeIdx, fieldIdx: i, fieldType: field.type });
    }
  }

  if (fieldMap.size === 0) return;

  // Find __box_number import for numeric boxing (may be undefined)
  const boxNumIdx = ctx.funcMap.get("__box_number");

  // Two getter types: one for externref result, one for f64 result
  const getterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$sget_extern_type");
  const getterF64TypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$sget_f64_type");
  const getterI32TypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$sget_i32_type");

  for (const [fieldName, entries] of fieldMap) {
    // Determine the "best" return type — if all entries for this field are
    // the same kind we can use a specific return type; if mixed, use externref.
    const hasF64 = entries.some((e) => e.fieldType.kind === "f64");
    const hasI32 = entries.some((e) => e.fieldType.kind === "i32");
    const hasRef = entries.some((e) => e.fieldType.kind !== "f64" && e.fieldType.kind !== "i32");
    const allF64 = hasF64 && !hasI32 && !hasRef;
    const allI32 = hasI32 && !hasF64 && !hasRef;

    let getterTypeIdx: number;
    let returnMode: "extern" | "f64" | "i32";
    if (allF64) {
      getterTypeIdx = getterF64TypeIdx;
      returnMode = "f64";
    } else if (allI32) {
      getterTypeIdx = getterI32TypeIdx;
      returnMode = "i32";
    } else {
      getterTypeIdx = getterExternTypeIdx;
      returnMode = "extern";
    }

    const funcName = `__sget_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 1; // first local after params (local 0 = externref param)

    const funcBody = buildNestedIfElse(entries, anyLocal, boxNumIdx, returnMode);

    mod.functions.push({
      name: funcName,
      typeIdx: getterTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body: funcBody,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: funcName,
      desc: { kind: "func", index: funcIdx },
    });
  }

  // Emit __struct_field_names(externref) -> externref
  // Returns a comma-separated string of field names for the struct type of the argument.
  // The runtime uses this for Object.keys(), JSON.stringify(), for-in, and spread on opaque structs.
  emitStructFieldNamesExport(ctx, fieldMap);
}

/**
 * Emit a __struct_field_names(externref) -> externref export.
 * For each struct type, ref.test and return a string constant with comma-separated field names.
 * Falls back to ref.null.extern for non-struct values.
 */
function emitStructFieldNamesExport(
  ctx: CodegenContext,
  fieldMap: Map<string, { typeIdx: number; fieldIdx: number; fieldType: ValType }[]>,
): void {
  // The __struct_field_names export is only consumed by a JS host runtime
  // (Object.keys / JSON.stringify / for-in introspection of opaque WasmGC
  // structs). In nativeStrings mode (auto-on for `--target wasi`) there is no
  // JS host, so the export is dead code AND its body uses `global.get` of a
  // string_constants global to push the comma-separated field names — which
  // forces a `string_constants::a,b,c` host import that fails to instantiate
  // under wasmtime (#1174). Skip emission in nativeStrings mode.
  if (ctx.nativeStrings) return;

  const mod = ctx.mod;

  // Build per-struct-type field name lists (excluding internal fields)
  const structFieldNameMap = new Map<number, string[]>(); // typeIdx -> field names
  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;

    const names: string[] = [];
    for (const field of fields) {
      if (!field || !field.type || !field.name) continue;
      if (field.name.startsWith("$") || field.name.startsWith("__")) continue;
      names.push(field.name);
    }
    if (names.length > 0) {
      structFieldNameMap.set(typeIdx, names);
    }
  }

  if (structFieldNameMap.size === 0) return;

  // Register comma-separated field name strings as string constants
  const typeIdxToGlobalIdx = new Map<number, number>();
  for (const [typeIdx, names] of structFieldNameMap) {
    const csv = names.join(",");
    addStringConstantGlobal(ctx, csv);
    const globalIdx = ctx.stringGlobalMap.get(csv);
    if (globalIdx !== undefined) {
      typeIdxToGlobalIdx.set(typeIdx, globalIdx);
    }
  }

  // Build the function body: chain of ref.test / if-else returning the right string
  const getterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$sfnames_type");
  const anyLocal = 1; // local 0 = externref param, local 1 = anyref conversion

  const body: Instr[] = [];
  // Convert externref to anyref
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Build nested if-else chain
  let fallback: Instr[] = [{ op: "ref.null.extern" } as Instr];
  const typeEntries = [...typeIdxToGlobalIdx.entries()];

  for (let i = typeEntries.length - 1; i >= 0; i--) {
    const [typeIdx, globalIdx] = typeEntries[i]!;
    const thenBranch: Instr[] = [{ op: "global.get", index: globalIdx } as Instr];

    const ifInstr: Instr = {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: thenBranch,
      else: fallback,
    } as unknown as Instr;

    fallback = [{ op: "local.get", index: anyLocal } as Instr, { op: "ref.test", typeIdx } as Instr, ifInstr];
  }

  body.push(...fallback);

  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  mod.functions.push({
    name: "__struct_field_names",
    typeIdx: getterExternTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__struct_field_names",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * Emit exported method dispatch functions for the iterator protocol:
 * - __call_@@iterator(externref) -> externref — calls [Symbol.iterator]() on structs
 * - __call_next(externref) -> externref — calls .next() on iterator structs
 *
 * These allow the runtime to invoke WasmGC struct methods that are opaque to JS.
 */
function emitIteratorMethodExport(ctx: CodegenContext): void {
  // Only emit if the iterator imports are registered (i.e., for-of on non-array types)
  if (!ctx.funcMap.has("__iterator") && !ctx.funcMap.has("__iterator_next")) return;

  const mod = ctx.mod;
  const dispatchTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_method_type");

  // Helper to emit a method dispatch export
  const emitMethodDispatch = (methodSuffix: string, exportName: string) => {
    const entries: { structName: string; typeIdx: number; funcIdx: number; resultType: ValType }[] = [];

    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (
        structName.startsWith("Wrapper") ||
        structName === "$AnyValue" ||
        structName.startsWith("__vec_") ||
        structName.startsWith("__arr_")
      )
        continue;

      const methodFullName = `${structName}_${methodSuffix}`;
      const funcIdx = ctx.funcMap.get(methodFullName);
      if (funcIdx === undefined) continue;

      const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
      const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
      const resultType: ValType =
        funcType && funcType.kind === "func" && funcType.results.length > 0
          ? funcType.results[0]!
          : { kind: "externref" };

      entries.push({ structName, typeIdx, funcIdx, resultType });
    }

    if (entries.length === 0) return;

    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" } as Instr);
    body.push({ op: "local.set", index: 1 } as Instr);

    let current: Instr[] = [{ op: "ref.null.extern" } as Instr];

    for (const entry of entries) {
      const testAndCall: Instr[] = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.cast", typeIdx: entry.typeIdx } as Instr,
        { op: "call", funcIdx: entry.funcIdx } as Instr,
      ];

      if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
        testAndCall.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx } as Instr);
        }
      } else if (entry.resultType.kind === "i32") {
        testAndCall.push({ op: "f64.convert_i32_s" } as Instr);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx } as Instr);
        }
      }
      // externref: no conversion needed

      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: testAndCall,
          else: current,
        } as Instr,
      ];
    }

    body.push(...current);

    mod.functions.push({
      name: exportName,
      typeIdx: dispatchTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: exportName,
      desc: { kind: "func", index: funcIdx },
    });
  };

  emitMethodDispatch("@@iterator", "__call_@@iterator");
  emitMethodDispatch("next", "__call_next");
}

/**
 * Emit __call_fn_0 export (#851): call a zero-arg WasmGC closure from JS.
 * Takes an externref (the closure struct) and returns externref (the result).
 * This enables calling dynamically-assigned closures (e.g. iterable[Symbol.iterator])
 * from the JS runtime when the closure is stored as a WasmGC struct in the sidecar.
 *
 * Strategy: dispatch by FUNCREF TYPE, not struct type.
 *
 * Problem with struct-type dispatch: V8's isorecursive canonicalization merges all
 * base wrapper struct types that have one field (funcref) into the same Wasm type.
 * So `ref.test $baseWrapperA` also passes for closures of base wrapper B, causing
 * `ref.cast $funcTypeA` on a funcref of type B to trap with "illegal cast".
 *
 * Solution: use ONE representative struct type for `ref.test` + `struct.get 0` to
 * extract the funcref, then dispatch on funcref type (which remains distinct per
 * closure signature even after struct canonicalization). Concrete subtype closures
 * (with captures) share the same funcref type as their base wrapper, so they're
 * covered automatically.
 *
 * Locals layout:
 *   0 = externref param
 *   1 = anyref (__any) — the converted externref
 *   2 = (ref null $baseWrapper) (__struct) — cast struct for field access and self arg
 *   3 = funcref (__funcref) — extracted funcref for type dispatch
 */
function emitClosureCallExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Phase 1: collect unique zero-arg funcref types and find representative base wrapper.
  // Dedup by funcTypeIdx — concrete subtypes share funcTypeIdx with their base wrapper,
  // so one dispatch arm handles all closures with the same funcref signature.
  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  const entries: { funcTypeIdx: number; returnType: ValType | null; selfTypeIdx: number }[] = [];

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length !== 0) continue;

    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;

    // Find a representative base wrapper (superTypeIdx === -1, no parent struct)
    // for the initial ref.test + ref.cast + struct.get 0.
    // After V8 isorecursive canonicalization, all base wrappers with one funcref
    // field collapse to the same type, so any base wrapper typeIdx works.
    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }

    // Deduplicate by funcref type: concrete subtypes share funcTypeIdx with the
    // base wrapper — only one dispatch arm needed per unique funcref type.
    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      // Look up the self param type from the funcref type definition.
      // The lifted func type has (ref $selfStructType, ...params) → result.
      // We must pass (ref $selfStructType) as the self arg for call_ref to validate.
      const funcTypeDef = mod.types[info.funcTypeIdx];
      const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
      const selfTypeIdx =
        selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
          ? (selfParam as { typeIdx: number }).typeIdx
          : typeIdx; // fallback: use struct typeIdx
      entries.push({ funcTypeIdx: info.funcTypeIdx, returnType: info.returnType, selfTypeIdx });
    }
  }

  if (entries.length === 0) return;

  // If no base wrapper found (all are concrete subtypes), use first struct type.
  if (baseWrapperIdx === undefined) {
    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length === 0) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) return;

  // Ensure __box_number is available for boxing numeric (f64/i32/i64) results.
  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");

  const exportFuncTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_fn_0_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const bwIdx = baseWrapperIdx; // final for closures

  // Body:
  //   local 0: externref (param)
  //   local 1: anyref (__any)
  //   local 2: (ref null $baseWrapper) (__struct) — after initial struct test+cast
  //   local 3: funcref (__funcref) — extracted from field 0
  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: 1 } as Instr);

  // Phase 2: build funcref-type dispatch chain (innermost = last entry, outermost = first)
  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (const entry of entries) {
    const callBody: Instr[] = [
      // Self arg: cast from anyref (local 1) to the specific base wrapper type for this
      // funcref. Each funcref's first param is (ref $specificBaseWrapper). Using local 1
      // (anyref) and casting to the exact expected type satisfies the Wasm validator.
      { op: "local.get", index: 1 } as Instr,
      { op: "ref.cast", typeIdx: entry.selfTypeIdx } as Instr,
      // Funcref arg: cast to specific func type (safe since ref.test passed)
      { op: "local.get", index: 3 } as Instr,
      { op: "ref.cast", typeIdx: entry.funcTypeIdx } as Instr,
      { op: "call_ref", typeIdx: entry.funcTypeIdx } as Instr,
    ];

    // Coerce result to externref
    if (entry.returnType) {
      if (entry.returnType.kind === "ref" || entry.returnType.kind === "ref_null") {
        callBody.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.returnType.kind === "f64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i32") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i32_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i64") {
        // i64 (BigInt) — convert to f64 then box, or drop and return null
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i64_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      }
      // externref: no conversion needed
    } else {
      callBody.push({ op: "ref.null.extern" } as Instr);
    }

    funcrefDispatch = [
      { op: "local.get", index: 3 } as Instr,
      { op: "ref.test", typeIdx: entry.funcTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      } as Instr,
    ];
  }

  // Outer: if the value is a closure struct, extract funcref and dispatch.
  // ref.test uses the representative base wrapper; concrete subtypes (with captures)
  // also pass since they're subtypes of the base wrapper.
  const structExtractAndDispatch: Instr[] = [
    // Cast to base wrapper, tee to local 2, struct.get 0 → funcref, store in local 3
    { op: "local.get", index: 1 } as Instr,
    { op: "ref.cast", typeIdx: bwIdx } as Instr,
    { op: "local.tee", index: 2 } as Instr,
    { op: "struct.get", typeIdx: bwIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: 3 } as Instr,
    ...funcrefDispatch,
  ];

  body.push({ op: "local.get", index: 1 } as Instr);
  body.push({ op: "ref.test", typeIdx: bwIdx } as Instr);
  body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: structExtractAndDispatch,
    else: [{ op: "ref.null.extern" } as Instr],
  } as Instr);

  mod.functions.push({
    name: "__call_fn_0",
    typeIdx: exportFuncTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
      { name: "__funcref", type: { kind: "funcref" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__call_fn_0",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * Emit __call_fn_1 export (#1090): call a one-arg WasmGC closure from JS.
 * Takes (externref closure, externref arg) and returns externref.
 * Needed for Symbol.toPrimitive closures which take a hint argument.
 * Same dispatch strategy as __call_fn_0 but for arity 1.
 */
function emitClosureCallExport1(ctx: CodegenContext): void {
  const mod = ctx.mod;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  const entries: { funcTypeIdx: number; returnType: ValType | null; selfTypeIdx: number }[] = [];

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length !== 1) continue;

    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;

    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }

    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      const funcTypeDef = mod.types[info.funcTypeIdx];
      const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
      const selfTypeIdx =
        selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
          ? (selfParam as { typeIdx: number }).typeIdx
          : typeIdx;
      entries.push({ funcTypeIdx: info.funcTypeIdx, returnType: info.returnType, selfTypeIdx });
    }
  }

  if (entries.length === 0) return;

  // If no base wrapper found, try any 0-arg base wrapper (V8 canonicalizes
  // all single-funcref base wrappers to the same type regardless of arity)
  if (baseWrapperIdx === undefined) {
    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      const typeDef = mod.types[typeIdx];
      if (typeDef && typeDef.kind === "struct" && typeDef.superTypeIdx === -1) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) {
    for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
      if (ctx.closureInfoByTypeIdx.get(typeIdx)!.paramTypes.length === 1) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");

  // __call_fn_1(closure: externref, arg: externref) → externref
  const exportFuncTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_fn_1_type",
  );
  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const bwIdx = baseWrapperIdx;

  // Locals: 0=closure externref, 1=arg externref, 2=anyref, 3=struct ref, 4=funcref
  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: 2 } as Instr);

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (const entry of entries) {
    // The funcref type for 1-arg closures is: (ref $self, param_type) → return_type
    // We need to convert the externref arg to the expected param type.
    // Most commonly it's externref (for hint strings), f64, or i32.
    const funcTypeDef = mod.types[entry.funcTypeIdx];
    const paramType =
      funcTypeDef?.kind === "func" && funcTypeDef.params.length >= 2 ? funcTypeDef.params[1] : undefined;

    const argConversion: Instr[] = [{ op: "local.get", index: 1 } as Instr];
    if (paramType) {
      if (paramType.kind === "f64") {
        // externref → f64: unbox
        const unboxIdx = ctx.funcMap.get("__unbox_number");
        if (unboxIdx !== undefined) {
          argConversion.push({ op: "call", funcIdx: unboxIdx } as Instr);
        }
      } else if (paramType.kind === "i32") {
        const unboxIdx = ctx.funcMap.get("__unbox_number");
        if (unboxIdx !== undefined) {
          argConversion.push({ op: "call", funcIdx: unboxIdx } as Instr);
          argConversion.push({ op: "i32.trunc_f64_s" } as unknown as Instr);
        }
      }
      // externref → externref: no conversion
    }

    const callBody: Instr[] = [
      { op: "local.get", index: 2 } as Instr,
      { op: "ref.cast", typeIdx: entry.selfTypeIdx } as Instr,
      ...argConversion,
      { op: "local.get", index: 4 } as Instr,
      { op: "ref.cast", typeIdx: entry.funcTypeIdx } as Instr,
      { op: "call_ref", typeIdx: entry.funcTypeIdx } as Instr,
    ];

    // Coerce result to externref
    if (entry.returnType) {
      if (entry.returnType.kind === "ref" || entry.returnType.kind === "ref_null") {
        callBody.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.returnType.kind === "f64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i32") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i32_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i64_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      }
    } else {
      callBody.push({ op: "ref.null.extern" } as Instr);
    }

    funcrefDispatch = [
      { op: "local.get", index: 4 } as Instr,
      { op: "ref.test", typeIdx: entry.funcTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      } as Instr,
    ];
  }

  const structExtractAndDispatch: Instr[] = [
    { op: "local.get", index: 2 } as Instr,
    { op: "ref.cast", typeIdx: bwIdx } as Instr,
    { op: "local.tee", index: 3 } as Instr,
    { op: "struct.get", typeIdx: bwIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: 4 } as Instr,
    ...funcrefDispatch,
  ];

  body.push({ op: "local.get", index: 2 } as Instr);
  body.push({ op: "ref.test", typeIdx: bwIdx } as Instr);
  body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: structExtractAndDispatch,
    else: [{ op: "ref.null.extern" } as Instr],
  } as Instr);

  mod.functions.push({
    name: "__call_fn_1",
    typeIdx: exportFuncTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
      { name: "__funcref", type: { kind: "funcref" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__call_fn_1",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * Emit __call_toString and __call_valueOf exports for ToPrimitive dispatch (#866).
 * These allow the JS runtime to call toString/valueOf on WasmGC structs
 * that are opaque to JavaScript (struct fields are funcrefs, not JS functions).
 *
 * Handles both:
 * - Standalone methods: StructName_toString compiled as a function
 * - Closure fields: toString field is a closure ref, call via struct.get + call_ref
 */
function emitToPrimitiveMethodExports(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const dispatchTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_toPrim_type");

  const emitDispatchForMethod = (methodName: string, exportName: string) => {
    type DispatchEntry =
      | {
          structName: string;
          typeIdx: number;
          mode: "standalone";
          funcIdx: number;
          resultType: ValType;
        }
      | {
          structName: string;
          typeIdx: number;
          mode: "closure";
          fieldIdx: number;
          closureTypeIdx: number;
          closureInfo: ClosureInfo;
        };

    const entries: DispatchEntry[] = [];

    for (const [structName, fields] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (
        structName.startsWith("Wrapper") ||
        structName === "$AnyValue" ||
        structName.startsWith("__vec_") ||
        structName.startsWith("__arr_")
      )
        continue;

      // 1. Check for standalone method: StructName_toString
      const methodFullName = `${structName}_${methodName}`;
      const funcIdx = ctx.funcMap.get(methodFullName);
      if (funcIdx !== undefined) {
        const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
        const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
        const resultType: ValType =
          funcType && funcType.kind === "func" && funcType.results.length > 0
            ? funcType.results[0]!
            : { kind: "externref" };
        entries.push({ structName, typeIdx, mode: "standalone", funcIdx, resultType });
        continue;
      }

      // 2. Check for closure field
      const fieldIdx = fields.findIndex((f) => f.name === methodName);
      if (fieldIdx < 0) continue;
      const field = fields[fieldIdx]!;

      // Closure ref field
      if (field.type.kind === "ref" || field.type.kind === "ref_null") {
        const closureTypeIdx = (field.type as { typeIdx: number }).typeIdx;
        const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
        if (closureInfo && closureInfo.paramTypes.length === 0) {
          entries.push({ structName, typeIdx, mode: "closure", fieldIdx, closureTypeIdx, closureInfo });
          continue;
        }
      }

      // eqref field — try tracked closure types
      if (field.type.kind === "eqref") {
        const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
        for (const closureTypeIdx of trackedTypes) {
          const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (closureInfo && closureInfo.paramTypes.length === 0) {
            entries.push({ structName, typeIdx, mode: "closure", fieldIdx, closureTypeIdx, closureInfo });
            break;
          }
        }
      }
    }

    if (entries.length === 0) return;

    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 1;

    const boxResult = (resultType: ValType, instrs: Instr[]) => {
      if (resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
        else {
          instrs.push({ op: "drop" } as Instr);
          instrs.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (resultType.kind === "i32") {
        instrs.push({ op: "f64.convert_i32_s" } as Instr);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
        else {
          instrs.push({ op: "drop" } as Instr);
          instrs.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (resultType.kind === "i64") {
        // i64 (BigInt) — convert to f64 then box, or drop and return null
        instrs.push({ op: "f64.convert_i64_s" } as Instr);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
        else {
          instrs.push({ op: "drop" } as Instr);
          instrs.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        instrs.push({ op: "extern.convert_any" } as Instr);
      }
    };

    const buildDispatch = (idx: number): Instr[] => {
      if (idx >= entries.length) return [{ op: "ref.null.extern" } as Instr];
      const entry = entries[idx]!;

      const thenInstrs: Instr[] = [];
      if (entry.mode === "standalone") {
        thenInstrs.push(
          { op: "local.get", index: anyLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.typeIdx } as unknown as Instr,
          { op: "call", funcIdx: entry.funcIdx } as Instr,
        );
        boxResult(entry.resultType, thenInstrs);
      } else {
        // Closure field: extract closure, get funcref, call_ref
        const ci = entry.closureInfo;
        thenInstrs.push(
          { op: "local.get", index: anyLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.typeIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr,
        );
        // The struct.get returns the field type (eqref or ref). Store in eqref local.
        const closureLocal = 2; // eqref local
        thenInstrs.push(
          { op: "local.set", index: closureLocal } as Instr,
          // Cast eqref to closure struct type for the self-param
          { op: "local.get", index: closureLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx } as unknown as Instr,
          // Get funcref from closure field 0
          { op: "local.get", index: closureLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 } as Instr,
          { op: "ref.cast", typeIdx: ci.funcTypeIdx } as unknown as Instr,
          { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
        );
        const retType = ci.returnType ?? { kind: "externref" as const };
        if (!ci.returnType) {
          // void — push null externref
          thenInstrs.push({ op: "ref.null.extern" } as Instr);
        } else {
          boxResult(retType, thenInstrs);
        }
      }

      return [
        { op: "local.get", index: anyLocal } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as unknown as Instr,
        {
          op: "if",
          blockType: { kind: "val" as const, type: { kind: "externref" as const } },
          then: thenInstrs,
          else: buildDispatch(idx + 1),
        } as Instr,
      ];
    };

    // Determine locals: param 0 (externref), local 1 (anyref), local 2 (eqref for closure)
    const hasClosureEntry = entries.some((e) => e.mode === "closure");
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (hasClosureEntry) {
      locals.push({ name: "__closure", type: { kind: "eqref" } });
    }

    const body: Instr[] = [
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: anyLocal } as Instr,
      ...buildDispatch(0),
    ];

    mod.functions.push({
      name: exportName,
      typeIdx: dispatchTypeIdx,
      locals,
      body,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: exportName,
      desc: { kind: "func", index: funcIdx },
    });
  };

  emitDispatchForMethod("toString", "__call_toString");
  emitDispatchForMethod("valueOf", "__call_valueOf");
}

/** Helper to get the kind of a struct field type */
function fields_type_kind(ctx: CodegenContext, structTypeIdx: number, fieldIdx: number): string {
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  if (!structName) return "unknown";
  const fields = ctx.structFields.get(structName);
  if (!fields || !fields[fieldIdx]) return "unknown";
  return fields[fieldIdx]!.type.kind;
}

/**
 * Emit __vec_get(externref, i32) -> externref and __vec_len(externref) -> i32
 * exports so the runtime can iterate WasmGC vec structs that were coerced to
 * externref (e.g. arrays stored in `any`-typed variables).
 *
 * For each registered vec type, emits ref.test/ref.cast dispatch to extract
 * the length or the indexed element, boxing the result to externref.
 */
function emitVecAccessExports(ctx: CodegenContext): void {
  // Emit vec access exports when the runtime may need to introspect WasmGC arrays:
  // - for-of iteration on non-array types (__iterator)
  // - JSON.stringify on arrays of structs (JSON_stringify)
  if (!ctx.funcMap.has("__iterator") && !ctx.funcMap.has("JSON_stringify") && !ctx.funcMap.has("__make_iterable"))
    return;
  try {
    _emitVecAccessExportsInner(ctx);
  } catch {
    // Non-fatal: if emission fails, the iterator fallback just won't work
  }
}

function _emitVecAccessExportsInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecEntries = Array.from(ctx.vecTypeMap.entries());
  if (vecEntries.length === 0) return;

  // Ensure __box_number is available for boxing f64/i32 elements in __vec_get (#854)
  addUnionImports(ctx);

  // __vec_len(externref) -> i32
  const lenTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__vec_len_type");
  const lenFuncIdx = ctx.numImportFuncs + mod.functions.length;
  {
    // local 0 = externref param, local 1 = anyref converted
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" } as Instr);
    body.push({ op: "local.set", index: 1 } as Instr);

    // Chain of ref.test / ref.cast for each vec type
    let current: Instr[] = [
      // Default: return 0 if no vec type matches
      { op: "i32.const", value: 0 } as Instr,
      { op: "return" } as Instr,
    ];
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = vecEntries[i]!;
      const thenBranch: Instr[] = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);

    mod.functions.push({
      name: "__vec_len",
      typeIdx: lenTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({
      name: "__vec_len",
      desc: { kind: "func", index: lenFuncIdx },
    });
  }

  // __vec_get(externref, i32) -> externref
  const getTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
    "$__vec_get_type",
  );
  const getFuncIdx = ctx.numImportFuncs + mod.functions.length;
  {
    // local 0 = externref param (vec), local 1 = i32 param (index), local 2 = anyref
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" } as Instr);
    body.push({ op: "local.set", index: 2 } as Instr);

    // Chain of ref.test / ref.cast for each vec type
    let current: Instr[] = [
      // Default: return null if no vec type matches
      { op: "ref.null.extern" } as Instr,
      { op: "return" } as Instr,
    ];
    // Pre-check if __box_number is available (don't add late imports)
    const boxNumIdx = ctx.funcMap.get("__box_number");
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = vecEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      // Skip numeric element types if __box_number is not available
      if ((elemKey === "f64" || elemKey === "i32" || elemKey === "i32_byte") && boxNumIdx === undefined) continue;

      // Inline boxing: avoid calling addUnionImports late
      let boxInstrs: Instr[];
      if (elemKey === "externref") {
        boxInstrs = [];
      } else if (elemKey === "f64" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i32" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i32_byte" && boxNumIdx !== undefined) {
        // ArrayBuffer/DataView byte elements (i32, unsigned 0-255) — convert unsigned then box
        boxInstrs = [{ op: "f64.convert_i32_u" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i64") {
        // i64 (BigInt) is a value type, not a ref type — extern.convert_any expects anyref.
        // Convert i64 -> f64 (lossy for large values) then box, or drop and return null.
        if (boxNumIdx !== undefined) {
          boxInstrs = [{ op: "f64.convert_i64_s" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
        } else {
          boxInstrs = [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
        }
      } else {
        boxInstrs = [{ op: "extern.convert_any" } as Instr];
      }
      const thenBranch: Instr[] = [
        // ref.cast to vec type, struct.get data array, then array.get with index
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: 1 } as Instr, // index
        { op: "array.get", typeIdx: arrTypeIdx } as Instr,
        ...boxInstrs,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);

    mod.functions.push({
      name: "__vec_get",
      typeIdx: getTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({
      name: "__vec_get",
      desc: { kind: "func", index: getFuncIdx },
    });
  }
}

/**
 * Emit DataView byte-access exports for i32_byte vec structs (#1056).
 *
 * Adds three exports that operate on ArrayBuffer/DataView backing stores:
 *   __dv_byte_len(externref) -> i32          — vec length, or -1 if not i32_byte
 *   __dv_byte_get(externref, i32) -> i32     — unsigned byte at index
 *   __dv_byte_set(externref, i32, i32) -> () — write byte at index
 *
 * The JS runtime uses these in __extern_method_call to implement
 * DataView.prototype.{get,set}{Uint,Int,Float}{8,16,32,64} and friends
 * by materializing a real DataView over a live byte array, invoking the
 * native method, and writing bytes back for setters.
 */
function emitDataViewByteExports(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const byteVecTypeIdx = ctx.vecTypeMap.get("i32_byte");
  if (byteVecTypeIdx === undefined) return;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, byteVecTypeIdx);
  if (arrTypeIdx < 0) return;

  // __dv_byte_len(externref) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__dv_byte_len_type");
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: byteVecTypeIdx } as unknown as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 } as Instr,
          { op: "ref.cast", typeIdx: byteVecTypeIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 0 } as unknown as Instr,
          { op: "return" } as Instr,
        ],
        else: [],
      } as unknown as Instr,
      { op: "i32.const", value: -1 } as Instr,
    ];
    mod.functions.push({
      name: "__dv_byte_len",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__dv_byte_len", desc: { kind: "func", index: funcIdx } });
  }

  // __dv_byte_get(externref, i32) -> i32
  {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$__dv_byte_get_type",
    );
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: byteVecTypeIdx } as unknown as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 } as Instr,
          { op: "ref.cast", typeIdx: byteVecTypeIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 1 } as unknown as Instr,
          { op: "local.get", index: 1 } as Instr,
          { op: "array.get", typeIdx: arrTypeIdx } as unknown as Instr,
          { op: "return" } as Instr,
        ],
        else: [],
      } as unknown as Instr,
      { op: "i32.const", value: 0 } as Instr,
    ];
    mod.functions.push({
      name: "__dv_byte_get",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__dv_byte_get", desc: { kind: "func", index: funcIdx } });
  }

  // __dv_byte_set(externref, i32, i32) -> ()
  {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
      [],
      "$__dv_byte_set_type",
    );
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: byteVecTypeIdx } as unknown as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 } as Instr,
          { op: "ref.cast", typeIdx: byteVecTypeIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 1 } as unknown as Instr,
          { op: "local.get", index: 1 } as Instr,
          { op: "local.get", index: 2 } as Instr,
          { op: "array.set", typeIdx: arrTypeIdx } as unknown as Instr,
        ],
        else: [],
      } as unknown as Instr,
    ];
    mod.functions.push({
      name: "__dv_byte_set",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__dv_byte_set", desc: { kind: "func", index: funcIdx } });
  }
}

/** Build nested if/else for struct field getter dispatch. */
function buildNestedIfElse(
  entries: { typeIdx: number; fieldIdx: number; fieldType: ValType }[],
  anyLocal: number,
  boxNumIdx: number | undefined,
  returnMode: "extern" | "f64" | "i32" = "extern",
): Instr[] {
  const body: Instr[] = [];

  // Convert externref to anyref and store
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Default return value for the final else
  let defaultVal: Instr;
  let blockRetType: ValType;
  if (returnMode === "f64") {
    defaultVal = { op: "f64.const", value: 0 } as Instr;
    blockRetType = { kind: "f64" };
  } else if (returnMode === "i32") {
    defaultVal = { op: "i32.const", value: 0 } as Instr;
    blockRetType = { kind: "i32" };
  } else {
    defaultVal = { op: "ref.null.extern" } as Instr;
    blockRetType = { kind: "externref" };
  }

  // Build a chain: if (ref.test T1) { get from T1 } else if (ref.test T2) { ... } else { default }
  let current: Instr[] = [defaultVal];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const thenBranch = buildGetterExtract(entry, anyLocal, boxNumIdx, returnMode);

    const ifInstr: Instr = {
      op: "if",
      blockType: { kind: "val", type: blockRetType },
      then: thenBranch,
      else: current,
    } as unknown as Instr;

    current = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
      ifInstr,
    ];
  }

  body.push(...current);
  return body;
}

/** Build the "then" branch that extracts a field from a cast struct. */
function buildGetterExtract(
  entry: { typeIdx: number; fieldIdx: number; fieldType: ValType },
  anyLocal: number,
  boxNumIdx: number | undefined,
  returnMode: "extern" | "f64" | "i32" = "extern",
): Instr[] {
  const then: Instr[] = [];

  // Cast anyref to the struct type
  then.push({ op: "local.get", index: anyLocal } as Instr);
  then.push({ op: "ref.cast", typeIdx: entry.typeIdx } as Instr);
  then.push({ op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr);

  const ft = entry.fieldType;

  if (returnMode === "f64") {
    // Return f64 directly
    if (ft.kind === "f64") {
      // Already f64 — nothing to do
    } else if (ft.kind === "i32") {
      then.push({ op: "f64.convert_i32_s" } as Instr);
    } else {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "f64.const", value: 0 } as Instr);
    }
  } else if (returnMode === "i32") {
    // Return i32 directly
    if (ft.kind === "i32") {
      // Already i32
    } else if (ft.kind === "f64") {
      then.push({ op: "i32.trunc_sat_f64_s" } as unknown as Instr);
    } else {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "i32.const", value: 0 } as Instr);
    }
  } else {
    // Return externref
    if (ft.kind === "f64") {
      if (boxNumIdx !== undefined) {
        then.push({ op: "call", funcIdx: boxNumIdx } as Instr);
      } else {
        then.push({ op: "drop" } as Instr);
        then.push({ op: "ref.null.extern" } as Instr);
      }
    } else if (ft.kind === "i32") {
      then.push({ op: "f64.convert_i32_s" } as Instr);
      if (boxNumIdx !== undefined) {
        then.push({ op: "call", funcIdx: boxNumIdx } as Instr);
      } else {
        then.push({ op: "drop" } as Instr);
        then.push({ op: "ref.null.extern" } as Instr);
      }
    } else if (ft.kind === "i64") {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "ref.null.extern" } as Instr);
    } else if (ft.kind === "externref" || ft.kind === "ref_extern") {
      // Already externref
    } else if (ft.kind === "ref" || ft.kind === "ref_null" || ft.kind === "anyref" || ft.kind === "eqref") {
      then.push({ op: "extern.convert_any" } as Instr);
    } else {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "ref.null.extern" } as Instr);
    }
  }

  return then;
}

/**
 * Compile multiple typed source files into a single WasmModule IR.
 * All source files share the same codegen context (funcMap, structMap, etc.).
 * Only functions exported from the entry file become Wasm exports.
 */
export function generateMultiModule(
  multiAst: MultiTypedAST,
  options?: CodegenOptions,
): {
  module: WasmModule;
  errors: { message: string; line: number; column: number; severity?: "error" | "warning" }[];
} {
  const mod = createEmptyModule();
  const ctx = createCodegenContext(mod, multiAst.checker, options);
  try {
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, multiAst.entryFile);
    }

    // $AnyValue struct type is now registered lazily via ensureAnyValueType()

    // Phase 1: Collect extern declarations first (needed before import collectors)
    for (const sf of multiAst.sourceFiles) {
      collectExternDeclarations(ctx, sf);
    }

    // WASI target: check for DOM-only globals and emit compile errors
    if (ctx.wasi) {
      for (const sf of multiAst.sourceFiles) {
        checkWasiDomUsage(ctx, sf);
      }
    }

    // Scan lib files for DOM extern classes + globals (only if any user code uses DOM)
    // After lib.d.ts refactoring, TS loads individual lib files (lib.es5.d.ts, etc.)
    const anyUsesDom = multiAst.sourceFiles.some((sf) => sourceUsesLibGlobals(sf));
    if (anyUsesDom) {
      for (const libSf of multiAst.program.getSourceFiles()) {
        const baseName = libSf.fileName.split("/").pop() ?? libSf.fileName;
        if (baseName.startsWith("lib.") && baseName.endsWith(".d.ts")) {
          collectExternDeclarations(ctx, libSf);
          for (const sf of multiAst.sourceFiles) {
            if (sourceUsesLibGlobals(sf)) {
              collectDeclaredGlobals(ctx, libSf, sf);
            }
          }
        }
      }
    }

    // Register built-in collection types as extern classes if not already collected from lib files
    registerBuiltinExternClasses(ctx);

    // Pre-pass: detect empty object literals that get properties assigned later
    // Must run before import collectors so that widened types are known
    for (const sf of multiAst.sourceFiles) {
      collectEmptyObjectWidening(ctx, multiAst.checker, sf);
    }

    // Single-pass collection of all source imports for each file (#592)
    for (const sf of multiAst.sourceFiles) {
      collectUsedExternImports(ctx, sf);
      collectAllSourceImports(ctx, sf);
    }

    // Emit inline Wasm implementations for Math methods (after all imports are registered)
    if (ctx.pendingMathMethods.size > 0) {
      emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
    }

    // Emit __toUint32 Wasm helper after all imports registered.
    emitToUint32Helper(ctx);

    // Emit wrapper valueOf functions (after all imports registered, before user funcs)
    emitWrapperValueOfFunctions(ctx);

    // #1121: Numeric return-type inference (must run BEFORE collectDeclarations
    // so the inferred f64 return is baked into the function signature).
    {
      const merged = new Map<string, ValType>();
      for (const sf of multiAst.sourceFiles) {
        const partial = inferNumericReturnTypes(ctx, sf);
        for (const [k, v] of partial) merged.set(k, v);
      }
      ctx.numericReturnTypes = merged;
    }

    // Phase 2: Collect all declarations — only entry file gets Wasm exports
    for (const sf of multiAst.sourceFiles) {
      const isEntry = sf === multiAst.entryFile;
      collectDeclarations(ctx, sf, isEntry);
    }

    // Shape inference: detect array-like variables and override their types
    for (const sf of multiAst.sourceFiles) {
      applyShapeInference(ctx, multiAst.checker, sf);
    }

    // Phase 3: Compile all function bodies
    for (const sf of multiAst.sourceFiles) {
      compileDeclarations(ctx, sf);
    }

    // Fixup pass: reconcile struct.new argument counts with actual struct field counts.
    fixupStructNewArgCounts(ctx);

    // Fixup pass: insert extern.convert_any after struct.new when the result
    // is stored into an externref local/global.
    fixupStructNewResultCoercion(ctx);

    // Build per-shape default property flags table for all user-visible structs
    buildShapePropFlagsTable(ctx);

    // Collect ref.func targets so the binary emitter can add a declarative element segment
    collectDeclaredFuncRefs(ctx);

    // Resolve deferred `export default <variable>` for module globals (#1108).
    // Must run AFTER compileDeclarations — string-constant imports added during
    // body compilation shift numImportGlobals, so indices aren't final until now.
    if (ctx.deferredDefaultGlobalExport) {
      const varName = ctx.deferredDefaultGlobalExport;
      const globalName = `__mod_${varName}`;
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === globalName);
      if (localIdx >= 0) {
        const absIdx = ctx.numImportGlobals + localIdx;
        const alreadyExported = ctx.mod.exports.some(
          (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
        );
        if (!alreadyExported) {
          ctx.mod.exports.push({ name: "default", desc: { kind: "global", index: absIdx } });
          ctx.mod.exports.push({ name: varName, desc: { kind: "global", index: absIdx } });
        }
      }
      ctx.deferredDefaultGlobalExport = undefined;
    }

    // Copy metadata for .d.ts / helper generation
    const importNames = mod.imports.map((imp) => imp.name);
    for (const [key, info] of ctx.externClasses) {
      const prefix = `${info.importPrefix}_`;
      const isUsed = importNames.some((n) => n.startsWith(prefix));
      if (key === info.className && isUsed) {
        mod.externClasses.push({
          importPrefix: info.importPrefix,
          namespacePath: info.namespacePath,
          className: info.className,
          constructorParams: info.constructorParams,
          methods: info.methods,
          properties: info.properties,
        });
      }
    }
    mod.stringLiteralValues = ctx.stringLiteralValues;
    mod.asyncFunctions = ctx.asyncFunctions;

    // WASI: export _start entry point (before dead import elimination adjusts indices)
    if (ctx.wasi) {
      addWasiStartExport(ctx);
    }

    // Export the exception tag so the exec worker can extract thrown payloads
    // via WebAssembly.Exception.getArg(tag, 0).
    if (ctx.exnTagIdx >= 0) {
      const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;
      mod.exports.push({
        name: "__exn_tag",
        desc: { kind: "tag", index: numImportTags + ctx.exnTagIdx },
      });
    }

    // Mark leaf struct types as final for V8 devirtualization (#594).
    // Skipped for `--target wasi` so that downstream `wasm-opt --all-features`
    // does not convert refs to those types into `(ref exact $T)`, which
    // wasmtime ≤ 44 rejects (#1173).
    markLeafStructsFinal(mod, ctx.wasi);

    // Dead import and type elimination pass
    eliminateDeadImports(mod);

    // Repair struct.get/struct.set type mismatches (externref → struct ref conversion)
    repairStructTypeMismatches(mod);

    // Peephole optimization: remove redundant ref.as_non_null after ref.cast, etc.
    peepholeOptimize(mod);

    // Stack-balancing fixup: ensure all branches in if/try/block have matching stack states
    stackBalance(mod);
  } catch (e) {
    reportErrorNoNode(ctx, `Codegen error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { module: mod, errors: ctx.errors };
}

// ── Unified single-pass import collector (#592) ─────────────────────
//
// Instead of walking the AST 19+ times with separate collect* functions,
// collectAllSourceImports performs a SINGLE recursive traversal and
// dispatches to all collector logic on every node.  The individual
// collect* functions below are preserved but no longer called from
// generateModule / generateMultiModule — they remain as reference and
// for any call sites that need them independently.

function collectAllSourceImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const state = createUnifiedCollectorState(sourceFile);
  ts.forEachChild(sourceFile, (node) => unifiedVisitNode(ctx, state, node));
  finalizeUnifiedCollector(ctx, state);
}

/** Scan source for console.log/warn/error/info/debug() calls and register only needed import variants */
function collectConsoleImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;
  // Track needed variants per console method
  const neededByMethod = new Map<string, Set<"number" | "bool" | "string" | "externref">>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      const method = node.expression.name.text;
      if (CONSOLE_METHODS.includes(method as any)) {
        if (!neededByMethod.has(method)) neededByMethod.set(method, new Set());
        const needed = neededByMethod.get(method)!;
        for (const arg of node.arguments) {
          const argType = ctx.checker.getTypeAtLocation(arg);
          if (isStringType(argType)) {
            needed.add("string");
          } else if (isBooleanType(argType)) {
            needed.add("bool");
          } else if (isNumberType(argType)) {
            needed.add("number");
          } else {
            needed.add("externref");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  for (const method of CONSOLE_METHODS) {
    const needed = neededByMethod.get(method);
    if (!needed) continue;
    if (needed.has("number")) {
      const t = addFuncType(ctx, [{ kind: "f64" }], []);
      addImport(ctx, "env", `console_${method}_number`, { kind: "func", typeIdx: t });
    }
    if (needed.has("bool")) {
      const t = addFuncType(ctx, [{ kind: "i32" }], []);
      addImport(ctx, "env", `console_${method}_bool`, { kind: "func", typeIdx: t });
    }
    if (needed.has("string")) {
      const t = addFuncType(ctx, [{ kind: "externref" }], []);
      addImport(ctx, "env", `console_${method}_string`, { kind: "func", typeIdx: t });
    }
    if (needed.has("externref")) {
      const t = addFuncType(ctx, [{ kind: "externref" }], []);
      addImport(ctx, "env", `console_${method}_externref`, {
        kind: "func",
        typeIdx: t,
      });
    }
  }
}

/** Register WASI imports: fd_write, proc_exit, path_open, fd_close, linear memory, bump pointer global */
function registerWasiImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Add linear memory (1 page = 64KB) for string data + iovec structs
  ctx.mod.memories.push({ min: 1 });
  // WASI requires the memory to be exported as "memory"
  ctx.mod.exports.push({ name: "memory", desc: { kind: "memory", index: 0 } });

  // Add bump pointer global (mutable i32, starts at 0)
  // We reserve the first 1024 bytes for iovec scratch space
  const bumpGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__wasi_bump_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 1024 } as Instr],
  });
  ctx.wasiBumpPtrGlobalIdx = bumpGlobalIdx;

  // Check if source uses console.log/warn/error, process.exit, or node:fs functions
  let needsFdWrite = false;
  let needsProcExit = false;

  // ctx.wasiNodeFsFuncs is populated from the original source before import preprocessing
  // (see detectNodeFsImports in compiler.ts)
  const needsPathOpen = ctx.wasiNodeFsFuncs.has("writeFileSync");

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propAccess = node.expression;
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "console" &&
        ["log", "warn", "error"].includes(propAccess.name.text)
      ) {
        needsFdWrite = true;
      }
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "process" &&
        propAccess.name.text === "exit"
      ) {
        needsProcExit = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);

  // writeFileSync also needs fd_write for the actual file data write
  if (needsPathOpen) needsFdWrite = true;

  // fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  if (needsFdWrite) {
    const fdWriteType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_write",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_write", { kind: "func", typeIdx: fdWriteType });
    ctx.wasiFdWriteIdx = ctx.funcMap.get("fd_write")!;
  }

  // proc_exit(code: i32) -> void
  if (needsProcExit) {
    const procExitType = addFuncType(ctx, [{ kind: "i32" }], [], "$wasi_proc_exit");
    addImport(ctx, "wasi_snapshot_preview1", "proc_exit", { kind: "func", typeIdx: procExitType });
    ctx.wasiProcExitIdx = ctx.funcMap.get("proc_exit")!;
  }

  // path_open(fd: i32, dirflags: i32, path: i32, path_len: i32, oflags: i32,
  //           rights_base: i64, rights_inheriting: i64, fdflags: i32, fd_out: i32) -> i32
  if (needsPathOpen) {
    const pathOpenType = addFuncType(
      ctx,
      [
        { kind: "i32" }, // fd (dirfd)
        { kind: "i32" }, // dirflags
        { kind: "i32" }, // path ptr
        { kind: "i32" }, // path len
        { kind: "i32" }, // oflags
        { kind: "i64" }, // rights_base
        { kind: "i64" }, // rights_inheriting
        { kind: "i32" }, // fdflags
        { kind: "i32" }, // fd_out ptr
      ],
      [{ kind: "i32" }],
      "$wasi_path_open",
    );
    addImport(ctx, "wasi_snapshot_preview1", "path_open", { kind: "func", typeIdx: pathOpenType });
    ctx.wasiPathOpenIdx = ctx.funcMap.get("path_open")!;

    // fd_close(fd: i32) -> i32
    const fdCloseType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$wasi_fd_close");
    addImport(ctx, "wasi_snapshot_preview1", "fd_close", { kind: "func", typeIdx: fdCloseType });
    ctx.wasiFdCloseIdx = ctx.funcMap.get("fd_close")!;
  }

  // Register a helper function: __wasi_write_string(strPtr: i32, strLen: i32) -> void
  // This writes to stdout (fd=1) using fd_write
  if (needsFdWrite) {
    emitWasiWriteStringHelper(ctx);
  }

  // Register __wasi_write_file_sync(pathPtr, pathLen, dataPtr, dataLen) helper
  if (needsPathOpen) {
    emitWasiWriteFileSyncHelper(ctx);
  }
}

/** Emit __wasi_write_string(ptr: i32, len: i32) helper that calls fd_write(1, iov, 1, nwritten) */
function emitWasiWriteStringHelper(ctx: CodegenContext): void {
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_string", funcIdx);

  // Parameters: 0=ptr, 1=len
  // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }
  // nwritten at memory[8]
  const body: Instr[] = [
    // Store ptr at memory[0] (iovec.buf)
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // Store len at memory[4] (iovec.buf_len)
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // Call fd_write(fd=1, iovs=0, iovs_len=1, nwritten=8)
    { op: "i32.const", value: 1 } as Instr, // fd = stdout
    { op: "i32.const", value: 0 } as Instr, // iovs pointer
    { op: "i32.const", value: 1 } as Instr, // iovs_len = 1
    { op: "i32.const", value: 8 } as Instr, // nwritten pointer
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr, // drop the return value (errno)
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_string",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * Emit __wasi_write_file_sync(pathPtr: i32, pathLen: i32, dataPtr: i32, dataLen: i32) helper.
 * Opens a file via path_open, writes data via fd_write, then closes via fd_close.
 *
 * WASI path_open signature:
 *   path_open(dirfd, dirflags, path, path_len, oflags, rights_base, rights_inheriting, fdflags, fd_out) -> errno
 *
 * Memory layout (scratch area 0-1023):
 *   [0..3]   = iovec.buf (ptr to data)
 *   [4..7]   = iovec.buf_len
 *   [8..11]  = nwritten (output from fd_write)
 *   [12..15] = opened fd (output from path_open)
 */
function emitWasiWriteFileSyncHelper(ctx: CodegenContext): void {
  // params: pathPtr(0), pathLen(1), dataPtr(2), dataLen(3)
  // locals: openedFd(4)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_file_sync", funcIdx);

  const body: Instr[] = [
    // 1. Call path_open to open the file for writing
    //    path_open(dirfd=3, dirflags=0, path, path_len,
    //              oflags=O_CREAT|O_TRUNC(=9), rights_base=FD_WRITE(=64),
    //              rights_inheriting=0, fdflags=0, fd_out=12)

    { op: "i32.const", value: 3 } as Instr, // dirfd = 3 (first preopen)
    { op: "i32.const", value: 0 } as Instr, // dirflags = 0
    { op: "local.get", index: 0 } as Instr, // path ptr
    { op: "local.get", index: 1 } as Instr, // path len
    { op: "i32.const", value: 9 } as Instr, // oflags = O_CREAT(1) | O_TRUNC(8) = 9
    { op: "i64.const", value: 64n } as unknown as Instr, // rights_base = RIGHT_FD_WRITE(64)
    { op: "i64.const", value: 0n } as unknown as Instr, // rights_inheriting = 0
    { op: "i32.const", value: 0 } as Instr, // fdflags = 0
    { op: "i32.const", value: 12 } as Instr, // fd_out ptr at memory[12]
    { op: "call", funcIdx: ctx.wasiPathOpenIdx } as Instr,
    { op: "drop" } as Instr, // drop errno

    // 2. Load the opened fd from memory[12]
    { op: "i32.const", value: 12 } as Instr,
    { op: "i32.load", align: 2, offset: 0 } as Instr,
    { op: "local.set", index: 4 } as Instr, // store in local openedFd

    // 3. Set up iovec for fd_write: iovec at memory[0]
    //    iovec.buf = dataPtr, iovec.buf_len = dataLen
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: 2 } as Instr, // dataPtr
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: 3 } as Instr, // dataLen
    { op: "i32.store", align: 2, offset: 0 } as Instr,

    // 4. Call fd_write(openedFd, iovs=0, iovs_len=1, nwritten=8)
    { op: "local.get", index: 4 } as Instr, // fd = openedFd
    { op: "i32.const", value: 0 } as Instr, // iovs pointer
    { op: "i32.const", value: 1 } as Instr, // iovs_len = 1
    { op: "i32.const", value: 8 } as Instr, // nwritten pointer
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr, // drop errno

    // 5. Call fd_close(openedFd)
    { op: "local.get", index: 4 } as Instr, // fd = openedFd
    { op: "call", funcIdx: ctx.wasiFdCloseIdx } as Instr,
    { op: "drop" } as Instr, // drop errno
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_file_sync",
    typeIdx: funcTypeIdx,
    locals: [{ name: "openedFd", type: { kind: "i32" } }],
    body,
    exported: false,
  });
}

/** Scan source for .toString() / .toFixed() on number types and register needed imports */
function collectPrimitiveMethodImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
      const methodName = prop.name.text;
      if (isNumberType(receiverType) && methodName === "toString") {
        needed.add("number_toString");
      }
      if (isNumberType(receiverType) && methodName === "toFixed") {
        needed.add("number_toFixed");
      }
      if (isNumberType(receiverType) && methodName === "toPrecision") {
        needed.add("number_toPrecision");
      }
      if (isNumberType(receiverType) && methodName === "toExponential") {
        needed.add("number_toExponential");
      }
      // Detect Number.prototype.method.call/apply patterns
      if ((methodName === "call" || methodName === "apply") && ts.isPropertyAccessExpression(prop.expression)) {
        const innerProp = prop.expression;
        const innerMethodName = innerProp.name.text;
        if (
          ts.isPropertyAccessExpression(innerProp.expression) &&
          innerProp.expression.name.text === "prototype" &&
          ts.isIdentifier(innerProp.expression.expression) &&
          innerProp.expression.expression.text === "Number"
        ) {
          if (innerMethodName === "toString") needed.add("number_toString");
          if (innerMethodName === "toFixed") needed.add("number_toFixed");
          if (innerMethodName === "toPrecision") needed.add("number_toPrecision");
          if (innerMethodName === "toExponential") needed.add("number_toExponential");
        }
      }
    }
    // Template expressions with number/boolean/bigint substitutions need number_toString
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const spanType = ctx.checker.getTypeAtLocation(span.expression);
        if (isNumberType(spanType) || isBooleanType(spanType) || isBigIntType(spanType)) {
          needed.add("number_toString");
        }
      }
    }
    // String(expr) calls need number_toString for number→string coercion
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "String" &&
      node.arguments.length >= 1
    ) {
      const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (isNumberType(argType) || !isStringType(argType)) {
        needed.add("number_toString");
      }
    }
    // String + non-string concatenation needs number_toString for coercion.
    // Conservative: register whenever either side of + is a string and the
    // other is not (could be number, any, boolean — all may produce f64 at wasm level).
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      if (isStringType(leftType) && !isStringType(rightType)) {
        needed.add("number_toString");
      }
      if (!isStringType(leftType) && isStringType(rightType)) {
        needed.add("number_toString");
      }
      // For `any`-typed variables (e.g. `var __str; __str=""`), the left type
      // won't be detected as string, but at runtime it may hold a string.
      // When += is used with an `any`-typed LHS and a non-string RHS,
      // register number_toString so the coercion is available at codegen time.
      if (
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        (leftType.flags & ts.TypeFlags.Any) !== 0 &&
        !isStringType(rightType)
      ) {
        needed.add("number_toString");
      }
    }
    // String comparison operators (< > <= >=) on string types need string_compare import
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
        node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      if (isStringType(leftType)) {
        needed.add("string_compare");
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  if (needed.has("number_toString")) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toFixed")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toFixed", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toPrecision")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toPrecision", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toExponential")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toExponential", { kind: "func", typeIdx: t });
  }
  if (needed.has("string_compare") && !ctx.nativeStrings) {
    // In native strings mode, __str_compare Wasm helper handles this — no host import needed
    const t = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "string_compare", { kind: "func", typeIdx: t });
  }
}

// String method signatures: name → { params (excluding self), resultKind }
export const STRING_METHODS: Record<string, { params: ValType[]; result: ValType }> = {
  toUpperCase: { params: [], result: { kind: "externref" } },
  toLowerCase: { params: [], result: { kind: "externref" } },
  trim: { params: [], result: { kind: "externref" } },
  trimStart: { params: [], result: { kind: "externref" } },
  trimEnd: { params: [], result: { kind: "externref" } },
  charAt: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  slice: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  substring: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  indexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  lastIndexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  includes: { params: [{ kind: "externref" }], result: { kind: "i32" } },
  startsWith: { params: [{ kind: "externref" }], result: { kind: "i32" } },
  endsWith: { params: [{ kind: "externref" }], result: { kind: "i32" } },
  replace: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  replaceAll: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  repeat: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  padStart: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  padEnd: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  split: { params: [{ kind: "externref" }], result: { kind: "externref" } },
  match: { params: [{ kind: "externref" }], result: { kind: "externref" } },
  search: { params: [{ kind: "externref" }], result: { kind: "f64" } },
  at: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  codePointAt: { params: [{ kind: "f64" }], result: { kind: "f64" } },
  normalize: { params: [{ kind: "externref" }], result: { kind: "externref" } },
};

/** Scan source for method calls on string types and register needed imports */
function collectStringMethodImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();
  /** Methods called with RegExp args — need host import even in native strings mode */
  const regexpArgMethods = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
      const methodName = prop.name.text;
      if (isStringType(receiverType) && Object.prototype.hasOwnProperty.call(STRING_METHODS, methodName)) {
        needed.add(methodName);
        // Track if the method has a RegExp arg (replace, replaceAll, split, match, search)
        if (
          (methodName === "replace" ||
            methodName === "replaceAll" ||
            methodName === "split" ||
            methodName === "match" ||
            methodName === "search") &&
          node.arguments.length > 0
        ) {
          const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
          const symName = argType.getSymbol()?.getName();
          if (symName === "RegExp") {
            regexpArgMethods.add(methodName);
          }
        }
      }
      // Detect String.prototype.method.call(str, ...) and String.prototype.method.apply(str, ...)
      // These patterns rewrite to str.method(...) at compile time, so we need the import
      if ((methodName === "call" || methodName === "apply") && ts.isPropertyAccessExpression(prop.expression)) {
        const innerProp = prop.expression;
        const innerMethodName = innerProp.name.text;
        if (
          ts.isPropertyAccessExpression(innerProp.expression) &&
          innerProp.expression.name.text === "prototype" &&
          ts.isIdentifier(innerProp.expression.expression) &&
          innerProp.expression.expression.text === "String" &&
          Object.prototype.hasOwnProperty.call(STRING_METHODS, innerMethodName)
        ) {
          needed.add(innerMethodName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  // Native string methods handled in wasm (native strings mode)
  const NATIVE_STR_METHODS = new Set([
    "charAt",
    "substring",
    "slice",
    "at",
    "indexOf",
    "lastIndexOf",
    "includes",
    "startsWith",
    "endsWith",
    "trim",
    "trimStart",
    "trimEnd",
    "repeat",
    "padStart",
    "padEnd",
    "toLowerCase",
    "toUpperCase",
    "replace",
    "replaceAll",
    "split",
    "codePointAt",
    "normalize",
  ]);

  for (const method of needed) {
    if (ctx.nativeStrings && NATIVE_STR_METHODS.has(method) && !regexpArgMethods.has(method)) {
      // These are handled by native string helpers — no import needed
      ensureNativeStringHelpers(ctx);
      continue;
    }
    if (ctx.nativeStrings && NATIVE_STR_METHODS.has(method) && regexpArgMethods.has(method)) {
      // Need BOTH native helpers AND host import for RegExp-arg calls
      ensureNativeStringHelpers(ctx);
    }
    const sig = STRING_METHODS[method]!;
    const params: ValType[] = [{ kind: "externref" }, ...sig.params]; // self + args
    const t = addFuncType(ctx, params, [sig.result]);
    addImport(ctx, "env", `string_${method}`, { kind: "func", typeIdx: t });
  }

  // split()/match() return externref JS arrays — register __extern_get and __extern_length
  // so that element access and .length work on the result.
  // With native strings, split returns a native string array — no extern helpers needed.
  if ((needed.has("split") || needed.has("match")) && !ctx.nativeStrings) {
    if (!ctx.funcMap.has("__extern_get")) {
      const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    }
    if (!ctx.funcMap.has("__extern_length")) {
      const lenType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__extern_length", { kind: "func", typeIdx: lenType });
    }
  }
}

/** Register wasm:js-string builtin imports (called on demand when strings are used) */
export function addStringImports(ctx: CodegenContext): void {
  if (ctx.hasStringImports) return;
  ctx.hasStringImports = true;

  // Record import count before adding so we can shift function indices
  // if this is called after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // concat: (externref, externref) -> (ref extern)
  const concatType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "ref_extern" }]);
  addImport(ctx, "wasm:js-string", "concat", {
    kind: "func",
    typeIdx: concatType,
  });

  // length: (externref) -> i32
  const lengthType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "length", {
    kind: "func",
    typeIdx: lengthType,
  });

  // equals: (externref, externref) -> i32
  const equalsType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "equals", {
    kind: "func",
    typeIdx: equalsType,
  });

  // substring: (externref, i32, i32) -> (ref extern)
  const substringType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "ref_extern" }],
  );
  addImport(ctx, "wasm:js-string", "substring", {
    kind: "func",
    typeIdx: substringType,
  });

  // charCodeAt: (externref, i32) -> i32
  const charCodeAtType = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "charCodeAt", {
    kind: "func",
    typeIdx: charCodeAtType,
  });

  // Store wasm:js-string import indices separately so user-defined functions
  // with the same name (e.g. user's "charCodeAt") don't shadow them (#1072).
  for (const name of ["concat", "length", "equals", "substring", "charCodeAt"]) {
    const idx = ctx.funcMap.get(name);
    if (idx !== undefined) ctx.jsStringImports.set(name, idx);
  }

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    const newImportNames = new Set(["concat", "length", "equals", "substring", "charCodeAt"]);
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && idx >= importsBefore) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
        exp.desc.index += delta;
      }
    }
    // Track ALL instruction arrays (top-level AND nested) to prevent
    // double-shifting when fctx.body is a nested block reachable from savedBodies (#1109).
    const shifted = new Set<Instr[]>();
    function shiftFuncIndices(instrs: Instr[]): void {
      if (shifted.has(instrs)) return;
      shifted.add(instrs);
      for (const instr of instrs) {
        if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        const a = instr as any;
        if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
        if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
        if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
        if (a.catches && Array.isArray(a.catches)) {
          for (const c of a.catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      shiftFuncIndices(ctx.currentFunc.body);
      for (const sb of ctx.currentFunc.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const parentFctx of ctx.funcStack) {
      shiftFuncIndices(parentFctx.body);
      for (const sb of parentFctx.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const pb of ctx.parentBodiesStack) {
      shiftFuncIndices(pb);
    }
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (elem.funcIndices[i]! >= importsBefore) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) => (idx >= importsBefore ? idx + delta : idx));
    }
  }
}

// Register addStringImports so any-helpers.ts can call it via the delegate
// (breaks circular dep: index.ts → any-helpers.ts → shared.ts ← index.ts)
registerAddStringImports(addStringImports);

/** Parse a RegExp literal text (e.g. "/\\d+/gi") into pattern and flags */
export function parseRegExpLiteral(text: string): { pattern: string; flags: string } {
  // The text includes the leading '/' and trailing '/flags'.
  // Find the last '/' which separates pattern from flags.
  const lastSlash = text.lastIndexOf("/");
  const pattern = text.slice(1, lastSlash);
  const flags = text.slice(lastSlash + 1);
  return { pattern, flags };
}

/** Scan source for string literals and register env imports for each unique one */
/** Scan source for string literals and register string_constants global imports */
function collectStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();
  let hasTypeofExpr = false;
  let hasTaggedTemplate = false;

  function visit(node: ts.Node) {
    // Skip computed property names — their string literals are resolved at
    // compile time and never appear as runtime values in the wasm output.
    if (ts.isComputedPropertyName(node)) return;

    if (ts.isStringLiteral(node)) {
      literals.add(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.add(node.text);
    }
    // Template expressions: collect head and span literal texts (include empty strings)
    if (ts.isTemplateExpression(node)) {
      literals.add(node.head.text);
      for (const span of node.templateSpans) {
        literals.add(span.literal.text);
      }
    }
    // Tagged template expressions: collect ALL string parts (including empty strings)
    // because tagged templates pass the full strings array to the tag function.
    // Also collect rawText values for the .raw property on template objects.
    // Register the template vec type early so tag function bodies can access .raw.
    if (ts.isTaggedTemplateExpression(node)) {
      hasTaggedTemplate = true;
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        literals.add(node.template.text);
        const rawText = (node.template as any).rawText;
        if (rawText !== undefined) literals.add(rawText);
      } else if (ts.isTemplateExpression(node.template)) {
        literals.add(node.template.head.text); // include empty strings
        const headRaw = (node.template.head as any).rawText;
        if (headRaw !== undefined) literals.add(headRaw);
        for (const span of node.template.templateSpans) {
          literals.add(span.literal.text); // include empty strings
          const spanRaw = (span.literal as any).rawText;
          if (spanRaw !== undefined) literals.add(spanRaw);
        }
      }
    }
    // RegExp literals: collect pattern and flags as string literals
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const { pattern, flags } = parseRegExpLiteral(node.getText());
      literals.add(pattern);
      if (flags) literals.add(flags);
    }
    // typeof expressions need type-name string constants
    if (ts.isTypeOfExpression(node)) {
      hasTypeofExpr = true;
    }
    // import.meta needs placeholder strings
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta") {
      literals.add("module.wasm");
      literals.add("[object Object]");
    }
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  // typeof expressions may need type-name constants not present in source
  if (hasTypeofExpr) {
    for (const s of ["number", "string", "boolean", "object", "undefined", "function", "symbol"]) {
      literals.add(s);
    }
  }

  // Register the template vec type early so tag function bodies can use .raw
  if (hasTaggedTemplate) {
    getOrRegisterTemplateVecType(ctx);
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    // Native strings mode — ensure helpers are emitted, track literals
    // No wasm:js-string or string_constants imports needed
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      // Track literals in stringGlobalMap so compileStringLiteral can find them.
      // Use a sentinel value (-1) since we don't import globals in fast mode.
      if (!ctx.stringGlobalMap.has(value)) {
        ctx.stringGlobalMap.set(value, -1);
      }
    }
    return;
  }

  // Register wasm:js-string imports since we have strings
  addStringImports(ctx);

  // Register a global import from "string_constants" for each unique string literal
  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for for-in loops.
 *  Uses the type checker to get property names (runs before collectDeclarations). */
function collectForInStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isForInStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const props = exprType.getProperties();
      for (const prop of props) {
        if (!ctx.stringGlobalMap.has(prop.name)) literals.add(prop.name);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  // Ensure wasm:js-string imports exist (may already be registered)
  addStringImports(ctx);

  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for `key in obj` expressions
 *  where the key is a dynamic (non-literal) value. Pre-registers field names
 *  so they can be used for runtime string comparison. */
function collectInExprStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      // Only collect for dynamic keys (non-string-literal, non-numeric-literal)
      if (!ts.isStringLiteral(node.left) && !ts.isNumericLiteral(node.left)) {
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        const props = rightType.getProperties();
        for (const prop of props) {
          if (!ctx.stringGlobalMap.has(prop.name)) literals.add(prop.name);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  addStringImports(ctx);
  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for Object.keys() / Object.values() calls.
 *  Detects Object.keys(expr) and Object.values(expr) patterns and pre-registers
 *  the field names from the argument's type as string thunks. */
function collectObjectMethodStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();
  let hasValues = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      (node.expression.name.text === "keys" ||
        node.expression.name.text === "values" ||
        node.expression.name.text === "entries") &&
      node.arguments.length === 1
    ) {
      if (node.expression.name.text === "values" || node.expression.name.text === "entries") hasValues = true;
      const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      const props = argType.getProperties();
      for (const prop of props) {
        if (!ctx.stringLiteralMap.has(prop.name)) literals.add(prop.name);
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  // Object.values() needs union boxing imports (__box_number etc.)
  // to box primitive field values into externref. Register them now
  // before function indices are assigned in collectDeclarations.
  if (hasValues) {
    addUnionImports(ctx);
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  // Ensure wasm:js-string imports exist (may already be registered)
  addStringImports(ctx);

  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Math methods that need host imports (no native Wasm opcode) */
export const MATH_HOST_METHODS_1ARG = new Set([
  "exp",
  "log",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "acosh",
  "asinh",
  "atanh",
  "cbrt",
  "expm1",
  "log1p",
]);
export const MATH_HOST_METHODS_2ARG = new Set(["pow", "atan2"]);

/** Scan source for Math.xxx() calls that need host imports */
function collectMathImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();

  let needsToUint32 = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Math"
    ) {
      const method = node.expression.name.text;
      if (MATH_HOST_METHODS_1ARG.has(method) || MATH_HOST_METHODS_2ARG.has(method) || method === "random") {
        needed.add(method);
      }
      // clz32 and imul need __toUint32 for spec-correct ToUint32 conversion
      if (method === "clz32" || method === "imul") {
        needsToUint32 = true;
      }
    }
    // ** and **= operators need Math.pow
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
    ) {
      needed.add("pow");
    }
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  for (const method of needed) {
    if (method === "random") {
      // Math.random requires entropy — must remain a host import
      const typeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);
      addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
    } else {
      // All other math methods get pure Wasm implementations
      ctx.pendingMathMethods.add(method);
    }
  }

  // ToUint32: defer until after all imports are added; see emitToUint32Helper.
  if (needsToUint32) {
    ctx.needsToUint32 = true;
  }
}

/**
 * Emit the __toUint32 Wasm helper function. Must be called AFTER all imports
 * that are added directly via addImport (bypassing ensureLateImport's shift
 * mechanism) have been registered, and BEFORE any user function body that
 * calls Math.clz32 or Math.imul is compiled. Emitting earlier leaves a stale
 * funcMap entry because addImport does not shift defined-function indices.
 *
 * Implements ES §7.1.7: NaN/±Infinity → 0, otherwise trunc(x) modulo 2^32.
 */
export function emitToUint32Helper(ctx: CodegenContext): void {
  if (!ctx.needsToUint32) return;
  if (ctx.funcMap.has("__toUint32")) return;
  const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__toUint32", funcIdx);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 0 },
    { op: "f64.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "f64.abs" },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "i64.trunc_sat_f64_s" } as unknown as Instr,
    { op: "i32.wrap_i64" },
  ];
  ctx.mod.functions.push({
    name: "__toUint32",
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/** Scan source for parseInt / parseFloat / Number() / unary + on strings and register host imports */
function collectParseImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "parseInt" || name === "parseFloat") {
        needed.add(name);
      }
      // Number(x) uses parseFloat for string→number coercion
      if (name === "Number") {
        needed.add("parseFloat");
      }
    }
    // Unary + on string uses parseFloat for coercion (but not for string literals
    // which are statically resolved by tryStaticToNumber)
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.PlusToken &&
      !ts.isStringLiteral(node.operand) &&
      !ts.isNoSubstitutionTemplateLiteral(node.operand)
    ) {
      const operandType = ctx.checker.getTypeAtLocation(node.operand);
      if (operandType.flags & ts.TypeFlags.StringLike) {
        needed.add("parseFloat");
      }
    }
    // Loose equality (== / !=) between string and number/boolean needs parseFloat
    // to coerce the string operand to a number for comparison (#178)
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      try {
        const leftType = ctx.checker.getTypeAtLocation(node.left);
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        const leftIsStr = isStringType(leftType);
        const rightIsStr = isStringType(rightType);
        const leftIsNumOrBool = isNumberType(leftType) || isBooleanType(leftType);
        const rightIsNumOrBool = isNumberType(rightType) || isBooleanType(rightType);
        if ((leftIsStr && rightIsNumOrBool) || (rightIsStr && leftIsNumOrBool)) {
          needed.add("parseFloat");
        }
      } catch {
        // Type resolution may fail for some nodes — skip
      }
    }
    // Arithmetic/bitwise operators on string operands need parseFloat (#430)
    if (ts.isBinaryExpression(node)) {
      const opKind = node.operatorToken.kind;
      const isArithOrBitwise =
        opKind === ts.SyntaxKind.MinusToken ||
        opKind === ts.SyntaxKind.AsteriskToken ||
        opKind === ts.SyntaxKind.AsteriskAsteriskToken ||
        opKind === ts.SyntaxKind.SlashToken ||
        opKind === ts.SyntaxKind.PercentToken ||
        opKind === ts.SyntaxKind.AmpersandToken ||
        opKind === ts.SyntaxKind.BarToken ||
        opKind === ts.SyntaxKind.CaretToken ||
        opKind === ts.SyntaxKind.LessThanLessThanToken ||
        opKind === ts.SyntaxKind.GreaterThanGreaterThanToken ||
        opKind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
      if (isArithOrBitwise) {
        try {
          const leftType = ctx.checker.getTypeAtLocation(node.left);
          const rightType = ctx.checker.getTypeAtLocation(node.right);
          if (isStringType(leftType) || isStringType(rightType)) {
            needed.add("parseFloat");
          }
        } catch {
          // Type resolution may fail — skip
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  ts.forEachChild(sourceFile, visit);

  for (const name of needed) {
    if (name === "parseInt") {
      // (externref, f64) -> f64  — radix is NaN when omitted
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    } else {
      // (externref) -> f64
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    }
  }
}

/** Known constructors handled natively (not needing __new_ imports) */
export const KNOWN_CONSTRUCTORS = new Set([
  "Array",
  "Date",
  "Map",
  "Set",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "Test262Error",
  "Object",
  "Function",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Number",
  "String",
  "Boolean",
  "ArrayBuffer",
  "DataView",
  "Proxy",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
]);

/**
 * Scan source for `new X(args...)` where X is not a locally declared class
 * or known extern class, and register `__new_X` host imports so the runtime
 * can provide the constructor.
 */
function collectUnknownConstructorImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Map from constructor name to arg count (max seen)
  const needed = new Map<string, number>();

  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (!KNOWN_CONSTRUCTORS.has(name)) {
        // Check if it's a class declared in this source file
        const sym = ctx.checker.getSymbolAtLocation(node.expression);
        const decls = sym?.getDeclarations() ?? [];
        const isLocalClass = decls.some((d) => {
          if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) return d.getSourceFile() === sourceFile;
          // const Vec2 = class { ... } — variable whose initializer is a class expression
          if (ts.isVariableDeclaration(d) && d.initializer && ts.isClassExpression(d.initializer))
            return d.getSourceFile() === sourceFile;
          return false;
        });
        const isExtern = ctx.externClasses.has(name);
        if (!isLocalClass && !isExtern) {
          const argCount = node.arguments?.length ?? 0;
          const prev = needed.get(name) ?? 0;
          needed.set(name, Math.max(prev, argCount));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  for (const [name, argCount] of needed) {
    const importName = `__new_${name}`;
    if (ctx.funcMap.has(importName)) continue;
    const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
    const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }
}

/**
 * Scan source for `new Number(x)`, `new String(x)`, `new Boolean(x)` and
 * register wrapper struct types so that resolveWasmType returns the correct
 * ref type for wrapper-typed variables.
 */
function collectWrapperConstructors(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "Number" || name === "String" || name === "Boolean") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  if (found) {
    ensureWrapperTypes(ctx);
  }
}

/** Scan source for String.fromCharCode() calls and register host import */
function collectStringStaticImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let needsFromCharCode = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "String" &&
      node.expression.name.text === "fromCharCode"
    ) {
      needsFromCharCode = true;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (needsFromCharCode) {
    // (f64) -> externref  (char code -> string)
    const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx });
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
    }
  }
}

/** Scan source for Promise.all / Promise.race / Promise.resolve / Promise.reject
 *  calls and `new Promise(...)` constructor usage, and register host imports */
function collectPromiseImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();
  let needConstructor = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Promise"
    ) {
      const method = node.expression.name.text;
      if (method === "all" || method === "race" || method === "resolve" || method === "reject") {
        needed.add(method);
      }
    }
    // NOTE: Promise instance methods (.then/.catch/.finally) not detected here.
    // See #855 regression fix — pre-registering them shifts type indices.
    // Detect `new Promise(...)`
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") {
      needConstructor = true;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
    // Also visit top-level variable declarations and expressions
    if (ts.isVariableStatement(stmt)) {
      visit(stmt);
    }
    if (ts.isExpressionStatement(stmt)) {
      visit(stmt);
    }
    if (ts.isReturnStatement(stmt)) {
      visit(stmt);
    }
  }

  for (const method of needed) {
    const importName = `Promise_${method}`;
    if (!ctx.funcMap.has(importName)) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
  }

  // Register Promise instance methods: .then(cb) and .catch(cb)
  // These are detected from calls on Promise-typed values (e.g. p.then(...))
  for (const method of needed) {
    if (method === "then" || method === "catch") {
      const importName = `Promise_${method}`;
      if (!ctx.funcMap.has(importName)) {
        // Promise_then(promise, callback) -> promise
        // Promise_catch(promise, callback) -> promise
        const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        addImport(ctx, "env", importName, { kind: "func", typeIdx });
      }
    }
  }

  // Register new Promise() constructor import: (externref) -> externref
  if (needConstructor && !ctx.funcMap.has("Promise_new")) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "Promise_new", { kind: "func", typeIdx });
  }
}

/** Scan source for JSON.parse / JSON.stringify calls and register host imports */
function collectJsonImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let needStringify = false;
  let needParse = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "JSON"
    ) {
      const method = node.expression.name.text;
      if (method === "stringify") needStringify = true;
      if (method === "parse") needParse = true;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (needStringify || needParse) {
    addUnionImports(ctx);
  }
  if (needStringify) {
    // (value: externref, replacer: externref, space: externref) -> externref
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
  if (needParse) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx });
  }
}

/** Scan source for arrow functions used as call arguments and register __make_callback import */
function collectCallbackImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (found) break;
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (found) {
    // __make_callback: (i32, externref) → externref
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
  }
}

/** Scan source for generator functions (function*) and register generator host imports */
function collectGeneratorImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visitNode(node: ts.Node): void {
    if (found) return;
    // Generator function declarations: function* foo() { ... }
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body && !hasDeclareModifier(node)) {
      found = true;
      return;
    }
    // Generator function expressions: const gen = function*() { ... }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      return;
    }
    // Generator class methods: class Foo { *bar() { ... } }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    ts.forEachChild(node, visitNode);
  }

  for (const stmt of sourceFile.statements) {
    visitNode(stmt);
    if (found) break;
  }

  if (found && !ctx.funcMap.has("__gen_create_buffer")) {
    // __gen_create_buffer: () → externref  (creates an empty JS array)
    const bufType = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_create_buffer", {
      kind: "func",
      typeIdx: bufType,
    });

    // __gen_push_f64: (externref, f64) → void  (pushes a number to the buffer)
    const pushF64Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], []);
    addImport(ctx, "env", "__gen_push_f64", {
      kind: "func",
      typeIdx: pushF64Type,
    });

    // __gen_push_i32: (externref, i32) → void  (pushes a boolean to the buffer)
    const pushI32Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], []);
    addImport(ctx, "env", "__gen_push_i32", {
      kind: "func",
      typeIdx: pushI32Type,
    });

    // __gen_push_ref: (externref, externref) → void  (pushes a string/object to the buffer)
    const pushRefType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
    addImport(ctx, "env", "__gen_push_ref", {
      kind: "func",
      typeIdx: pushRefType,
    });

    // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
    addImport(ctx, "env", "__gen_yield_star", {
      kind: "func",
      typeIdx: pushRefType, // same signature as push_ref: (buf, iterable) → void
    });

    // __create_generator: (buf: externref, pendingThrow: externref) → externref
    // Takes a buffer of yielded values and an optional pending exception,
    // returns a Generator-like object that defers the throw to the first next() call.
    const createGenType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__create_generator", {
      kind: "func",
      typeIdx: createGenType,
    });
    // __create_async_generator: same Wasm signature, but .next()/.return()/.throw() return Promises.
    addImport(ctx, "env", "__create_async_generator", {
      kind: "func",
      typeIdx: createGenType,
    });

    const genType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    // __gen_next: (generator: externref) → externref (calls gen.next(), returns IteratorResult)
    addImport(ctx, "env", "__gen_next", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_return: (generator: externref, value: externref) → externref (calls gen.return(value), returns IteratorResult)
    const genReturnType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_return", {
      kind: "func",
      typeIdx: genReturnType,
    });

    // __gen_throw: (generator: externref, error: externref) → externref (calls gen.throw(error), returns IteratorResult)
    addImport(ctx, "env", "__gen_throw", {
      kind: "func",
      typeIdx: genReturnType,
    });

    // __gen_result_value: (result: externref) → externref (returns result.value)
    addImport(ctx, "env", "__gen_result_value", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_result_value_f64: (result: externref) → f64 (returns result.value as number)
    const resultValF64Type = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
    addImport(ctx, "env", "__gen_result_value_f64", {
      kind: "func",
      typeIdx: resultValF64Type,
    });

    // __gen_result_done: (result: externref) → i32 (returns result.done as boolean)
    const resultDoneType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "__gen_result_done", {
      kind: "func",
      typeIdx: resultDoneType,
    });

    // Ensure __get_caught_exception is available for generator body try/catch wrappers
    if (!ctx.funcMap.has("__get_caught_exception")) {
      const getCaughtType = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", "__get_caught_exception", {
        kind: "func",
        typeIdx: getCaughtType,
      });
    }
  }
}

/** Functional array methods that need host callback bridges */
export const FUNCTIONAL_ARRAY_METHODS = new Set([
  "filter",
  "map",
  "reduce",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
]);

/** Scan source for functional array methods (filter, map, etc.) and register __call_Nf64 imports */
function collectFunctionalArrayImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let need1 = false;
  let need2 = false;

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (FUNCTIONAL_ARRAY_METHODS.has(method)) {
        if (method === "reduce") {
          need2 = true;
        } else {
          need1 = true;
        }
      }
      // Also detect Array.prototype.METHOD.call(...) pattern
      if (method === "call" && ts.isPropertyAccessExpression(node.expression.expression)) {
        const innerMethod = node.expression.expression.name.text;
        if (FUNCTIONAL_ARRAY_METHODS.has(innerMethod)) {
          if (innerMethod === "reduce") {
            need2 = true;
          } else {
            need1 = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (need1) {
    if (ctx.fast) {
      // __call_1_i32: (externref, i32) → i32 — invoke callback with 1 i32 arg (fast mode)
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_1_i32", { kind: "func", typeIdx });
    } else {
      // __call_1_f64: (externref, f64) → f64 — invoke callback with 1 f64 arg
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_1_f64", { kind: "func", typeIdx });
    }
  }

  if (need2) {
    if (ctx.fast) {
      // __call_2_i32: (externref, i32, i32) → i32 — invoke callback with 2 i32 args (fast mode)
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_2_i32", { kind: "func", typeIdx });
    } else {
      // __call_2_f64: (externref, f64, f64) → f64 — invoke callback with 2 f64 args
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_2_f64", { kind: "func", typeIdx });
    }
  }
}

/** Scan source for union types (number | string, etc.) and register needed helper imports */
function collectUnionImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    // Check function parameter types for heterogeneous unions
    if (ts.isFunctionDeclaration(node) && node.parameters) {
      for (const param of node.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        if (isHeterogeneousUnion(paramType, ctx.checker)) {
          found = true;
          return;
        }
      }
    }
    // Check variable declarations for union types
    if (ts.isVariableDeclaration(node) && node.type) {
      const varType = ctx.checker.getTypeAtLocation(node);
      if (isHeterogeneousUnion(varType, ctx.checker)) {
        found = true;
        return;
      }
    }
    // Check for typeof expressions (used in narrowing)
    if (ts.isTypeOfExpression(node)) {
      found = true;
      return;
    }
    // Generator functions use externref-based iteration which triggers
    // ensureI32Condition with externref → needs __is_truthy from union imports
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      return;
    }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    // for-of on non-array types uses externref iterator protocol which
    // may trigger ensureI32Condition with externref
    if (ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
        visit(decl);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (found) {
    addUnionImports(ctx);
  }
}

/** Register union type helper imports (typeof checks, boxing/unboxing) */
export function addUnionImports(ctx: CodegenContext): void {
  if (ctx.hasUnionImports) return;
  ctx.hasUnionImports = true;

  // Under `--target wasi` (#1180): emit Wasm-native implementations of the
  // box / unbox / typeof / is_truthy helpers instead of `env::*` host
  // imports, since wasmtime cannot satisfy the env::* imports without a JS
  // host. The native impls preserve the same name + signature so existing
  // call sites (`ctx.funcMap.get("__unbox_number")` etc.) work unchanged.
  // Same dual-mode pattern as #679 (strings) and #682 (RegExp).
  if (ctx.wasi) {
    addUnionImportsAsNativeFuncs(ctx);
    return;
  }

  // Record the import count before adding, so we can adjust defined-function
  // indices if imports are added after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // __typeof_number: (externref) → i32
  const typeofType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__typeof_number", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_string", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_undefined", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_object", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_function", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __is_truthy: (externref) → i32
  addImport(ctx, "env", "__is_truthy", { kind: "func", typeIdx: typeofType });

  // __unbox_number: (externref) → f64
  const unboxNumType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  addImport(ctx, "env", "__unbox_number", {
    kind: "func",
    typeIdx: unboxNumType,
  });

  // __unbox_boolean: (externref) → i32
  addImport(ctx, "env", "__unbox_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __box_number: (f64) → externref
  const boxNumType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxNumType });

  // __box_boolean: (i32) → externref
  const boxBoolType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_boolean", {
    kind: "func",
    typeIdx: boxBoolType,
  });

  // __typeof: (externref) → externref (returns type string)
  const typeofStrType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__typeof", {
    kind: "func",
    typeIdx: typeofStrType,
  });

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices and fix exports/funcMap/call instructions.
  // The new imports themselves (at indices importsBefore..numImportFuncs-1) are already
  // correct, so we only shift indices that were >= importsBefore BEFORE the addition,
  // i.e., the defined functions that start at index importsBefore in the old scheme.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    // Build a set of the new import names to skip them during funcMap update
    const newImportNames = new Set([
      "__typeof_number",
      "__typeof_string",
      "__typeof_boolean",
      "__typeof_undefined",
      "__typeof_object",
      "__typeof_function",
      "__is_truthy",
      "__unbox_number",
      "__unbox_boolean",
      "__box_number",
      "__box_boolean",
      "__typeof",
    ]);
    // Update funcMap entries for defined functions (not imports)
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && idx >= importsBefore) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    // Update export indices
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
        exp.desc.index += delta;
      }
    }
    // Track ALL instruction arrays (top-level AND nested) to prevent
    // double-shifting when fctx.body is a nested block reachable from savedBodies (#1109).
    const shifted = new Set<Instr[]>();
    function shiftFuncIndices(instrs: Instr[]): void {
      if (shifted.has(instrs)) return;
      shifted.add(instrs);
      for (const instr of instrs) {
        if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        const a = instr as any;
        if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
        if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
        if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
        if (a.catches && Array.isArray(a.catches)) {
          for (const c of a.catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      shiftFuncIndices(ctx.currentFunc.body);
      for (const sb of ctx.currentFunc.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const parentFctx of ctx.funcStack) {
      shiftFuncIndices(parentFctx.body);
      for (const sb of parentFctx.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const pb of ctx.parentBodiesStack) {
      shiftFuncIndices(pb);
    }
    if (ctx.pendingInitBody) {
      shiftFuncIndices(ctx.pendingInitBody);
    }
    // Update table elements
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (elem.funcIndices[i]! >= importsBefore) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    // Update declaredFuncRefs
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) => (idx >= importsBefore ? idx + delta : idx));
    }
    // Update Wasm start function index (#907) — late-added imports shift the
    // defined-function index that __module_init lives at.
    if (ctx.mod.startFuncIdx !== undefined && ctx.mod.startFuncIdx >= importsBefore) {
      ctx.mod.startFuncIdx += delta;
    }
  }
}

/**
 * Wasm-native implementation of the union helper functions (#1180).
 *
 * Used under `--target wasi`, where the standard `env::*` host imports
 * cannot be satisfied by wasmtime. Instead of importing the helpers, we
 * register a small set of WasmGC struct types (`__box_number_struct`,
 * `__box_boolean_struct`) plus a synthesized function for each helper
 * with the SAME name and signature as the host-mode import. Existing
 * call sites that look helpers up via `ctx.funcMap.get("__unbox_number")`
 * etc. transparently call the native version.
 *
 * Semantics mirror the JS host runtime where possible:
 *   - `__box_number(f64)` wraps the value in a `__box_number_struct` and
 *     converts to externref via `extern.convert_any`.
 *   - `__unbox_number(externref)` returns 0 for null (matches `Number(null)`),
 *     extracts the value if the externref is a `__box_number_struct`,
 *     otherwise returns `NaN` (matches `Number(opaque host value)`).
 *   - `__box_boolean(i32)` / `__unbox_boolean(externref)` mirror the
 *     number variants with an `i32` payload.
 *   - `__is_truthy(externref)` returns 0 for null and for boxed-zero /
 *     boxed-NaN / boxed-false; returns 1 for any other ref (any non-null
 *     reference is truthy in JS).
 *   - `__typeof_number/string/boolean(externref)` use `ref.test` against
 *     the appropriate boxed struct (string under wasi/nativeStrings is
 *     the NativeString struct at `ctx.anyStrTypeIdx`).
 *   - `__typeof_undefined(externref)` is `ref.is_null`.
 *   - `__typeof_object/function(externref)` are conservatively 0 — wasi
 *     binaries don't have a JS-side function or generic object value to
 *     surface here.
 *   - `__typeof(externref)` returns null externref. Producing a real
 *     type-tag string under nativeStrings would require constructing a
 *     NativeString per tag, which is deferred until a wasi caller
 *     actually needs the result of `typeof v` as a string. Today's
 *     callers either pre-fold the typeof at the AST level or compare
 *     against a string literal (which uses `__typeof_*` instead).
 *
 * Why a struct-based box rather than letting the externref carry a raw
 * f64: externref is opaque at the Wasm level — there's no way to read a
 * payload back out without going through the WasmGC any.* / ref.cast
 * machinery against a registered struct type. The struct gives us a
 * stable shape the unbox helper can pattern-match against, and the
 * `extern.convert_any` / `any.convert_extern` round-trip is a no-op at
 * the Wasm engine level.
 */
function addUnionImportsAsNativeFuncs(ctx: CodegenContext): void {
  // 1. Register the boxed-value struct types. Both are immutable singletons.
  const boxNumStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__box_number_struct",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
  });

  const boxBoolStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__box_boolean_struct",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  });

  // 2. Pre-compute func types — addFuncType de-dupes by signature so
  //    repeated calls return the same typeIdx.
  const externrefToI32 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  const externrefToF64 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  const f64ToExternref = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  const i32ToExternref = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  const externrefToExternref = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);

  /**
   * Synthesize a native helper function. The funcIdx is allocated as
   * `numImportFuncs + mod.functions.length` to match how every other
   * synthesized function (e.g. `__toUint32` from #1094) gets its slot.
   */
  const registerNative = (
    name: string,
    typeIdx: number,
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void => {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
  };

  // 3. __box_number(f64) -> externref
  registerNative("__box_number", f64ToExternref, [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: boxNumStructIdx },
    { op: "extern.convert_any" } as unknown as Instr,
  ]);

  // 4. __unbox_number(externref) -> f64
  //    Local 1 is an anyref temp used to ref.test then ref.cast without
  //    re-evaluating the parameter (which is fine — it's a local.get —
  //    but the temp shape mirrors the spec'd structure for symmetry).
  registerNative(
    "__unbox_number",
    externrefToF64,
    [
      // if (ref.is_null param) return 0   // Number(null) === 0
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: 0 }, { op: "return" }],
      },
      // any = any.convert_extern(param)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.tee", index: 1 },
      // if (ref.test $box_number_struct any) return any.value
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // not a recognized boxed number → NaN (matches Number(opaque))
      { op: "f64.const", value: NaN },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 5. __box_boolean(i32) -> externref
  registerNative("__box_boolean", i32ToExternref, [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: boxBoolStructIdx },
    { op: "extern.convert_any" } as unknown as Instr,
  ]);

  // 6. __unbox_boolean(externref) -> i32
  //    Returns the boxed value if it's a __box_boolean_struct, otherwise
  //    falls back to Boolean-coercion: null → false, any non-null ref
  //    that isn't a boxed bool → ALSO false (under wasi we don't
  //    distinguish other truthy refs at the unbox level; the runtime
  //    fallback in `helpers.ts` does `v ? 1 : 0` which would say true,
  //    but for unbox-as-typed-call-arg the safe default is false).
  //    Boxed numbers go through __unbox_number first, then truthy-check.
  registerNative(
    "__unbox_boolean",
    externrefToI32,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // not a boxed bool → false (conservative under wasi)
      { op: "i32.const", value: 0 },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 7. __is_truthy(externref) -> i32
  //    null → 0; boxed number → value !== 0 && !NaN; boxed bool → value;
  //    anything else (other refs) → 1 (any non-null ref is truthy in JS).
  registerNative(
    "__is_truthy",
    externrefToI32,
    [
      // if (ref.is_null param) return 0
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // any = any.convert_extern(param)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.tee", index: 1 },
      // boxed number? → value !== 0 && value === value
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "local.tee", index: 2 },
          // value !== 0
          { op: "f64.const", value: 0 },
          { op: "f64.ne" },
          { op: "local.get", index: 2 },
          // value === value (NaN check — NaN !== NaN)
          { op: "local.get", index: 2 },
          { op: "f64.eq" },
          { op: "i32.and" },
          { op: "return" },
        ],
      },
      // boxed bool? → value
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx } as unknown as Instr,
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // any other non-null ref → truthy
      { op: "i32.const", value: 1 },
    ],
    [
      { name: "$any_temp", type: { kind: "anyref" } as ValType },
      { name: "$f64_temp", type: { kind: "f64" } },
    ],
  );

  // 8. __typeof_number(externref) -> i32 — `ref.test $box_number_struct`.
  registerNative("__typeof_number", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as unknown as Instr,
    { op: "ref.test", typeIdx: boxNumStructIdx },
  ]);

  // 9. __typeof_boolean(externref) -> i32 — `ref.test $box_boolean_struct`.
  registerNative("__typeof_boolean", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as unknown as Instr,
    { op: "ref.test", typeIdx: boxBoolStructIdx },
  ]);

  // 10. __typeof_string(externref) -> i32. Under nativeStrings (auto-on
  //     for wasi) strings are NativeString structs at `ctx.anyStrTypeIdx`.
  //     If that type isn't registered, return 0 (no string in scope).
  if (ctx.anyStrTypeIdx >= 0) {
    const strTypeIdx = ctx.anyStrTypeIdx;
    registerNative("__typeof_string", externrefToI32, [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "ref.test", typeIdx: strTypeIdx },
    ]);
  } else {
    registerNative("__typeof_string", externrefToI32, [{ op: "i32.const", value: 0 }]);
  }

  // 11. __typeof_undefined(externref) -> i32 — `ref.is_null`.
  registerNative("__typeof_undefined", externrefToI32, [{ op: "local.get", index: 0 }, { op: "ref.is_null" }]);

  // 12. __typeof_object(externref) -> i32 — non-null AND not number AND
  //     not boolean AND not function. We approximate as "non-null and
  //     not a boxed primitive" — sufficient for the common typeof
  //     dispatch use cases. Returns 0 conservatively for boxed numbers
  //     and boxed booleans.
  registerNative(
    "__typeof_object",
    externrefToI32,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as unknown as Instr,
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // non-null, not a boxed primitive → object
      { op: "i32.const", value: 1 },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 13. __typeof_function(externref) -> i32 — wasi binaries don't expose
  //     callable JS functions to the outside, so this is conservatively 0.
  registerNative("__typeof_function", externrefToI32, [{ op: "i32.const", value: 0 }]);

  // 14. __typeof(externref) -> externref — returns null externref under
  //     wasi. Producing real type-tag strings would require a NativeString
  //     per tag; defer until a wasi caller needs the typeof RESULT as a
  //     string (today's callers compare against literal tags via the
  //     __typeof_* helpers above).
  registerNative("__typeof", externrefToExternref, [{ op: "ref.null.extern" } as unknown as Instr]);
}

/**
 * Scan source for for...of on non-array types (strings, externref iterables)
 * and register the host-delegated iterator protocol imports.
 */
function collectIteratorImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      // Array types use the existing index-based loop — no iterator imports needed
      const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        // In fast mode, strings are iterated natively — no iterator imports needed
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(exprType)) {
          return;
        }
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (found) break;
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (found) break;
        if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    } else if (ts.isForOfStatement(stmt)) {
      visit(stmt);
    }
  }

  if (found) {
    addIteratorImports(ctx);
  }
}

/** Register the iterator protocol host imports if not already registered */
export function addIteratorImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__iterator")) return;

  // __iterator: (externref) → externref — calls obj[Symbol.iterator]()
  const extToExt = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__iterator", { kind: "func", typeIdx: extToExt });

  // __iterator_next: (externref) → externref — calls iter.next()
  addImport(ctx, "env", "__iterator_next", {
    kind: "func",
    typeIdx: extToExt,
  });

  // __iterator_done: (externref) → i32 — returns result.done ? 1 : 0
  const extToI32 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__iterator_done", {
    kind: "func",
    typeIdx: extToI32,
  });

  // __iterator_value: (externref) → externref — returns result.value
  addImport(ctx, "env", "__iterator_value", {
    kind: "func",
    typeIdx: extToExt,
  });

  // __iterator_return: (externref) → void — calls iter.return() if it exists
  const extToVoid = addFuncType(ctx, [{ kind: "externref" }], []);
  addImport(ctx, "env", "__iterator_return", {
    kind: "func",
    typeIdx: extToVoid,
  });
}

/** Register array iterator host imports (entries/keys/values) if not already registered */
export function addArrayIteratorImports(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__array_entries")) return;

  // All three: (externref) → externref — take a vec struct, return a JS iterator
  const extToExt = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__array_entries", { kind: "func", typeIdx: extToExt });
  addImport(ctx, "env", "__array_keys", { kind: "func", typeIdx: extToExt });
  addImport(ctx, "env", "__array_values", { kind: "func", typeIdx: extToExt });
}

/**
 * Register the generator host imports if not already registered.
 *
 * The legacy generator codegen (eager-buffer model) uses these imports to
 * push yielded values into a JS array on the host side, then wrap that
 * buffer with `__create_generator` (or `__create_async_generator`) to
 * produce a Generator-like / AsyncGenerator-like object. The IR path
 * (slice 7 — #1169f) reuses the same set of imports — extracting this
 * registration out of `declarations.ts:1014-1062` into a standalone
 * exported helper so both legacy and IR can call it without duplicating
 * the import-shape declarations.
 *
 * Imports registered (all under `env`):
 *   - `__gen_create_buffer`   () → externref
 *   - `__gen_push_f64`        (externref, f64) → ()
 *   - `__gen_push_i32`        (externref, i32) → ()
 *   - `__gen_push_ref`        (externref, externref) → ()
 *   - `__gen_yield_star`      (externref, externref) → ()  (same shape as push_ref)
 *   - `__create_generator`    (externref, externref) → externref  (buf, pendingThrow)
 *   - `__create_async_generator` (externref, externref) → externref  (same shape)
 *   - `__gen_next`            (externref) → externref
 *   - `__gen_return`          (externref, externref) → externref
 *   - `__gen_throw`           (externref, externref) → externref
 *   - `__gen_result_value`    (externref) → externref
 *   - `__gen_result_value_f64` (externref) → f64
 *   - `__gen_result_done`     (externref) → i32
 *   - `__get_caught_exception` () → externref  (for the body's try/catch wrapper)
 */
export function addGeneratorImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__gen_create_buffer")) return;

  const bufType = addFuncType(ctx, [], [{ kind: "externref" }]);
  addImport(ctx, "env", "__gen_create_buffer", { kind: "func", typeIdx: bufType });

  const pushF64Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], []);
  addImport(ctx, "env", "__gen_push_f64", { kind: "func", typeIdx: pushF64Type });

  const pushI32Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], []);
  addImport(ctx, "env", "__gen_push_i32", { kind: "func", typeIdx: pushI32Type });

  const pushRefType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
  addImport(ctx, "env", "__gen_push_ref", { kind: "func", typeIdx: pushRefType });

  // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
  addImport(ctx, "env", "__gen_yield_star", {
    kind: "func",
    typeIdx: pushRefType, // same signature as push_ref: (buf, iterable) → void
  });

  // __create_generator: (buf: externref, pendingThrow: externref) -> externref
  // Takes a buffer of yielded values and an optional pending exception,
  // returns a Generator-like object that defers the throw to the first next() call.
  const createGenType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__create_generator", { kind: "func", typeIdx: createGenType });
  // __create_async_generator: same Wasm signature as __create_generator, but .next()/.return()/.throw()
  // return Promise-wrapped results as required by the ES spec for async generators.
  addImport(ctx, "env", "__create_async_generator", { kind: "func", typeIdx: createGenType });
  const genType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__gen_next", { kind: "func", typeIdx: genType });

  const genReturnType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__gen_return", { kind: "func", typeIdx: genReturnType });
  addImport(ctx, "env", "__gen_throw", { kind: "func", typeIdx: genReturnType });

  addImport(ctx, "env", "__gen_result_value", { kind: "func", typeIdx: genType });

  const resultValF64Type = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  addImport(ctx, "env", "__gen_result_value_f64", { kind: "func", typeIdx: resultValF64Type });

  const resultDoneType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__gen_result_done", { kind: "func", typeIdx: resultDoneType });

  // Ensure __get_caught_exception is available for generator body try/catch wrappers
  if (!ctx.funcMap.has("__get_caught_exception")) {
    const getCaughtType = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", "__get_caught_exception", { kind: "func", typeIdx: getCaughtType });
  }
}

/** Register for-in key enumeration host imports if not already registered */
export function addForInImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__for_in_keys")) return;

  // __for_in_keys: (externref) -> externref — returns JS array of enumerable string keys
  const extToExt = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__for_in_keys", { kind: "func", typeIdx: extToExt });

  // __for_in_len: (externref) -> i32 — returns keys.length
  const extToI32 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__for_in_len", { kind: "func", typeIdx: extToI32 });

  // __for_in_get: (externref, i32) -> externref — returns keys[i]
  const extI32ToExt = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__for_in_get", { kind: "func", typeIdx: extI32ToExt });
}

/**
 * Check if a ts.Type is a TypeScript tuple type (e.g. [number, string]).
 * Tuples are TypeReference types whose target has the Tuple object flag.
 * The Tuple flag is on the target, not the reference itself.
 */
export function isTupleType(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const objType = type as ts.ObjectType;
  // Direct Tuple flag check (on the target for TypeReference types)
  if ((objType.objectFlags & ts.ObjectFlags.Tuple) !== 0) return true;
  // TypeReference → check target's objectFlags
  if ((objType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const ref = type as ts.TypeReference;
    if (ref.target && (ref.target.objectFlags & ts.ObjectFlags.Tuple) !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Get the element types of a tuple type.
 * Returns the resolved ValType for each element position.
 */
export function getTupleElementTypes(ctx: CodegenContext, tsType: ts.Type): ValType[] {
  const typeRef = tsType as ts.TypeReference;
  const typeArgs = ctx.checker.getTypeArguments(typeRef);
  return typeArgs.map((t) => {
    // In tuple element position, `undefined` must not map to i32: i32 can't
    // distinguish "missing" from 0, which breaks destructuring default checks
    // on hole/undefined elements (e.g. `[x=23] = [,]` — the param default is a
    // hole-array tuple; the sNaN sentinel gets truncated to i32 0 and the inner
    // default `x=23` never fires). Promote to f64 so the sNaN sentinel survives.
    if ((t.flags & ts.TypeFlags.Undefined) !== 0) {
      return { kind: "f64" };
    }
    return resolveWasmType(ctx, t);
  });
}

/**
 * Build a unique key for a tuple type signature based on its element types.
 * Used as the key for tupleTypeMap to de-duplicate identical tuple shapes.
 */
function tupleTypeKey(elemTypes: ValType[]): string {
  return elemTypes
    .map((t) => {
      if (t.kind === "ref" || t.kind === "ref_null") return `${t.kind}_${t.typeIdx}`;
      return t.kind;
    })
    .join(",");
}

/**
 * Get or register a Wasm GC struct type for a tuple type.
 * Each unique tuple signature (e.g. [f64, externref]) maps to one struct type
 * with fields named _0, _1, etc.
 */
export function getOrRegisterTupleType(ctx: CodegenContext, elemTypes: ValType[]): number {
  const key = tupleTypeKey(elemTypes);
  const existing = ctx.tupleTypeMap.get(key);
  if (existing !== undefined) return existing;

  const fields: FieldDef[] = elemTypes.map((t, i) => ({
    name: `_${i}`,
    type: t,
    mutable: false,
  }));

  const typeIdx = ctx.mod.types.length;
  const structName = `__tuple_${ctx.tupleTypeMap.size}`;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.tupleTypeMap.set(key, typeIdx);
  ctx.structMap.set(structName, typeIdx);

  // Register in structFields so emitStructFieldGetters can export __sget_0, __sget_1 etc.
  // This enables the runtime to introspect tuple elements (needed for Map/Set iterables).
  ctx.structFields.set(
    structName,
    fields.map((f) => ({
      name: f.name,
      type: f.type,
      mutable: f.mutable ?? false,
    })),
  );

  return typeIdx;
}

/**
 * Native type annotation map: type alias names that map to Wasm types.
 * When a user writes `type i32 = number; let x: i32 = 42;`, the compiler
 * will use Wasm i32 instead of f64 for the local variable.
 */
const NATIVE_TYPE_MAP: Record<string, ValType> = {
  i32: { kind: "i32" },
  u8: { kind: "i32" }, // unsigned 8-bit — stored as i32 (masked at boundaries)
  u16: { kind: "i32" }, // unsigned 16-bit — stored as i32 (masked at boundaries)
  u32: { kind: "i32" }, // unsigned 32-bit — stored as i32
  i8: { kind: "i32" }, // signed 8-bit — stored as i32
  i16: { kind: "i32" }, // signed 16-bit — stored as i32
  f32: { kind: "f32" },
  f64: { kind: "f64" },
  // i64 intentionally omitted — requires BigInt integration, not yet supported
};

/**
 * Detect native type annotations (e.g., `type i32 = number`) from a TS type's
 * alias symbol. Returns the corresponding Wasm ValType, or null if not a native
 * type annotation.
 *
 * TypeScript preserves the alias symbol on types at the usage site, so
 * `let x: i32` where `type i32 = number` will have aliasSymbol.name === "i32"
 * even though the resolved type is `number`.
 */
export function resolveNativeTypeAnnotation(tsType: ts.Type): ValType | null {
  const aliasName = tsType.aliasSymbol?.name;
  if (aliasName && aliasName in NATIVE_TYPE_MAP) {
    // Verify the alias resolves to number (not some unrelated type named "i32")
    // by checking that the underlying type is a number type.
    // aliasSymbol is set → the resolved type should be NumberLike.
    const flags = tsType.flags;
    if (flags & ts.TypeFlags.Number || flags & ts.TypeFlags.NumberLiteral) {
      return NATIVE_TYPE_MAP[aliasName]!;
    }
  }
  return null;
}

/**
 * Resolve a ts.Type to a ValType, using the struct registry and anonymous type map.
 * Use this instead of mapTsTypeToWasm in the codegen to get real type indices.
 */
export function resolveWasmType(ctx: CodegenContext, tsType: ts.Type, _depth = 0, _visited?: Set<ts.Type>): ValType {
  // Guard against infinite recursion (can happen with skipSemanticDiagnostics
  // when getTypeArguments returns the container type itself)
  if (_depth > 10) return { kind: "externref" };
  if (_visited && _visited.has(tsType)) return { kind: "externref" };
  if (!_visited) _visited = new Set<ts.Type>();
  _visited.add(tsType);
  // Native type annotations: type i32 = number; let x: i32 → Wasm i32
  // Check aliasSymbol first — TypeScript preserves the alias name on the type.
  const nativeType = resolveNativeTypeAnnotation(tsType);
  if (nativeType) return nativeType;

  // Fast mode: string → ref $AnyString (not externref)
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(tsType)) {
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }

  // Check tuple types BEFORE Array — tuples have the Object flag and Array symbol
  // but should be compiled to structs, not arrays
  if (isTupleType(tsType)) {
    const elemTypes = getTupleElementTypes(ctx, tsType);
    const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);
    return { kind: "ref", typeIdx: tupleIdx };
  }

  // Check Array<T> / T[] BEFORE isExternalDeclaredClass, because Array is declared
  // in the lib as `declare var Array: ArrayConstructor` which would match externref
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    if (sym?.name === "Array") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      const elemTsType = typeArgs[0];
      const elemWasm: ValType = elemTsType
        ? resolveWasmType(ctx, elemTsType, _depth + 1, _visited)
        : { kind: "externref" };
      const elemKey =
        elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
          ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
          : elemWasm.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      // Use ref_null so locals can default-initialize to null
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Wrapper types (Number, String, Boolean) — map to externref.
    // new Number(x), new String(x), new Boolean(x) are wrapper objects (typeof "object").
    if (sym?.name === "Number" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }
    if (sym?.name === "String" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }
    if (sym?.name === "Boolean" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }

    // Promise<T> → unwrap to T.
    // Async functions are compiled synchronously, so Promise<T> is just T at the Wasm level.
    if (sym?.name === "Promise") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      if (typeArgs.length > 0) {
        const inner = typeArgs[0]!;
        if (isVoidType(inner)) return { kind: "externref" }; // Promise<void> → externref (no value)
        return resolveWasmType(ctx, inner, _depth + 1, _visited);
      }
      return { kind: "externref" }; // bare Promise without type arg
    }

    // TypedArray types → vec struct with f64 elements (same representation as number[])
    // Covers: Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    //         Int32Array, Uint32Array, Float32Array, Float64Array
    const TYPED_ARRAY_NAMES = new Set([
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (sym?.name && TYPED_ARRAY_NAMES.has(sym.name)) {
      const elemWasm: ValType = { kind: "f64" };
      const vecIdx = getOrRegisterVecType(ctx, "f64", elemWasm);
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Date → WasmGC struct with i64 timestamp field
    if (sym?.name === "Date") {
      const dateTypeIdx = ensureDateStructForCtx(ctx);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // Check externref AFTER Array check — Array is declared in lib but should use wasm GC arrays
    if (isExternalDeclaredClass(tsType, ctx.checker)) return { kind: "externref" };

    let name = sym?.name;
    // Map class expression symbol names to their synthetic names
    if (name && !ctx.structMap.has(name)) {
      name = ctx.classExprNameMap.get(name) ?? name;
    }
    // Check named structs (interfaces, type aliases)
    if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(name)! };
    }
    // Check anonymous type registry
    const anonName = ctx.anonTypeMap.get(tsType);
    if (anonName && ctx.structMap.has(anonName)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(anonName)! };
    }

    // Auto-register anonymous object types that look like plain data objects
    // (name is __type or __object, has properties, not a class/function/external type)
    if (!anonName && (name === "__type" || name === "__object") && tsType.getProperties().length > 0) {
      ensureStructForType(ctx, tsType);
      const registeredName = ctx.anonTypeMap.get(tsType);
      if (registeredName && ctx.structMap.has(registeredName)) {
        return { kind: "ref", typeIdx: ctx.structMap.get(registeredName)! };
      }
    }
  }

  // Handle unions (T | undefined) — resolve inner type
  if (tsType.isUnion()) {
    const nonNullish = tsType.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined),
    );
    if (nonNullish.length === 1 && tsType.types.length === 2) {
      const inner = resolveWasmType(ctx, nonNullish[0]!, _depth + 1, _visited);
      if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
      return inner;
    }
  }

  // any/unknown → ref_null $AnyValue (boxed any) when available.
  // Only in fast mode where there are no host-imported extern classes to conflict with.
  // In non-fast mode, any/unknown falls through to mapTsTypeToWasm → externref.
  if (ctx.fast && tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    ensureAnyValueType(ctx);
    return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  }

  return mapTsTypeToWasm(tsType, ctx.checker, ctx.fast);
}

/**
 * Compute a hash key for a list of struct fields (for O(1) structural dedup).
 * The key encodes field names, type kinds, and typeIdx for ref/ref_null types.
 */
function fieldsHashKey(fields: FieldDef[]): string {
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

/** Ensure the $__Date struct type exists in the module, return its type index. */
function ensureDateStructForCtx(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct" as const,
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" as const }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__Date");
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" as const }, mutable: true }]);
  return typeIdx;
}

/**
 * Ensure a ts.Type that's an object type is registered as a struct.
 * For named types already in structMap, this is a no-op.
 * For anonymous types, auto-registers them with a generated name.
 */
export function ensureStructForType(ctx: CodegenContext, tsType: ts.Type): void {
  if (!(tsType.flags & ts.TypeFlags.Object)) return;
  if (isExternalDeclaredClass(tsType, ctx.checker)) return;
  // Tuple types are handled by getOrRegisterTupleType, not as anonymous structs
  if (isTupleType(tsType)) return;
  // Callable types (functions) are compiled as closures, not structs
  if (tsType.getCallSignatures().length > 0) return;
  // Guard against infinite recursion on circular/self-referencing types.
  // Uses per-compilation ctx.ensureStructPending (not module-scoped) to avoid
  // leaking state between compile() calls in the same process (#923).
  if (ctx.ensureStructPending.has(tsType)) return;
  ctx.ensureStructPending.add(tsType);

  const name = tsType.symbol?.name;

  // Already registered as named struct
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) return;

  // Already registered as anonymous struct
  if (ctx.anonTypeMap.has(tsType)) return;

  // Get properties from the type (empty objects get an empty struct)
  const props = tsType.getProperties();

  const fields: FieldDef[] = [];
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    // Recursively register nested object types as structs before resolving
    ensureStructForType(ctx, propType);
    // Use resolveWasmType so nested structs get ref types, not externref
    let wasmType = resolveWasmType(ctx, propType);
    // For valueOf/toString callable properties, store as eqref instead of externref
    // so coercion can recover the closure and call it via call_ref
    if (
      wasmType.kind === "externref" &&
      propType.getCallSignatures().length > 0 &&
      (prop.name === "valueOf" || prop.name === "toString")
    ) {
      wasmType = { kind: "eqref" };
    }
    fields.push({ name: prop.name, type: wasmType, mutable: true });
  }

  // Structural dedup: O(1) hash-based lookup for matching anonymous struct fields.
  // This avoids creating duplicate struct types for the same shape when TS returns
  // different ts.Type objects (e.g. variable type vs. initializer type).
  const hashKey = fieldsHashKey(fields);
  const existingName = ctx.anonStructHash.get(hashKey);
  if (existingName) {
    ctx.anonTypeMap.set(tsType, existingName);
    return;
  }

  // Widen non-null ref fields to ref_null so struct.new can use ref.null defaults
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = { kind: "ref_null", typeIdx: field.type.typeIdx };
    }
  }

  const structName = `__anon_${ctx.anonTypeCounter++}`;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(structName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, structName);
  ctx.structFields.set(structName, fields);
  ctx.anonStructHash.set(hashKey, structName);
  ctx.anonTypeMap.set(tsType, structName);

  // Pre-register placeholder functions for callable properties (methods).
  // This ensures that struct method calls (e.g. obj.foo()) can resolve
  // the function index during the first pass, before the object literal's
  // method bodies are compiled in compileObjectLiteralForStruct.
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const callSigs = propType.getCallSignatures();
    if (callSigs.length === 0) continue;

    // Only pre-register methods that have a user-defined declaration
    // (MethodDeclaration or PropertyAssignment with function initializer in user code).
    // Skip inherited/prototype methods (toString, valueOf from Object.prototype)
    // and lib type method signatures, as they won't have a body to compile
    // in compileObjectLiteralForStruct.
    const decl = prop.valueDeclaration;
    if (!decl) continue;
    // Only pre-register MethodDeclaration — PropertyAssignment with function
    // initializers are compiled as closures (eqref fields), not direct calls,
    // so a placeholder function would never be filled and remain with an empty
    // body causing "stack for fallthru" validation errors.
    if (!ts.isMethodDeclaration(decl)) continue;
    // Also skip declarations from .d.ts files (lib types)
    const declSourceFile = decl.getSourceFile();
    if (declSourceFile && declSourceFile.isDeclarationFile) continue;

    const fullName = `${structName}_${prop.name}`;
    if (ctx.funcMap.has(fullName)) continue; // already registered

    const sig = callSigs[0]!;
    // Build parameter types: self (ref $structTypeIdx) + declared params
    const methodParams: ValType[] = [{ kind: "ref", typeIdx }];
    for (const param of sig.parameters) {
      const paramDecl = param.valueDeclaration;
      if (paramDecl) {
        const pt = ctx.checker.getTypeAtLocation(paramDecl);
        methodParams.push(resolveWasmType(ctx, pt));
      } else {
        methodParams.push({ kind: "f64" });
      }
    }
    // Check if this is a generator method (*method() { ... })
    const isGenMethod = ts.isMethodDeclaration(decl) && decl.asteriskToken !== undefined;
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const methodResults: ValType[] = isGenMethod
      ? [{ kind: "externref" }]
      : retType && !isVoidType(retType)
        ? [resolveWasmType(ctx, retType)]
        : [];

    const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
    const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(fullName, methodFuncIdx);

    const methodFunc: WasmFunction = {
      name: fullName,
      typeIdx: methodTypeIdx,
      locals: [],
      body: [],
      exported: false,
    };
    ctx.mod.functions.push(methodFunc);
  }
}

// ── Built-in extern class registration ───────────────────────────────

/** Helper to create an extern method signature with externref params and results */
function externMethod(
  paramCount: number,
  returnsExternref = true,
): { params: ValType[]; results: ValType[]; requiredParams: number } {
  const params: ValType[] = [];
  for (let i = 0; i <= paramCount; i++) params.push({ kind: "externref" }); // self + args
  return {
    params,
    results: returnsExternref ? [{ kind: "externref" }] : [],
    requiredParams: params.length,
  };
}

/**
 * Register built-in collection types (Set, Map, WeakMap, WeakSet) as extern classes
 * if they weren't already collected from lib .d.ts files. This ensures these types
 * are available for extern class method dispatch even when lib file scanning fails
 * (e.g., bundled/browser environments where readLibFile returns empty strings).
 */
function registerBuiltinExternClasses(ctx: CodegenContext): void {
  // Set methods — all take (self: externref, ...args: externref) → externref
  if (!ctx.externClasses.has("Set")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // ES2015 methods
    methods.set("add", externMethod(1)); // add(value) → Set
    methods.set("has", externMethod(1)); // has(value) → boolean (externref)
    methods.set("delete", externMethod(1)); // delete(value) → boolean (externref)
    methods.set("clear", externMethod(0, false)); // clear() → void
    methods.set("forEach", externMethod(1)); // forEach(callback) → void (externref for simplicity)
    methods.set("entries", externMethod(0)); // entries() → Iterator
    methods.set("keys", externMethod(0)); // keys() → Iterator
    methods.set("values", externMethod(0)); // values() → Iterator
    // ES2025 Set methods
    methods.set("union", externMethod(1)); // union(other) → Set
    methods.set("intersection", externMethod(1)); // intersection(other) → Set
    methods.set("difference", externMethod(1)); // difference(other) → Set
    methods.set("symmetricDifference", externMethod(1)); // symmetricDifference(other) → Set
    methods.set("isSubsetOf", externMethod(1)); // isSubsetOf(other) → boolean (externref)
    methods.set("isSupersetOf", externMethod(1)); // isSupersetOf(other) → boolean (externref)
    methods.set("isDisjointFrom", externMethod(1)); // isDisjointFrom(other) → boolean (externref)

    ctx.externClasses.set("Set", {
      importPrefix: "Set",
      namespacePath: [],
      className: "Set",
      constructorParams: [{ kind: "externref" }], // new Set(iterable?)
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // Map methods
  if (!ctx.externClasses.has("Map")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("get", externMethod(1));
    methods.set("set", externMethod(2));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));
    methods.set("clear", externMethod(0, false));
    methods.set("forEach", externMethod(1));
    methods.set("entries", externMethod(0));
    methods.set("keys", externMethod(0));
    methods.set("values", externMethod(0));

    ctx.externClasses.set("Map", {
      importPrefix: "Map",
      namespacePath: [],
      className: "Map",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // WeakMap methods
  if (!ctx.externClasses.has("WeakMap")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("get", externMethod(1));
    methods.set("set", externMethod(2));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));

    ctx.externClasses.set("WeakMap", {
      importPrefix: "WeakMap",
      namespacePath: [],
      className: "WeakMap",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map(),
    });
  }

  // WeakSet methods
  if (!ctx.externClasses.has("WeakSet")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("add", externMethod(1));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));

    ctx.externClasses.set("WeakSet", {
      importPrefix: "WeakSet",
      namespacePath: [],
      className: "WeakSet",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map(),
    });
  }

  // DisposableStack / AsyncDisposableStack — TC39 Explicit Resource Management (#830)
  if (!ctx.externClasses.has("DisposableStack")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("dispose", externMethod(0, false)); // dispose() → void
    methods.set("use", externMethod(1)); // use(value) → value
    methods.set("adopt", externMethod(2)); // adopt(value, onDispose) → value
    methods.set("defer", externMethod(1, false)); // defer(onDispose) → void
    methods.set("move", externMethod(0)); // move() → DisposableStack

    ctx.externClasses.set("DisposableStack", {
      importPrefix: "DisposableStack",
      namespacePath: [],
      className: "DisposableStack",
      constructorParams: [], // new DisposableStack()
      methods,
      properties: new Map([["disposed", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  if (!ctx.externClasses.has("AsyncDisposableStack")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("disposeAsync", externMethod(0)); // disposeAsync() → Promise
    methods.set("use", externMethod(1));
    methods.set("adopt", externMethod(2));
    methods.set("defer", externMethod(1, false));
    methods.set("move", externMethod(0));

    ctx.externClasses.set("AsyncDisposableStack", {
      importPrefix: "AsyncDisposableStack",
      namespacePath: [],
      className: "AsyncDisposableStack",
      constructorParams: [],
      methods,
      properties: new Map([["disposed", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  if (!ctx.externClasses.has("SuppressedError")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    ctx.externClasses.set("SuppressedError", {
      importPrefix: "SuppressedError",
      namespacePath: [],
      className: "SuppressedError",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      methods,
      properties: new Map([
        ["error", { type: { kind: "externref" }, readonly: false }],
        ["suppressed", { type: { kind: "externref" }, readonly: false }],
        ["message", { type: { kind: "externref" }, readonly: false }],
      ]),
    });
  }

  // Register Object as base extern class with prototype methods (#799 WI2).
  // All extern classes that lack a parent inherit from Object, so
  // findExternInfoForMember will resolve hasOwnProperty, toString, etc.
  if (!ctx.externClasses.has("Object")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("hasOwnProperty", externMethod(1));
    methods.set("isPrototypeOf", externMethod(1));
    methods.set("propertyIsEnumerable", externMethod(1));
    methods.set("toString", externMethod(0));
    methods.set("valueOf", externMethod(0));
    methods.set("toLocaleString", externMethod(0));
    ctx.externClasses.set("Object", {
      importPrefix: "Object",
      namespacePath: [],
      className: "Object",
      constructorParams: [],
      methods,
      properties: new Map([["constructor", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // Intl.ListFormat — extern class for internationalized list formatting
  if (!ctx.externClasses.has("ListFormat")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("format", externMethod(1)); // format(list) → string (externref)
    methods.set("formatToParts", externMethod(1)); // formatToParts(list) → array (externref)
    methods.set("resolvedOptions", externMethod(0)); // resolvedOptions() → object (externref)
    ctx.externClasses.set("ListFormat", {
      importPrefix: "Intl_ListFormat",
      namespacePath: ["Intl"],
      className: "ListFormat",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locale?, options?
      methods,
      properties: new Map(),
    });
  }

  // Intl.NumberFormat — extern class for internationalized number formatting
  if (!ctx.externClasses.has("NumberFormat")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("format", externMethod(1)); // format(n) → string (externref)
    methods.set("formatToParts", externMethod(1)); // formatToParts(n) → array (externref)
    methods.set("resolvedOptions", externMethod(0)); // resolvedOptions() → object (externref)
    ctx.externClasses.set("NumberFormat", {
      importPrefix: "Intl_NumberFormat",
      namespacePath: ["Intl"],
      className: "NumberFormat",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locale?, options?
      methods,
      properties: new Map(),
    });
  }

  // Set Object as terminal parent for any extern class that has no parent
  for (const [className] of ctx.externClasses) {
    if (className !== "Object" && !ctx.externClassParent.has(className)) {
      ctx.externClassParent.set(className, "Object");
    }
  }
}

// ── Extern class collection ──────────────────────────────────────────

function collectExternDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    if (ts.isModuleDeclaration(stmt) && hasDeclareModifier(stmt)) {
      collectDeclareNamespace(ctx, stmt, []);
    }
    // Top-level declare class (e.g. user-defined or import-resolver stubs)
    if (ts.isClassDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt)) {
      collectExternClass(ctx, stmt, []);
    }
    // Top-level declare function stubs — registered as Wasm imports so that calls
    // can pass arguments correctly (missing args get padded with default values).
    // These are generated by preprocessImports for named imports from unresolved
    // external modules, e.g. `import { foo } from "./x.js"` → `declare function foo(a0, a1): any`.
    // In WASI mode, skip node:fs functions — they're handled by WASI syscall helpers.
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt) && !stmt.body) {
      const name = stmt.name.text;
      if (ctx.wasi && ctx.wasiNodeFsFuncs.has(name)) continue;
      if (!ctx.funcMap.has(name)) {
        const sig = ctx.checker.getSignatureFromDeclaration(stmt);
        if (sig) {
          const params: ValType[] = stmt.parameters.map((p) =>
            mapTsTypeToWasm(ctx.checker.getTypeAtLocation(p), ctx.checker),
          );
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          const results: ValType[] = isVoidType(retType) ? [] : [mapTsTypeToWasm(retType, ctx.checker)];
          const typeIdx = addFuncType(ctx, params, results);
          addImport(ctx, "env", name, { kind: "func", typeIdx });
        }
      }
    }
    // declare var X: { prototype: X; new(): X } (lib.dom.d.ts pattern)
    // declare var Date: DateConstructor (interface with new() pattern)
    if (ts.isVariableStatement(stmt) && hasDeclareModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !decl.type) continue;
        // Inline type literal with construct signature
        if (ts.isTypeLiteralNode(decl.type) && decl.type.members.some((m) => ts.isConstructSignatureDeclaration(m))) {
          collectExternFromDeclareVar(ctx, decl);
        }
        // Type reference to interface with construct signature (e.g. declare var Date: DateConstructor)
        // Skip types with built-in wasm handling (Array, primitives, etc.)
        else if (ts.isTypeReferenceNode(decl.type)) {
          const varName = decl.name.text;
          const BUILTIN_SKIP = new Set([
            "Array",
            "Number",
            "Boolean",
            "String",
            "Object",
            "Function",
            "Symbol",
            "BigInt",
            "Int8Array",
            "Uint8Array",
            "Int16Array",
            "Uint16Array",
            "Int32Array",
            "Uint32Array",
            "Float32Array",
            "Float64Array",
            "ArrayBuffer",
            "DataView",
            "JSON",
            "Math",
            "Error",
            "TypeError",
            "RangeError",
            "SyntaxError",
            "URIError",
            "EvalError",
            "ReferenceError",
            // Promise instance methods (.then/.catch/.finally) are handled by
            // dedicated Promise-specific codegen that registers 2-param late imports.
            // Registering Promise via collectExternFromDeclareVar causes the TypeScript
            // interface declaration (then(onfulfilled?, onrejected?)) to be collected
            // as a 3-param Wasm function, creating an arity mismatch with the 2-param
            // late imports used by the Promise-specific handler. (#966)
            "Promise",
          ]);
          if (!BUILTIN_SKIP.has(varName)) {
            const refType = ctx.checker.getTypeAtLocation(decl.type);
            const constructSigs = refType.getConstructSignatures();
            if (constructSigs.length > 0) {
              collectExternFromDeclareVar(ctx, decl);
            }
          }
        }
      }
    }
  }
}

function collectDeclareNamespace(ctx: CodegenContext, decl: ts.ModuleDeclaration, parentPath: string[]): void {
  const nsName = decl.name.text;
  const path = [...parentPath, nsName];

  if (decl.body && ts.isModuleBlock(decl.body)) {
    for (const stmt of decl.body.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        collectExternClass(ctx, stmt, path);
      }
      if (ts.isModuleDeclaration(stmt)) {
        collectDeclareNamespace(ctx, stmt, path);
      }
    }
  }
}

function collectExternClass(ctx: CodegenContext, decl: ts.ClassDeclaration, namespacePath: string[]): void {
  const className = decl.name!.text;
  if (ERROR_TYPES_SKIP.has(className)) return;
  const prefix = [...namespacePath, className].join("_");

  const info: ExternClassInfo = {
    importPrefix: prefix,
    namespacePath,
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  for (const member of decl.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
      }
    }
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = (member.name as ts.Identifier).text;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }]; // 'this'
        let requiredParams = 1;
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType) ? [] : [mapTsTypeToWasm(retType, ctx.checker)];
        info.methods.set(methodName, { params, results, requiredParams });
      }
    }
    if (ts.isPropertyDeclaration(member) && member.name) {
      const propName = (member.name as ts.Identifier).text;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      const isReadonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
  }

  // Record parent class for inheritance chain walk
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types[0]) {
        const baseType = ctx.checker.getTypeAtLocation(clause.types[0]);
        const baseName = baseType.getSymbol()?.name;
        if (baseName) ctx.externClassParent.set(className, baseName);
      }
    }
  }

  ctx.externClasses.set(className, info);
  // Also register with full qualified name
  const fullName = [...namespacePath, className].join(".");
  ctx.externClasses.set(fullName, info);
}

/** Types handled natively — skip extern class registration */
const ERROR_TYPES_SKIP = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "Date",
]);

/** Collect extern class info from a `declare var X: { prototype: X; new(): X }` (lib.dom.d.ts pattern) */
function collectExternFromDeclareVar(ctx: CodegenContext, decl: ts.VariableDeclaration): void {
  const className = (decl.name as ts.Identifier).text;
  if (ERROR_TYPES_SKIP.has(className)) return;
  if (ctx.externClasses.has(className)) return;

  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return;

  const info: ExternClassInfo = {
    importPrefix: className,
    namespacePath: [],
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  // Extract constructor params from the construct signature
  if (decl.type) {
    if (ts.isTypeLiteralNode(decl.type)) {
      for (const member of decl.type.members) {
        if (ts.isConstructSignatureDeclaration(member)) {
          for (const param of member.parameters) {
            const paramType = ctx.checker.getTypeAtLocation(param);
            info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
          }
          break;
        }
      }
    } else if (ts.isTypeReferenceNode(decl.type)) {
      // Resolve interface reference (e.g. DateConstructor, RegExpConstructor)
      const refType = ctx.checker.getTypeAtLocation(decl.type);
      const constructSigs = refType.getConstructSignatures();
      // Use the constructor with the most parameters so all overloads can be
      // served.  Missing args at call sites are padded with defaults.
      const sig =
        constructSigs.length > 0
          ? constructSigs.reduce((a, b) => (b.parameters.length > a.parameters.length ? b : a))
          : undefined;
      if (sig) {
        for (const param of sig.parameters) {
          const paramType = ctx.checker.getTypeOfSymbol(param);
          info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
        }
      }
    }
  }

  // Collect members from own interface declarations + non-extern mixin interfaces
  const allDecls = symbol.getDeclarations() ?? [];
  const visited = new Set<string>();
  for (const d of allDecls) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    // Collect own members
    collectInterfaceMembers(ctx, d, info, decl);
    // Walk extends: first extern parent → inheritance chain, non-extern → collect their members
    if (d.heritageClauses) {
      let parentSet = false;
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          const baseName = baseType.getSymbol()?.name;
          if (!baseName) continue;
          if (!parentSet && !ctx.externClassParent.has(className)) {
            // First extends type → record as parent for inheritance chain
            ctx.externClassParent.set(className, baseName);
            parentSet = true;
          }
          // If this base is NOT an extern class, it's a mixin — collect its members
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, decl, visited);
          }
        }
      }
    }
  }

  ctx.externClasses.set(className, info);
}

/** Collect methods and properties from an interface declaration */
function collectInterfaceMembers(
  ctx: CodegenContext,
  iface: ts.InterfaceDeclaration,
  info: ExternClassInfo,
  locationNode: ts.Node,
): void {
  for (const member of iface.members) {
    // Method signatures
    if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      if (info.methods.has(methodName)) continue;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }];
        let requiredParams = 1;
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const results: ValType[] = isVoidType(retType) ? [] : [mapTsTypeToWasm(retType, ctx.checker)];
        info.methods.set(methodName, { params, results, requiredParams });
      }
    }
    // Property signatures
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      const isReadonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
    // Getter accessors (e.g. `get style(): CSSStyleDeclaration`)
    if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      // Check if there's a matching setter
      const hasSetter = iface.members.some(
        (m) => ts.isSetAccessorDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === propName,
      );
      info.properties.set(propName, { type: wasmType, readonly: !hasSetter });
    }
  }
}

/** Recursively collect members from non-extern mixin interfaces */
function collectMixinMembers(
  ctx: CodegenContext,
  mixinType: ts.Type,
  info: ExternClassInfo,
  locationNode: ts.Node,
  visited: Set<string>,
): void {
  const mixinSymbol = mixinType.getSymbol();
  if (!mixinSymbol) return;
  const mixinName = mixinSymbol.name;
  if (visited.has(mixinName)) return;
  visited.add(mixinName);

  for (const d of mixinSymbol.getDeclarations() ?? []) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    collectInterfaceMembers(ctx, d, info, locationNode);
    // Also walk this mixin's extends (for deeply nested mixins)
    if (d.heritageClauses) {
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, locationNode, visited);
          }
        }
      }
    }
  }
}

function registerExternClassImports(ctx: CodegenContext, info: ExternClassInfo): void {
  // Constructor
  const ctorTypeIdx = addFuncType(ctx, info.constructorParams, [{ kind: "externref" }]);
  addImport(ctx, "env", `${info.importPrefix}_new`, {
    kind: "func",
    typeIdx: ctorTypeIdx,
  });

  // Methods
  for (const [methodName, sig] of info.methods) {
    const methodTypeIdx = addFuncType(ctx, sig.params, sig.results);
    addImport(ctx, "env", `${info.importPrefix}_${methodName}`, {
      kind: "func",
      typeIdx: methodTypeIdx,
    });
  }

  // Property getters and setters
  for (const [propName, propInfo] of info.properties) {
    const getterTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [propInfo.type]);
    addImport(ctx, "env", `${info.importPrefix}_get_${propName}`, {
      kind: "func",
      typeIdx: getterTypeIdx,
    });

    if (!propInfo.readonly) {
      const setterTypeIdx = addFuncType(ctx, [{ kind: "externref" }, propInfo.type], []);
      addImport(ctx, "env", `${info.importPrefix}_set_${propName}`, {
        kind: "func",
        typeIdx: setterTypeIdx,
      });
    }
  }
}

/** Scan user code and register only the extern class imports actually used */
function collectUsedExternImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const registered = new Set<string>();

  function resolveExtern(className: string, memberName: string, kind: "method" | "property"): ExternClassInfo | null {
    let current: string | undefined = className;
    while (current) {
      const info = ctx.externClasses.get(current);
      if (info) {
        if (kind === "method" && info.methods.has(memberName)) return info;
        if (kind === "property" && info.properties.has(memberName)) return info;
      }
      current = ctx.externClassParent.get(current);
    }
    return null;
  }

  function register(importName: string, params: ValType[], results: ValType[]) {
    if (registered.has(importName)) return;
    registered.add(importName);
    const t = addFuncType(ctx, params, results);
    addImport(ctx, "env", importName, { kind: "func", typeIdx: t });
  }

  function visit(node: ts.Node) {
    // new ClassName()
    if (ts.isNewExpression(node)) {
      const type = ctx.checker.getTypeAtLocation(node);
      const className = type.getSymbol()?.name;
      if (className) {
        const info = ctx.externClasses.get(className);
        if (info) register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // RegExp literal (/pattern/flags) → needs RegExp_new import
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // RegExp(pattern, flags) call without `new` — compileCallExpression
    // emits the RegExp_new host call directly. Register it here so the
    // import exists by the time codegen runs. (#1055)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // obj.prop or obj.method(...)
    if (ts.isPropertyAccessExpression(node)) {
      // Skip if this is the target of an assignment (setter handled below)
      const isAssignTarget =
        node.parent &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.left === node;

      if (!isAssignTarget) {
        const objType = ctx.checker.getTypeAtLocation(node.expression);
        const className = objType.getSymbol()?.name;
        const memberName = node.name.text;
        if (className) {
          const isCall = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (isCall) {
            const info = resolveExtern(className, memberName, "method");
            if (info) {
              const sig = info.methods.get(memberName)!;
              register(`${info.importPrefix}_${memberName}`, sig.params, sig.results);
            }
          } else {
            const info = resolveExtern(className, memberName, "property");
            if (info) {
              const propInfo = info.properties.get(memberName)!;
              register(`${info.importPrefix}_get_${memberName}`, [{ kind: "externref" }], [propInfo.type]);
            }
          }
        }
      }
    }

    // obj.prop = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const objType = ctx.checker.getTypeAtLocation(node.left.expression);
      const className = objType.getSymbol()?.name;
      const propName = node.left.name.text;
      if (className) {
        const info = resolveExtern(className, propName, "property");
        if (info) {
          const propInfo = info.properties.get(propName)!;
          register(`${info.importPrefix}_set_${propName}`, [{ kind: "externref" }, propInfo.type], []);
        }
      }
    }

    // obj[idx] on externref (e.g. HTMLCollection) → __extern_get
    if (ts.isElementAccessExpression(node)) {
      // Skip when element access is the callee of a call expression (e.g. obj['method']())
      // — the call handler compiles this as a direct method call, not a property read
      const isCallCallee = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
      const objType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = objType.getSymbol();
      // Skip Array and tuple types — those use Wasm GC struct/array ops, not host import
      // Skip widened empty objects — those use struct.get, not host import
      const isWidenedVar = ts.isIdentifier(node.expression) && ctx.widenedVarStructMap.has(node.expression.text);
      if (
        !isCallCallee &&
        sym?.name !== "Array" &&
        sym?.name !== "__type" &&
        sym?.name !== "__object" &&
        !isTupleType(objType) &&
        !isWidenedVar
      ) {
        const wasmType = mapTsTypeToWasm(objType, ctx.checker);
        if (wasmType.kind === "externref") {
          register("__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    ts.forEachChild(stmt, visit);
  }
}

// ── Declared globals (e.g. declare const document: Document) ────────

function collectDeclaredGlobals(ctx: CodegenContext, libFile: ts.SourceFile, userFile: ts.SourceFile): void {
  // First collect identifiers referenced in user source
  const referencedNames = new Set<string>();
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) referencedNames.add(node.text);
    ts.forEachChild(node, collectRefs);
  };
  for (const stmt of userFile.statements) {
    ts.forEachChild(stmt, collectRefs);
  }

  for (const stmt of libFile.statements) {
    if (!ts.isVariableStatement(stmt) || !hasDeclareModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!referencedNames.has(name)) continue; // only register used globals
      if (ctx.declaredGlobals.has(name)) continue;
      const type = ctx.checker.getTypeAtLocation(decl);
      if (!isExternalDeclaredClass(type, ctx.checker)) continue;
      const importName = `global_${name}`;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
      }
    }
  }

  // #1065 — Register ambient builtin constructors (Array, Object, Function, ...)
  // as declared globals when referenced in source. These are filtered out of
  // isExternalDeclaredClass because they have Wasm-native fast paths (vec
  // structs, tuples, etc.), but they ALSO need to resolve to the real host
  // constructor when used in identity-compare positions (`x.constructor === Array`).
  // The fast paths at call sites (`new Array(n)`, `Array.of`, `Array.prototype`,
  // `Array.isArray`) intercept BEFORE identifier resolution, so adding the
  // global only affects bare-identifier uses.
  const AMBIENT_BUILTIN_CTORS = [
    "Array",
    "Object",
    "Function",
    "Number",
    "String",
    "Boolean",
    "Symbol",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Math",
    "JSON",
    "Reflect",
    "ArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ];
  for (const name of AMBIENT_BUILTIN_CTORS) {
    if (!referencedNames.has(name)) continue;
    if (ctx.declaredGlobals.has(name)) continue;
    const importName = `global_${name}`;
    const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
    }
  }
}

/**
 * DOM-only globals that require a browser host and are not available in WASI.
 * Used to emit a compile error when `--target wasi` is combined with DOM usage.
 */
const DOM_ONLY_GLOBALS = new Set([
  "document",
  "window",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "EventTarget",
  "DocumentFragment",
  "Text",
  "Comment",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]);

/**
 * Register Node.js builtin module imports as externref host imports (#1044).
 *
 * For each detected `import * as X from 'node:http'` (or named/default import),
 * we register a function import `__node_<module>` that returns the module object
 * as externref. The local binding name is added to `declaredGlobals` so that
 * identifier resolution in expressions picks it up via the existing extern path.
 *
 * In WASI mode, emit a compile error instead (Node builtins not available).
 */
function registerNodeBuiltinImports(ctx: CodegenContext, builtins: NodeBuiltinImport[]): void {
  for (const builtin of builtins) {
    if (ctx.wasi) {
      ctx.errors.push({
        message: `Node builtin module '${builtin.moduleName}' is not available in WASI target. Use compile-time syscall path for node:fs (#1035).`,
        line: 1,
        column: 1,
        severity: "error",
      });
      continue;
    }

    // Track this module as a Node builtin so the import manifest/runtime can resolve it
    ctx.mod.nodeBuiltinModules.add(builtin.moduleName);

    const importName = `__node_${builtin.moduleName}`;
    // Skip if already registered (e.g. duplicate imports)
    if (ctx.funcMap.has(importName)) continue;

    const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      // Register as a declared global so identifier resolution picks it up
      ctx.declaredGlobals.set(builtin.localName, { type: { kind: "externref" }, funcIdx });
      ctx.nodeBuiltinGlobals.set(builtin.localName, funcIdx);
    }
  }
}

/** Check if source code references DOM globals (document, window) */
const LIB_GLOBALS = new Set([
  "document",
  "window",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "RegExp",
  "Error",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  // #1065 — ambient builtin constructors that need host-global resolution
  // for bare-identifier uses (e.g. `x.constructor === Array`). Call-site
  // fast paths intercept before identifier resolution runs.
  "Array",
  "Object",
  "Function",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  // #1018 — additional builtins whose .prototype access needs host resolution
  "Promise",
  "Math",
  "JSON",
  "Reflect",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function sourceUsesLibGlobals(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && LIB_GLOBALS.has(node.text)) {
      found = true;
      return;
    }
    // RegExp literals (/pattern/flags) implicitly use the RegExp extern class
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    ts.forEachChild(stmt, visit);
    if (found) break;
  }
  return found;
}

/**
 * In WASI mode, scan source for DOM-only globals and report compile errors.
 * DOM globals require a browser host and are not available in standalone Wasm.
 */
function checkWasiDomUsage(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && DOM_ONLY_GLOBALS.has(node.text)) {
      if (!found.has(node.text)) {
        found.add(node.text);
        reportError(
          ctx,
          node,
          `Codegen error: DOM global '${node.text}' is not available in WASI target — DOM requires a browser host`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    ts.forEachChild(stmt, visit);
  }
}

// ── Regular declaration collection ───────────────────────────────────

/** Collect enum declarations into ctx.enumValues / ctx.enumStringValues */
export function collectEnumDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const stringEnumLiterals: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isEnumDeclaration(stmt)) continue;
    const enumName = stmt.name.text;
    let nextValue = 0;
    for (const member of stmt.members) {
      const memberName = (member.name as ts.Identifier).text;
      const key = `${enumName}.${memberName}`;
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer)) {
          // String enum member — store in enumStringValues
          const strVal = member.initializer.text;
          ctx.enumStringValues.set(key, strVal);
          if (!ctx.stringGlobalMap.has(strVal)) {
            stringEnumLiterals.push(strVal);
          }
          continue;
        }
        if (ts.isNumericLiteral(member.initializer)) {
          nextValue = Number(member.initializer.text.replace(/_/g, ""));
        } else if (
          ts.isPrefixUnaryExpression(member.initializer) &&
          member.initializer.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(member.initializer.operand)
        ) {
          nextValue = -Number((member.initializer.operand as ts.NumericLiteral).text.replace(/_/g, ""));
        }
      }
      ctx.enumValues.set(key, nextValue);
      nextValue++;
    }
  }

  // Register string enum literals as string constant globals
  if (stringEnumLiterals.length > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of stringEnumLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of stringEnumLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }
}

/**
 * Resolve a class member's PropertyName to a static string.
 * Handles identifiers, private identifiers, string literals, numeric literals,
 * and computed property names that can be evaluated at compile time.
 */

/**
 * Pre-pass: hoist all `var` declarations in a function body.
 * Walks statements recursively and pre-allocates a local for each `var`
 * variable not yet in localMap, so identifiers are valid before their
 * declaration site (JavaScript var-hoisting semantics).
 */
export function hoistVarDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForVars(ctx, fctx, stmt);
  }
}

/**
 * Walk a binding pattern and hoist all bound identifiers as locals.
 * Handles nested patterns: var { a, b: { c } } = obj; var [x, [y, z]] = arr;
 */
function hoistBindingPattern(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      if (ctx.moduleGlobals.has(name)) continue;
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      const localIdx = allocLocal(fctx, name, wasmType);
      // Hoisted vars should be `undefined`, not `null` (#737)
      if (wasmType.kind === "externref") {
        emitUndefined(ctx, fctx);
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      hoistBindingPattern(ctx, fctx, element.name);
    }
  }
}

/**
 * Allocate TDZ flags for a let/const destructuring binding pattern so that
 * `let { x = x } = {}` and similar self/forward references in default
 * initializers throw ReferenceError per ECMA-262 §13.3.3.7 (#1128).
 *
 * Called from `compileObjectDestructuring` / `compileArrayDestructuring` at
 * entry — BEFORE the binding-element loop allocates the actual binding locals.
 * Only the TDZ flag is allocated here; the destructuring's own `allocLocal`
 * for the binding runs later (line ~648 of destructuring.ts) and registers
 * the binding name in `localMap`. By the time the default initializer is
 * compiled (after that `allocLocal`), `compileIdentifier` will see both
 * `localMap.has(name)` and `tdzFlagLocals.get(name)` and apply the TDZ check.
 *
 * The TDZ flag is allocated unconditionally for destructured bindings —
 * +1 i32 local per binding is cheap, and unconditionality avoids subtle
 * static-analysis gaps inside default initializers where `analyzeTdzAccess`
 * could otherwise mis-classify the access as "skip".
 */
export function ensureLetConstBindingPatternTdzFlags(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (ctx.moduleGlobals.has(name)) continue;
      // Allocate the binding local up front if missing — needed so that when
      // a default initializer for a SIBLING binding compiles its expression,
      // a forward-reference to this binding (e.g. `let { a = b, b } = {}`)
      // resolves via `localMap.get(name)` and the TDZ check fires. Without
      // this, the forward-ref `b` falls through to the "undeclared globals"
      // path and silently returns a default value instead of throwing.
      if (!fctx.localMap.has(name)) {
        const elemType = ctx.checker.getTypeAtLocation(element);
        const wasmType = resolveWasmType(ctx, elemType);
        allocLocal(fctx, name, wasmType);
      }
      // Allocate TDZ flag if missing — zero-init (uninitialized).
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) {
        const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
        fctx.tdzFlagLocals.set(name, flagIdx);
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      ensureLetConstBindingPatternTdzFlags(ctx, fctx, element.name);
    }
  }
}

/** Hoist a single variable declaration (handles both simple identifiers and binding patterns). */
function hoistVarDecl(ctx: CodegenContext, fctx: FunctionContext, decl: ts.VariableDeclaration): void {
  if (ts.isIdentifier(decl.name)) {
    const name = decl.name.text;
    if (fctx.localMap.has(name)) return;
    if (ctx.moduleGlobals.has(name)) return;
    const varType = ctx.checker.getTypeAtLocation(decl);
    const wasmType = resolveWasmType(ctx, varType);
    const localIdx = allocLocal(fctx, name, wasmType);
    // In JS, hoisted `var` variables are `undefined` before their declaration,
    // not `null`. For externref locals, emit __get_undefined() + local.set (#737).
    if (wasmType.kind === "externref") {
      emitUndefined(ctx, fctx);
      fctx.body.push({ op: "local.set", index: localIdx });
    }
    return;
  }
  // Handle destructuring patterns: var { x, y } = obj; var [a, b] = arr;
  if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
    hoistBindingPattern(ctx, fctx, decl.name);
  }
}

function walkStmtForVars(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Only hoist `var` (not let/const/using/await-using). #1177
    if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) return;
    for (const decl of list.declarations) {
      hoistVarDecl(ctx, fctx, decl);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForVars(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForVars(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
    // Hoist the loop variable for `for (var x in obj)` / `for (var x of arr)`
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isLabeledStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForVars(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForVars(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForVars(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForVars(ctx, fctx, s);
    }
  }
}

/**
 * Pre-pass: hoist all `let`/`const` declarations in a function body with TDZ flags.
 * Unlike var-hoisting (which makes variables immediately accessible), let/const
 * hoisting only pre-allocates the local + a TDZ flag so nested functions can
 * capture the variable. The variable is still in TDZ until the declaration runs.
 */
export function hoistLetConstWithTdz(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForLetConst(ctx, fctx, stmt);
  }
}

/**
 * Check if a let/const variable needs a TDZ flag by analyzing all references.
 * Returns false if every access to the symbol is provably after the declaration
 * in straight-line code (same function, no closures, loop-local safe).
 */
function needsTdzFlag(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return true;
  const declEnd = decl.getEnd();
  const declFunc = getContainingFunctionForTdz(decl);

  // Collect all references to this symbol in the containing function
  // We walk the function body checking every identifier that resolves to this symbol
  const funcBody = declFunc && "body" in declFunc ? (declFunc as any).body : undefined;
  const scope = funcBody || decl.getSourceFile();

  let needsFlag = false;
  function visit(node: ts.Node): void {
    if (needsFlag) return;
    if (ts.isIdentifier(node) && node !== decl.name) {
      const sym = ctx.checker.getSymbolAtLocation(node);
      if (sym === symbol) {
        const accessPos = node.getStart();
        const accessFunc = getContainingFunctionForTdz(node);
        // Cross-function access (closure) — needs flag
        if (accessFunc !== declFunc) {
          needsFlag = true;
          return;
        }
        // Access before declaration — needs flag
        if (accessPos < declEnd) {
          needsFlag = true;
          return;
        }
        // Check loop safety: if access is inside a loop containing the decl,
        // it's only safe if decl is in the loop body and access is after decl
        if (isInsideLoopContainingForTdz(node, decl)) {
          needsFlag = true;
          return;
        }
      }
    }
    // Don't recurse into nested functions (they have their own scope)
    if (
      node !== scope &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      // But DO check if they reference our symbol (closure capture)
      ts.forEachChild(node, visit);
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(scope, visit);
  return needsFlag;
}

/** Walk up to find nearest containing function (TDZ analysis version for index.ts). */
function getContainingFunctionForTdz(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** Check if access is inside a loop containing decl (TDZ version for index.ts). */
function isInsideLoopContainingForTdz(access: ts.Node, decl: ts.Node): boolean {
  let current = access.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return false;
    }
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      if (isDescendantOfNode(decl, current)) {
        // For-initializer variables (e.g. `for (let i = 0; ...)`) are always
        // initialized before the body/condition/incrementor execute
        if (ts.isForStatement(current) && current.initializer && isDescendantOfNode(decl, current.initializer)) {
          return false;
        }
        // For-in/for-of loop variables are initialized each iteration
        if (
          (ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
          isDescendantOfNode(decl, current.initializer)
        ) {
          return false;
        }
        // Both in loop — check if decl is in loop body and access after decl
        const body = getLoopBodyNode(current);
        if (body && isDescendantOfNode(decl, body) && access.getStart() >= decl.getEnd()) {
          return false; // loop-local, access after decl — safe per iteration
        }
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isDescendantOfNode(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function getLoopBodyNode(loop: ts.Node): ts.Node | undefined {
  if (ts.isForStatement(loop)) return loop.statement;
  if (ts.isForInStatement(loop)) return loop.statement;
  if (ts.isForOfStatement(loop)) return loop.statement;
  if (ts.isWhileStatement(loop)) return loop.statement;
  if (ts.isDoStatement(loop)) return loop.statement;
  return undefined;
}

function walkStmtForLetConst(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Hoist `let`/`const`/`using` (not var — var is already hoisted).
    // `using`/`await using` declarations have the same TDZ semantics as
    // let/const per the explicit-resource-management spec — pre-decl access
    // must throw ReferenceError. (#1177)
    const TDZ_FLAGS = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;
    if (!(list.flags & TDZ_FLAGS)) return;
    for (const decl of list.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        if (fctx.localMap.has(name)) continue;
        if (ctx.moduleGlobals.has(name)) continue;
        const varType = ctx.checker.getTypeAtLocation(decl);
        // #1120: pre-allocate as i32 if collectI32CoercedLocals tagged this
        // local — keeps the hoisted slot in sync with what compileVariableStatement
        // will use, avoiding a slot-type mismatch on first assignment.
        const isI32Coerced =
          fctx.i32CoercedLocals?.has(name) === true && (varType.flags & ts.TypeFlags.NumberLike) !== 0;
        const wasmType: ValType = isI32Coerced ? { kind: "i32" } : resolveWasmType(ctx, varType);
        allocLocal(fctx, name, wasmType);
        // Only add TDZ flag if static analysis can't prove all accesses are safe
        if (needsTdzFlag(ctx, decl)) {
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
          fctx.tdzFlagLocals.set(name, flagIdx);
        }
      }
      // Destructuring patterns (let/const) are NOT pre-allocated here —
      // `compileObjectDestructuring` / `compileArrayDestructuring` allocate
      // their own bindings + TDZ flags via `ensureLetConstBindingPatternTdzFlags`
      // at entry. Pre-allocating here would create duplicate locals (one from
      // the pre-pass, one from destructuring) and pollute closure-capture
      // analysis (#1128).
    }
    return;
  }
  // Recurse into block-like structures (but NOT into nested functions)
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForLetConst(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForLetConst(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForLetConst(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    // Do NOT pre-allocate for-loop let/const initializer variables here.
    // compileForStatement handles their allocation with correct types (e.g. i32
    // for integer loop counters). Pre-allocating here would create duplicate
    // locals: one f64 from the pre-pass, one i32 from codegen — see #954.
    // The loop body may still declare let/const variables, so recurse into it.
    walkStmtForLetConst(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForLetConst(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForLetConst(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForLetConst(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForLetConst(ctx, fctx, s);
    }
  }
}

/**
 * Check if a function body references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
export function cacheStringLiterals(ctx: CodegenContext, fctx: FunctionContext): void {
  // Build a set of funcIdx values that correspond to string literal thunks
  const strFuncIdxSet = new Set<number>();
  for (const [, importName] of ctx.stringLiteralMap) {
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) strFuncIdxSet.add(funcIdx);
  }
  if (strFuncIdxSet.size === 0) return;

  // Collect all unique string-thunk funcIdx values used in the body
  const usedFuncIdxs = new Set<number>();
  collectStringCalls(fctx.body, strFuncIdxSet, usedFuncIdxs);
  if (usedFuncIdxs.size === 0) return;

  // Allocate a local for each unique string thunk and build the mapping
  const cacheMap = new Map<number, number>(); // funcIdx → local index
  for (const funcIdx of usedFuncIdxs) {
    const localIdx = allocLocal(fctx, `__cached_str_${funcIdx}`, {
      kind: "externref",
    });
    cacheMap.set(funcIdx, localIdx);
  }

  // Build the cache-loading preamble (call + local.set for each)
  const preamble: Instr[] = [];
  for (const [funcIdx, localIdx] of cacheMap) {
    preamble.push({ op: "call", funcIdx });
    preamble.push({ op: "local.set", index: localIdx });
  }

  // Replace all matching call instructions in the body with local.get
  replaceStringCalls(fctx.body, cacheMap);

  // Prepend the preamble at the start of the body
  fctx.body.unshift(...preamble);
}

/** Recursively scan instructions to find call instructions targeting string thunks. */
function collectStringCalls(instrs: Instr[], strFuncIdxSet: Set<number>, found: Set<number>): void {
  for (const instr of instrs) {
    if ((instr.op === "call" || instr.op === "return_call") && strFuncIdxSet.has(instr.funcIdx)) {
      found.add(instr.funcIdx);
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
    } else if (instr.op === "if") {
      collectStringCalls(instr.then, strFuncIdxSet, found);
      if (instr.else) collectStringCalls(instr.else, strFuncIdxSet, found);
    } else if (instr.op === "try") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
      for (const c of instr.catches) {
        collectStringCalls(c.body, strFuncIdxSet, found);
      }
      if (instr.catchAll) collectStringCalls(instr.catchAll, strFuncIdxSet, found);
    }
  }
}

/** Recursively replace call instructions matching the cache map with local.get. */
function replaceStringCalls(instrs: Instr[], cacheMap: Map<number, number>): void {
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    if ((instr.op === "call" || instr.op === "return_call") && cacheMap.has(instr.funcIdx)) {
      // Replace in-place: swap the call with a local.get
      const localIdx = cacheMap.get(instr.funcIdx)!;
      (instrs as any)[i] = { op: "local.get", index: localIdx };
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop") {
      replaceStringCalls(instr.body, cacheMap);
    } else if (instr.op === "if") {
      replaceStringCalls(instr.then, cacheMap);
      if (instr.else) replaceStringCalls(instr.else, cacheMap);
    } else if (instr.op === "try") {
      replaceStringCalls(instr.body, cacheMap);
      for (const c of instr.catches) {
        replaceStringCalls(c.body, cacheMap);
      }
      if (instr.catchAll) replaceStringCalls(instr.catchAll, cacheMap);
    }
  }
}

export function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function hasDeclareModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

export function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

export function hasAbstractModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0;
}

export function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

/** Check if a function declaration is a generator (function*) */
export function isGeneratorFunction(node: ts.FunctionDeclaration): boolean {
  return node.asteriskToken !== undefined;
}

/**
 * Unwrap Generator<T> return type to get the yield element type T.
 * Falls back to externref if the type cannot be unwrapped.
 */
export function unwrapGeneratorYieldType(type: ts.Type, ctx: CodegenContext): ValType {
  const symbol = type.getSymbol();
  if (symbol && symbol.name === "Generator") {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Also check Iterator and IterableIterator
  if (symbol && (symbol.name === "Iterator" || symbol.name === "IterableIterator")) {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Fallback: assume number yield type (most common case)
  return { kind: "f64" };
}

/**
 * Ensure the stack top is an i32 suitable for use as a condition.
 * Handles: f64 (truthy != 0), externref (JS truthiness via __is_truthy), null (push 0).
 */
export function ensureI32Condition(fctx: FunctionContext, condType: ValType | null, ctx?: CodegenContext): void {
  if (!condType) {
    // Expression compilation failed — push false to keep Wasm valid
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (condType.kind === "f64") {
    // Use f64.abs + f64.gt(0) so that NaN, +0, and -0 are all falsy
    // (f64.ne(0) treats NaN as truthy which is wrong for JS semantics)
    fctx.body.push({ op: "f64.abs" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
  } else if (condType.kind === "externref") {
    // Use __is_truthy for proper JS truthiness (0, NaN, null, undefined, "" → falsy)
    if (ctx) {
      addUnionImports(ctx);
      const funcIdx = ctx.funcMap.get("__is_truthy");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // Fallback: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "ref" || condType.kind === "ref_null") {
    // Boxed any value — use __any_unbox_bool for proper JS truthiness
    if (ctx && isAnyValue(condType, ctx)) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_unbox_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // Native string or struct ref — non-empty string is truthy
    // For strings: check length > 0 via string.measure_utf8 or ref.is_null fallback
    if (ctx && condType.typeIdx === ctx.anyStrTypeIdx) {
      // Native string — check length > 0
      const lengthIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (lengthIdx !== undefined) {
        // Flatten then check len field
        fctx.body.push({ op: "call", funcIdx: lengthIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: ctx.nativeStrTypeIdx,
          fieldIdx: 0,
        }); // len field
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.gt_s" });
        return;
      }
    }
    // Fallback: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "i64") {
    // i64 truthiness: nonzero → true
    fctx.body.push({ op: "i64.eqz" });
    fctx.body.push({ op: "i32.eqz" });
  }
  // i32 is already valid as-is
}

export { popBody, pushBody } from "./context/bodies.js";
export { createCodegenContext } from "./context/create-context.js";
export { reportError } from "./context/errors.js";
export { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
export { attachSourcePos, getSourcePos } from "./context/source-pos.js";
export type {
  ClosureInfo,
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  ExternClassInfo,
  FunctionContext,
  InlinableFunctionInfo,
  OptionalParamInfo,
  RestParamInfo,
} from "./context/types.js";
export {
  addImport,
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  nextModuleGlobalIdx,
} from "./registry/imports.js";
export {
  addFuncType,
  funcTypeEq,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterRefCellType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
export { compileExpression, compileStatement } from "./shared.js";
