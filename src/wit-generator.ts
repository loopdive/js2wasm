// Copyright (c) 2026 Loopdive GmbH. Licensed under AGPL-3.0.
/**
 * WIT (WebAssembly Interface Types) generator.
 *
 * Generates a .wit file from TypeScript exported functions and interfaces.
 * This is the first step toward Component Model support.
 *
 * TypeScript -> WIT type mapping:
 *   number    -> f64
 *   string    -> string
 *   boolean   -> bool
 *   void      -> (no return type)
 *   null/undefined -> (omitted)
 *   number[]  -> list<f64>
 *   string[]  -> list<string>
 *   boolean[] -> list<bool>
 *   interface { x: number } -> record name { x: f64 }
 *   T | null  -> option<T>
 */

import ts from "typescript";
import type { TypedAST } from "./checker/index.js";

export interface WitGeneratorOptions {
  /** Package name for the WIT world (default: "local:module") */
  packageName?: string;
  /** World name (default: "module") */
  worldName?: string;
}

interface WitRecord {
  name: string;
  fields: { name: string; type: string }[];
}

interface WitFunc {
  name: string;
  params: { name: string; type: string }[];
  result: string | null;
}

/**
 * Generate a WIT interface definition from a TypedAST.
 * Extracts all exported functions and referenced interfaces/type aliases,
 * then maps them to WIT types.
 */
export function generateWit(ast: TypedAST, options?: WitGeneratorOptions): string {
  const packageName = options?.packageName ?? "local:module";
  const worldName = options?.worldName ?? "module";

  const records: WitRecord[] = [];
  const recordNames = new Set<string>();
  const funcs: WitFunc[] = [];

  const sf = ast.sourceFile;
  const checker = ast.checker;

  // First pass: collect all exported interfaces as records
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && hasExportModifier(stmt)) {
      const rec = interfaceToRecord(stmt, sf, checker, records, recordNames);
      if (rec && !recordNames.has(rec.name)) {
        records.push(rec);
        recordNames.add(rec.name);
      }
    }

    // Also handle exported type aliases that resolve to object types
    if (ts.isTypeAliasDeclaration(stmt) && hasExportModifier(stmt)) {
      const rec = typeAliasToRecord(stmt, sf, checker, records, recordNames);
      if (rec && !recordNames.has(rec.name)) {
        records.push(rec);
        recordNames.add(rec.name);
      }
    }
  }

  // Second pass: collect exported functions
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const witFunc = functionToWit(stmt, sf, checker, records, recordNames);
      if (witFunc) {
        funcs.push(witFunc);
      }
    }
  }

  // Build the WIT output
  const lines: string[] = [];
  lines.push(`package ${packageName};`);
  lines.push("");
  lines.push(`world ${worldName} {`);

  // Emit records
  for (const rec of records) {
    lines.push(`  record ${rec.name} {`);
    for (const field of rec.fields) {
      lines.push(`    ${field.name}: ${field.type},`);
    }
    lines.push("  }");
    lines.push("");
  }

  // Emit exported functions
  for (const func of funcs) {
    const params = func.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    const returnPart = func.result ? ` -> ${func.result}` : "";
    lines.push(`  export ${func.name}: func(${params})${returnPart};`);
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

// ── Type mapping ─────────────────────────────────────────────────────

/**
 * Map a TypeScript type node to a WIT type string.
 * Returns null if the type cannot be mapped.
 */
function mapTypeToWit(
  typeNode: ts.TypeNode | undefined,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): string | null {
  if (!typeNode) return null;

  // Keyword types
  if (ts.isToken(typeNode)) {
    switch (typeNode.kind) {
      case ts.SyntaxKind.NumberKeyword:
        return "f64";
      case ts.SyntaxKind.StringKeyword:
        return "string";
      case ts.SyntaxKind.BooleanKeyword:
        return "bool";
      case ts.SyntaxKind.VoidKeyword:
        return null;
      case ts.SyntaxKind.UndefinedKeyword:
        return null;
      case ts.SyntaxKind.NullKeyword:
        return null;
      case ts.SyntaxKind.AnyKeyword:
        // 'any' has no WIT equivalent; best-effort map to string
        return "string";
    }
  }

  // Array types: number[] -> list<f64>
  if (ts.isArrayTypeNode(typeNode)) {
    const elemType = mapTypeToWit(typeNode.elementType, sf, checker, records, recordNames);
    if (elemType) return `list<${elemType}>`;
    return null;
  }

  // Array<T> generic
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sf);

    if (typeName === "Array" && typeNode.typeArguments?.length === 1) {
      const elemType = mapTypeToWit(typeNode.typeArguments[0], sf, checker, records, recordNames);
      if (elemType) return `list<${elemType}>`;
      return null;
    }

    // Named type reference -> check if it's a known record
    const witName = toKebabCase(typeName);
    if (recordNames.has(witName)) {
      return witName;
    }

    // Try to resolve the type and create a record if it's an object type
    const type = checker.getTypeAtLocation(typeNode);
    const rec = resolveObjectTypeToRecord(witName, type, checker, records, recordNames);
    if (rec) {
      return witName;
    }

    return null;
  }

  // Union types: T | null -> option<T>, T | undefined -> option<T>
  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullTypes = typeNode.types.filter((t) => {
      if (ts.isToken(t)) {
        return t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword;
      }
      if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) {
        return false;
      }
      return true;
    });

    const hasNull = nonNullTypes.length < typeNode.types.length;

    if (nonNullTypes.length === 1) {
      const inner = mapTypeToWit(nonNullTypes[0], sf, checker, records, recordNames);
      if (inner && hasNull) return `option<${inner}>`;
      return inner;
    }

    // Multiple non-null types: cannot map cleanly
    return null;
  }

  // Type literal: { x: number; y: number } -> inline record
  if (ts.isTypeLiteralNode(typeNode)) {
    const fields: { name: string; type: string }[] = [];
    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member) && member.name && member.type) {
        const fieldName = toKebabCase(member.name.getText(sf));
        const fieldType = mapTypeToWit(member.type, sf, checker, records, recordNames);
        if (fieldType) {
          fields.push({ name: fieldName, type: fieldType });
        }
      }
    }
    if (fields.length > 0) {
      // Create an anonymous record with a generated name
      const anonName = `anon-record-${records.length}`;
      if (!recordNames.has(anonName)) {
        records.push({ name: anonName, fields });
        recordNames.add(anonName);
      }
      return anonName;
    }
    return null;
  }

  // Parenthesized type: (T) -> T
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return mapTypeToWit(typeNode.type, sf, checker, records, recordNames);
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function interfaceToRecord(
  node: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitRecord | null {
  const name = toKebabCase(node.name.text);
  const fields: { name: string; type: string }[] = [];

  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name && member.type) {
      const fieldName = toKebabCase(member.name.getText(sf));
      const fieldType = mapTypeToWit(member.type, sf, checker, records, recordNames);
      if (fieldType) {
        fields.push({ name: fieldName, type: fieldType });
      }
    }
  }

  if (fields.length === 0) return null;
  return { name, fields };
}

