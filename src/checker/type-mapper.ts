import ts from "typescript";
import type { ValType } from "../ir/types.js";

export function mapTsTypeToWasm(
  type: ts.Type,
  checker: ts.TypeChecker,
): ValType {
  if (
    type.flags & ts.TypeFlags.Number ||
    type.flags & ts.TypeFlags.NumberLiteral
  ) {
    return { kind: "f64" };
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
      const inner = mapTsTypeToWasm(nonNullish[0]!, checker);
      if (inner.kind === "ref")
        return { kind: "ref_null", typeIdx: inner.typeIdx };
      // T | undefined for primitives → just use T (e.g. number | undefined → f64)
      return inner;
    }
    // Check if all non-nullish types map to the same Wasm kind (e.g. 0 | 2 → f64)
    if (nonNullish.length > 1) {
      const mapped = nonNullish.map((t) => mapTsTypeToWasm(t, checker));
      if (mapped.every((m) => m.kind === mapped[0]!.kind)) {
        return mapped[0]!;
      }
    }
    // Real heterogeneous union → externref
    return { kind: "externref" };
  }

  // Object types (interfaces, arrays, functions)
  if (type.flags & ts.TypeFlags.Object) {
    if (isExternalDeclaredClass(type)) return { kind: "externref" };
    // Placeholder -1 for named structs — resolved by resolveWasmType in codegen.
    // If codegen can't resolve it (e.g. Array, Function), it falls back here
    // and resolveWasmType passes it through, so we use externref as safe fallback.
    return { kind: "externref" };
  }

  // any/unknown/error → treat as externref (opaque JS value)
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return { kind: "externref" };
  }

  return { kind: "externref" };
}

/** Check if a type is an externally declared class (declare class / declare var with constructor) */
export function isExternalDeclaredClass(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return false;
  return decls.some(
    (d) =>
      // declare class Foo { ... }
      (ts.isClassDeclaration(d) && isDeclareContext(d)) ||
      // declare var Foo: { prototype: Foo; new(): Foo }  (lib.dom.d.ts pattern)
      (ts.isVariableDeclaration(d) && isDeclareVarWithConstructor(d)),
  );
}

function isDeclareVarWithConstructor(d: ts.VariableDeclaration): boolean {
  const stmt = d.parent?.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return false;
  if (!isDeclareContext(stmt)) return false;
  if (!d.type || !ts.isTypeLiteralNode(d.type)) return false;
  return d.type.members.some((m) => ts.isConstructSignatureDeclaration(m));
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
