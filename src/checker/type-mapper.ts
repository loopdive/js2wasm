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
    return { kind: "ref", typeIdx: -1 }; // resolved in codegen
  }
  if (
    type.flags & ts.TypeFlags.Void ||
    type.flags & ts.TypeFlags.Undefined
  ) {
    return { kind: "i32" }; // void → no result (handled in codegen)
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { kind: "ref_null", typeIdx: -1 };
  }

  // Union with null → nullable
  if (type.isUnion()) {
    const nonNull = type.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null),
    );
    if (nonNull.length === 1 && type.types.length === 2) {
      const inner = mapTsTypeToWasm(nonNull[0]!, checker);
      if (inner.kind === "ref")
        return { kind: "ref_null", typeIdx: inner.typeIdx };
    }
    // Real union → tagged
    return { kind: "ref", typeIdx: -1 };
  }

  // Object types (interfaces, arrays, functions)
  if (type.flags & ts.TypeFlags.Object) {
    return { kind: "ref", typeIdx: -1 }; // resolved in codegen
  }

  // any/unknown → tagged
  return { kind: "ref", typeIdx: -1 };
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
