import ts from "typescript";

/**
 * Perform tree-shaking: given entry exports and a set of source files,
 * determine which top-level declarations are reachable.
 *
 * The algorithm is conservative — if in doubt, a declaration is kept.
 *
 * @param entryExports - Names of exports from the entry file to keep
 * @param sourceFiles - All source files in the compilation
 * @param checker - TypeScript type checker for resolving references
 * @returns Set of reachable top-level declaration nodes
 */
export function treeshake(
  entryExports: string[],
  sourceFiles: ts.SourceFile[],
  checker: ts.TypeChecker,
): Set<ts.Node> {
  const reachable = new Set<ts.Node>();
  const visitedSymbols = new Set<ts.Symbol>();

  // Build a map from symbol → top-level declaration node
  const symbolToDecl = new Map<ts.Symbol, ts.Node>();

  for (const sf of sourceFiles) {
    for (const stmt of sf.statements) {
      const symbols = getTopLevelSymbols(stmt, checker);
      for (const sym of symbols) {
        symbolToDecl.set(sym, stmt);
      }
    }
  }

  // Find entry file (last source file by convention)
  const entryFile = sourceFiles[sourceFiles.length - 1];
  if (!entryFile) return reachable;

  // Seed: find the entry export symbols
  const entryExportSet = new Set(entryExports);
  for (const stmt of entryFile.statements) {
    if (!hasExportModifier(stmt)) continue;

    const names = getDeclaredNames(stmt);
    for (const name of names) {
      if (entryExportSet.size === 0 || entryExportSet.has(name)) {
        // This export is a seed — mark it and trace its references
        const symbols = getTopLevelSymbols(stmt, checker);
        for (const sym of symbols) {
          markReachable(sym, symbolToDecl, reachable, visitedSymbols, checker);
        }
      }
    }
  }

  // Also keep module-level side effects (variable statements without export
  // that have initializers with calls, class declarations, enum declarations).
  // Be conservative: keep anything that looks like it has side effects.
  for (const sf of sourceFiles) {
    for (const stmt of sf.statements) {
      if (isSideEffectStatement(stmt)) {
        reachable.add(stmt);
        // Trace references from side-effect statements too
        const symbols = getTopLevelSymbols(stmt, checker);
        for (const sym of symbols) {
          markReachable(sym, symbolToDecl, reachable, visitedSymbols, checker);
        }
      }
    }
  }

  return reachable;
}

/**
 * Mark a symbol and all symbols it references as reachable.
 */
function markReachable(
  sym: ts.Symbol,
  symbolToDecl: Map<ts.Symbol, ts.Node>,
  reachable: Set<ts.Node>,
  visitedSymbols: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): void {
  if (visitedSymbols.has(sym)) return;
  visitedSymbols.add(sym);

  // If this symbol has an aliased target, follow it
  const aliased = getAliasedSymbol(sym, checker);
  if (aliased && aliased !== sym) {
    markReachable(aliased, symbolToDecl, reachable, visitedSymbols, checker);
  }

  // Mark the declaration node as reachable
  const declNode = symbolToDecl.get(sym);
  if (declNode) {
    reachable.add(declNode);
  }

  // Also check aliased symbol's declaration
  if (aliased && aliased !== sym) {
    const aliasedDecl = symbolToDecl.get(aliased);
    if (aliasedDecl) {
      reachable.add(aliasedDecl);
    }
  }

  // Walk the declarations of this symbol to find references to other symbols
  const declarations = sym.getDeclarations() ?? [];
  for (const decl of declarations) {
    walkReferences(decl, symbolToDecl, reachable, visitedSymbols, checker);
  }
}

/**
 * Walk an AST node to find all symbol references and mark them as reachable.
 */
function walkReferences(
  node: ts.Node,
  symbolToDecl: Map<ts.Symbol, ts.Node>,
  reachable: Set<ts.Node>,
  visitedSymbols: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): void {
  function visit(n: ts.Node): void {
    // Identifier references
    if (ts.isIdentifier(n)) {
      try {
        const sym = checker.getSymbolAtLocation(n);
        if (sym) {
          markReachable(sym, symbolToDecl, reachable, visitedSymbols, checker);
        }
      } catch {
        // Symbol resolution can fail for some nodes — ignore
      }
    }

    // Type references (e.g., parameter types, return types)
    if (ts.isTypeReferenceNode(n)) {
      try {
        const sym = checker.getSymbolAtLocation(n.typeName);
        if (sym) {
          markReachable(sym, symbolToDecl, reachable, visitedSymbols, checker);
        }
      } catch {
        // ignore
      }
    }

    ts.forEachChild(n, visit);
  }

  visit(node);
}

/**
 * Get the aliased symbol if this is an alias (e.g., import binding).
 */
function getAliasedSymbol(
  sym: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  try {
    if (sym.flags & ts.SymbolFlags.Alias) {
      return checker.getAliasedSymbol(sym);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Get top-level symbols declared by a statement.
 */
function getTopLevelSymbols(
  stmt: ts.Statement,
  checker: ts.TypeChecker,
): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];

  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    const sym = checker.getSymbolAtLocation(stmt.name);
    if (sym) symbols.push(sym);
  } else if (ts.isClassDeclaration(stmt) && stmt.name) {
    const sym = checker.getSymbolAtLocation(stmt.name);
    if (sym) symbols.push(sym);
  } else if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const sym = checker.getSymbolAtLocation(decl.name);
        if (sym) symbols.push(sym);
      }
    }
  } else if (ts.isEnumDeclaration(stmt)) {
    const sym = checker.getSymbolAtLocation(stmt.name);
    if (sym) symbols.push(sym);
  } else if (ts.isInterfaceDeclaration(stmt)) {
    const sym = checker.getSymbolAtLocation(stmt.name);
    if (sym) symbols.push(sym);
  } else if (ts.isTypeAliasDeclaration(stmt)) {
    const sym = checker.getSymbolAtLocation(stmt.name);
    if (sym) symbols.push(sym);
  }

  return symbols;
}

/**
 * Get declared names from a statement.
 */
function getDeclaredNames(stmt: ts.Statement): string[] {
  const names: string[] = [];

  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    names.push(stmt.name.text);
  } else if (ts.isClassDeclaration(stmt) && stmt.name) {
    names.push(stmt.name.text);
  } else if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      }
    }
  } else if (ts.isEnumDeclaration(stmt)) {
    names.push(stmt.name.text);
  } else if (ts.isInterfaceDeclaration(stmt)) {
    names.push(stmt.name.text);
  } else if (ts.isTypeAliasDeclaration(stmt)) {
    names.push(stmt.name.text);
  }

  return names;
}

/**
 * Check if a statement has the `export` modifier.
 */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Conservative check for side-effect statements.
 * These are always kept regardless of whether they're referenced.
 */
function isSideEffectStatement(stmt: ts.Statement): boolean {
  // Import declarations are always kept (they drive module loading)
  if (ts.isImportDeclaration(stmt)) return true;

  // Export declarations with module specifiers (re-exports)
  if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) return true;

  // Expression statements (top-level calls, assignments, etc.)
  if (ts.isExpressionStatement(stmt)) return true;

  return false;
}

/**
 * Get the set of exported names from an entry source file.
 */
export function getEntryExportNames(entryFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of entryFile.statements) {
    if (hasExportModifier(stmt)) {
      names.push(...getDeclaredNames(stmt));
    }
  }
  return names;
}
