import ts from "typescript";
import type { ValType } from "../ir/types.js";

/** Types with built-in wasm GC handling that should NOT be treated as extern classes */
const BUILTIN_TYPES = new Set([
  "Array", "Number", "Boolean", "String", "Object", "Function",
  "Symbol", "BigInt", "Int8Array", "Uint8Array", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
  "ArrayBuffer", "DataView", "JSON", "Math", "Promise",
  "Generator", "Iterator", "IterableIterator", "Iterable",
  "IteratorResult", "IteratorYieldResult", "IteratorReturnResult",
]);

export function mapTsTypeToWasm(
  type: ts.Type,
  checker: ts.TypeChecker,
  fast?: boolean,
): ValType {
  if (
    type.flags & ts.TypeFlags.Number ||
    type.flags & ts.TypeFlags.NumberLiteral
  ) {
    return { kind: fast ? "i32" : "f64" };
  }
  if (
    type.flags & ts.TypeFlags.Boolean ||
    type.flags & ts.TypeFlags.BooleanLiteral
  ) {
    return { kind: "i32" };
  }
  if (
    type.flags & ts.TypeFlags.String ||
    type.flags & ts.TypeFlags.StringLiteral
  ) {
    return { kind: "externref" }; // JS string pass-through
  }
  if (
    type.flags & ts.TypeFlags.Void ||
    type.flags & ts.TypeFlags.Undefined
  ) {
    return { kind: "i32" }; // void → no result (handled in codegen)
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { kind: "externref" };
  }

  // Union with null/undefined → unwrap to inner type
  if (type.isUnion()) {
    const nonNullish = type.types.filter(
      (t) =>
        !(t.flags & ts.TypeFlags.Null) &&
        !(t.flags & ts.TypeFlags.Undefined),
    );
    if (nonNullish.length === 1) {
      const inner = mapTsTypeToWasm(nonNullish[0]!, checker, fast);
      if (inner.kind === "ref")
        return { kind: "ref_null", typeIdx: inner.typeIdx };
      // T | undefined for primitives → just use T (e.g. number | undefined → f64)
      return inner;
    }
    // Check if all non-nullish types map to the same Wasm kind (e.g. 0 | 2 → f64)
    if (nonNullish.length > 1) {
      const mapped = nonNullish.map((t) => mapTsTypeToWasm(t, checker, fast));
      if (mapped.every((m) => m.kind === mapped[0]!.kind)) {
        return mapped[0]!;
      }
    }
    // Real heterogeneous union → externref
    return { kind: "externref" };
  }

  // Object types (interfaces, arrays, functions)
  if (type.flags & ts.TypeFlags.Object) {
    if (isExternalDeclaredClass(type, checker)) return { kind: "externref" };
    // Placeholder -1 for named structs — resolved by resolveWasmType in codegen.
    // If codegen can't resolve it (e.g. Array, Function), it falls back here
    // and resolveWasmType passes it through, so we use externref as safe fallback.
    return { kind: "externref" };
  }

  // Type parameter (generics) — check constraint, fallback to externref
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint) {
      return mapTsTypeToWasm(constraint, checker, fast);
    }
    return { kind: "externref" };
  }

  // any/unknown/error → treat as externref (opaque JS value)
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return { kind: "externref" };
  }

  return { kind: "externref" };
}

/** Check if a type is an externally declared class (declare class / declare var with constructor) */
export function isExternalDeclaredClass(type: ts.Type, checker?: ts.TypeChecker): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return false;
  const symName = symbol.getName();
  if (decls.some(
    (d) =>
      // declare class Foo { ... }
      (ts.isClassDeclaration(d) && isDeclareContext(d)) ||
      // declare var Foo: { prototype: Foo; new(): Foo }  (lib.dom.d.ts pattern)
      (ts.isVariableDeclaration(d) && isDeclareVarWithConstructor(d)) ||
      // declare var Date: DateConstructor  (TypeReferenceNode pattern, skip builtins)
      (ts.isVariableDeclaration(d) && checker && !BUILTIN_TYPES.has(symName) &&
        isDeclareVarWithTypeRefConstructor(d, checker)),
  )) return true;

  return false;
}