function typeAliasToRecord(
  node: ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitRecord | null {
  const name = toKebabCase(node.name.text);

  if (ts.isTypeLiteralNode(node.type)) {
    const fields: { name: string; type: string }[] = [];
    for (const member of node.type.members) {
      if (ts.isPropertySignature(member) && member.name && member.type) {
        const fieldName = toKebabCase(member.name.getText(sf));
        const fieldType = mapTypeToWit(member.type, sf, checker, records, recordNames);
        if (fieldType) {
          fields.push({ name: fieldName, type: fieldType });
        }
      }
    }
    if (fields.length > 0) return { name, fields };
  }

  return null;
}

function resolveObjectTypeToRecord(
  witName: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitRecord | null {
  if (recordNames.has(witName)) return null; // already exists

  const props = type.getProperties();
  if (props.length === 0) return null;

  // Temporarily add the name to prevent infinite recursion
  recordNames.add(witName);

  const fields: { name: string; type: string }[] = [];
  for (const prop of props) {
    const decl = prop.valueDeclaration;
    if (!decl) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    const witType = mapTsTypeToWit(propType, checker, records, recordNames);
    if (witType) {
      fields.push({ name: toKebabCase(prop.name), type: witType });
    }
  }

  if (fields.length === 0) {
    recordNames.delete(witName);
    return null;
  }

  const rec = { name: witName, fields };
  records.push(rec);
  return rec;
}

/**
 * Map a ts.Type (resolved type) to a WIT type string.
 * Used when we have a resolved type from the checker rather than a type node.
 */
function mapTsTypeToWit(
  type: ts.Type,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): string | null {
  if (type.flags & ts.TypeFlags.Number) return "f64";
  if (type.flags & ts.TypeFlags.String) return "string";
  if (type.flags & ts.TypeFlags.Boolean || type.flags & ts.TypeFlags.BooleanLiteral) return "bool";
  if (type.flags & ts.TypeFlags.Void) return null;
  if (type.flags & ts.TypeFlags.Undefined) return null;
  if (type.flags & ts.TypeFlags.Null) return null;

  // Check for array type
  const numberIndex = type.getNumberIndexType();
  if (numberIndex && checker.isArrayType(type)) {
    const elemType = mapTsTypeToWit(numberIndex, checker, records, recordNames);
    if (elemType) return `list<${elemType}>`;
  }

  return null;
}

function functionToWit(
  node: ts.FunctionDeclaration,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  records: WitRecord[],
  recordNames: Set<string>,
): WitFunc | null {
  if (!node.name) return null;

  const name = toKebabCase(node.name.text);
  const params: { name: string; type: string }[] = [];

  for (const param of node.parameters) {
    const paramName = ts.isIdentifier(param.name) ? toKebabCase(param.name.text) : `p${params.length}`;
    const paramType = mapTypeToWit(param.type, sf, checker, records, recordNames);
    if (paramType) {
      params.push({ name: paramName, type: paramType });
    }
  }

  const result = mapTypeToWit(node.type, sf, checker, records, recordNames);

  return { name, params, result };
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Convert a camelCase or PascalCase identifier to kebab-case for WIT.
 * WIT uses kebab-case for all identifiers.
 */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}