function isDeclareVarWithConstructor(d: ts.VariableDeclaration): boolean {
  const stmt = d.parent?.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return false;
  if (!isDeclareContext(stmt)) return false;
  if (!d.type || !ts.isTypeLiteralNode(d.type)) return false;
  return d.type.members.some((m) => ts.isConstructSignatureDeclaration(m));
}

/** Check declare var with TypeReferenceNode type that has construct signatures (e.g. declare var Date: DateConstructor) */
function isDeclareVarWithTypeRefConstructor(d: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  const stmt = d.parent?.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return false;
  if (!isDeclareContext(stmt)) return false;
  if (!d.type || !ts.isTypeReferenceNode(d.type)) return false;
  const refType = checker.getTypeAtLocation(d.type);
  return refType.getConstructSignatures().length > 0;
}

function isDeclareContext(node: ts.Node): boolean {
  if (ts.canHaveModifiers(node)) {
    const mods = ts.getModifiers(node);
    if (mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
      return true;
  }
  // Check if inside a declare namespace/module
  // ClassDecl → ModuleBlock → ModuleDeclaration, so walk up
  if (node.parent) {
    if (ts.isModuleDeclaration(node.parent)) {
      return isDeclareContext(node.parent);
    }
    if (ts.isModuleBlock(node.parent)) {
      return isDeclareContext(node.parent.parent);
    }
  }
  return false;
}

/** Check if a ts.Type represents void */
export function isVoidType(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.Void) !== 0 ||
    (type.flags & ts.TypeFlags.Undefined) !== 0
  );
}

/** Check if a ts.Type represents number */
export function isNumberType(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.Number) !== 0 ||
    (type.flags & ts.TypeFlags.NumberLiteral) !== 0
  );
}

/** Check if a ts.Type represents boolean */
export function isBooleanType(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.Boolean) !== 0 ||
    (type.flags & ts.TypeFlags.BooleanLiteral) !== 0
  );
}

/** Check if a ts.Type represents string */
export function isStringType(type: ts.Type): boolean {
  return (
    (type.flags & ts.TypeFlags.String) !== 0 ||
    (type.flags & ts.TypeFlags.StringLiteral) !== 0
  );
}

/**
 * Check if a ts.Type is Promise<T>.
 * Returns true for the built-in Promise generic type.
 */
export function isPromiseType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return symbol.name === "Promise" && !!(type.flags & ts.TypeFlags.Object);
}

/**
 * Check if a ts.Type is Generator<T>, Iterator<T>, or IterableIterator<T>.
 * Returns true for any of the built-in generator/iterator types.
 */
export function isGeneratorType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return (
    (symbol.name === "Generator" ||
      symbol.name === "Iterator" ||
      symbol.name === "IterableIterator") &&
    !!(type.flags & ts.TypeFlags.Object)
  );
}

/**
 * Check if a ts.Type is IteratorResult<T> (the return type of .next()).
 */
export function isIteratorResultType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return (
    (symbol.name === "IteratorYieldResult" ||
      symbol.name === "IteratorReturnResult" ||
      symbol.name === "IteratorResult") &&
    !!(type.flags & ts.TypeFlags.Object)
  );
}

/**
 * Unwrap Promise<T> to T. If the type is not a Promise, returns the type unchanged.
 * Used to extract the inner type of async function return types.
 */
export function unwrapPromiseType(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  if (!isPromiseType(type)) return type;
  const typeRef = type as ts.TypeReference;
  const typeArgs = checker.getTypeArguments(typeRef);
  if (typeArgs.length > 0) {
    return typeArgs[0]!;
  }
  return type;
}

/**
 * Check if a ts.Type is a heterogeneous union (e.g. number | string)
 * that requires externref boxing. Returns false for T | null/undefined unions
 * where the non-nullish types all map to the same Wasm kind.
 */
export function isHeterogeneousUnion(type: ts.Type, checker: ts.TypeChecker, fast?: boolean): boolean {
  if (!type.isUnion()) return false;
  const nonNullish = type.types.filter(
    (t) =>
      !(t.flags & ts.TypeFlags.Null) &&
      !(t.flags & ts.TypeFlags.Undefined),
  );
  if (nonNullish.length <= 1) return false;
  const mapped = nonNullish.map((t) => mapTsTypeToWasm(t, checker, fast));
  return !mapped.every((m) => m.kind === mapped[0]!.kind);
}
