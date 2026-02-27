import ts from "typescript";

interface ClassUsageInfo {
  constructorArgCounts: number[];
  properties: Set<string>;
  methods: Map<string, number>; // method name → max arg count
}

interface NestedNamespaceInfo {
  properties: Set<string>;
  methods: Map<string, number>; // method name → max arg count
}

/**
 * Pre-process source code to replace import statements with auto-generated
 * declare blocks based on usage analysis.
 *
 * Handles:
 * - `import * as X from "mod"` → `declare namespace X { ... }`
 * - `import X from "mod"` → `declare const X: any;`
 * - `import { a, b } from "mod"` → `declare function a(...): any;` or `declare const a: any;`
 */
export function preprocessImports(source: string): string {
  const sf = ts.createSourceFile(
    "__preprocess__.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  // Step 1: Find all imports
  const nsImports = new Map<string, { start: number; end: number }>();
  const otherImports: {
    start: number;
    end: number;
    defaultName?: string;
    namedBindings?: string[];
  }[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const clause = stmt.importClause;
    if (!clause) {
      // Side-effect import: `import "mod"` — just remove
      otherImports.push({ start: stmt.getStart(sf), end: stmt.end });
      continue;
    }

    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      // import * as X from "mod"
      const name = clause.namedBindings.name.text;
      nsImports.set(name, { start: stmt.getStart(sf), end: stmt.end });
      continue;
    }

    // Default and/or named imports
    const defaultName = clause.name?.text;
    const namedBindings: string[] = [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        namedBindings.push(el.name.text);
      }
    }
    otherImports.push({
      start: stmt.getStart(sf),
      end: stmt.end,
      defaultName,
      namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
    });
  }

  if (nsImports.size === 0 && otherImports.length === 0) return source;

  // Collect names already defined in the source (functions, variables, classes)
  // to avoid generating conflicting declare stubs
  const definedNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      definedNames.add(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          definedNames.add(decl.name.text);
        }
      }
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      definedNames.add(stmt.name.text);
    }
  }

  // Step 2: Analyze usage for namespace imports
  const namespaces = new Map<string, Map<string, ClassUsageInfo>>();
  const nestedNs = new Map<string, Map<string, NestedNamespaceInfo>>();
  for (const ns of nsImports.keys()) {
    namespaces.set(ns, new Map());
    nestedNs.set(ns, new Map());
  }

  // Track typed variables: varName → { ns, className }
  const typedVars = new Map<string, { ns: string; className: string }>();

  // Track which named/default imports are called as functions
  const calledAsFunction = new Set<string>();
  const maxCallArgs = new Map<string, number>();

  function getOrCreateClass(ns: string, className: string): ClassUsageInfo {
    const classes = namespaces.get(ns)!;
    if (!classes.has(className)) {
      classes.set(className, {
        constructorArgCounts: [],
        properties: new Set(),
        methods: new Map(),
      });
    }
    return classes.get(className)!;
  }

  function getOrCreateNestedNs(ns: string, subNs: string): NestedNamespaceInfo {
    const map = nestedNs.get(ns)!;
    if (!map.has(subNs)) {
      map.set(subNs, { properties: new Set(), methods: new Map() });
    }
    return map.get(subNs)!;
  }

  function tryResolveQualifiedName(
    typeRef: ts.TypeReferenceNode,
  ): { ns: string; className: string } | null {
    if (ts.isQualifiedName(typeRef.typeName)) {
      if (
        ts.isIdentifier(typeRef.typeName.left) &&
        nsImports.has(typeRef.typeName.left.text)
      ) {
        return {
          ns: typeRef.typeName.left.text,
          className: typeRef.typeName.right.text,
        };
      }
    }
    return null;
  }

  function visit(node: ts.Node) {
    // new X.Y(args...)
    if (
      ts.isNewExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      if (
        ts.isIdentifier(node.expression.expression) &&
        nsImports.has(node.expression.expression.text)
      ) {
        const ns = node.expression.expression.text;
        const cls = getOrCreateClass(ns, node.expression.name.text);
        cls.constructorArgCounts.push(node.arguments?.length ?? 0);
      }
    }

    // X.Y.method() — nested namespace access (e.g., THREE.MathUtils.lerp())
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const outer = node.expression.expression;
      if (
        ts.isIdentifier(outer.expression) &&
        nsImports.has(outer.expression.text)
      ) {
        const ns = outer.expression.text;
        const subNsName = outer.name.text;
        const methodName = node.expression.name.text;
        const info = getOrCreateNestedNs(ns, subNsName);
        const existing = info.methods.get(methodName) ?? 0;
        info.methods.set(methodName, Math.max(existing, node.arguments.length));
      }
    }

    // X.Y.prop (nested namespace property access, not a call)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      nsImports.has(node.expression.expression.text) &&
      !(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const ns = node.expression.expression.text;
      const subNsName = node.expression.name.text;
      // Only if not already treated as a class
      const classes = namespaces.get(ns)!;
      if (!classes.has(subNsName)) {
        const info = getOrCreateNestedNs(ns, subNsName);
        info.properties.add(node.name.text);
      }
    }

    // Parameter with type X.Y
    if (ts.isParameter(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info && ts.isIdentifier(node.name)) {
        getOrCreateClass(info.ns, info.className);
        typedVars.set(node.name.text, info);
      }
    }

    // Variable declaration with type X.Y
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      ts.isTypeReferenceNode(node.type)
    ) {
      const info = tryResolveQualifiedName(node.type);
      if (info && ts.isIdentifier(node.name)) {
        getOrCreateClass(info.ns, info.className);
        typedVars.set(node.name.text, info);
      }
    }

    // Return type X.Y on function declarations
    if (
      ts.isFunctionDeclaration(node) &&
      node.type &&
      ts.isTypeReferenceNode(node.type)
    ) {
      const info = tryResolveQualifiedName(node.type);
      if (info) {
        getOrCreateClass(info.ns, info.className);
      }
    }

    // Property access on typed variable: varName.prop or varName.method()
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const varInfo = typedVars.get(node.expression.text);
      if (varInfo) {
        const cls = getOrCreateClass(varInfo.ns, varInfo.className);
        const memberName = node.name.text;

        if (
          node.parent &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node
        ) {
          // Method call
          const existing = cls.methods.get(memberName) ?? 0;
          cls.methods.set(
            memberName,
            Math.max(existing, node.parent.arguments.length),
          );
        } else {
          // Property access (read or write)
          cls.properties.add(memberName);
        }
      }
    }

    // Track calls to named/default imported identifiers: func(args...)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const name = node.expression.text;
      calledAsFunction.add(name);
      const existing = maxCallArgs.get(name) ?? 0;
      maxCallArgs.set(name, Math.max(existing, node.arguments.length));
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // Step 3: Generate replacements
  const replacements: { start: number; end: number; text: string }[] = [];

  // Namespace imports → declare namespace
  for (const [nsName, { start, end }] of nsImports) {
    const classes = namespaces.get(nsName)!;
    const nested = nestedNs.get(nsName)!;

    if (classes.size === 0 && nested.size === 0) {
      replacements.push({
        start,
        end,
        text: `/* import ${nsName}: no usage detected */`,
      });
      continue;
    }

    let declare = `declare namespace ${nsName} {\n`;

    // Classes
    for (const [className, usage] of classes) {
      declare += `  class ${className} {\n`;

      const maxCtorArgs = Math.max(0, ...usage.constructorArgCounts);
      if (maxCtorArgs > 0) {
        const params = Array.from(
          { length: maxCtorArgs },
          (_, i) => `a${i}: any`,
        ).join(", ");
        declare += `    constructor(${params});\n`;
      } else {
        declare += `    constructor(...args: any[]);\n`;
      }

      for (const prop of usage.properties) {
        declare += `    ${prop}: any;\n`;
      }

      for (const [method, argCount] of usage.methods) {
        const params = Array.from(
          { length: argCount },
          (_, i) => `a${i}: any`,
        ).join(", ");
        declare += `    ${method}(${params}): any;\n`;
      }

      declare += `  }\n`;
    }

    // Nested namespaces (e.g., THREE.MathUtils)
    for (const [subNsName, info] of nested) {
      // Skip if already registered as a class
      if (classes.has(subNsName)) continue;

      declare += `  namespace ${subNsName} {\n`;
      for (const prop of info.properties) {
        declare += `    const ${prop}: any;\n`;
      }
      for (const [method, argCount] of info.methods) {
        const params = Array.from(
          { length: argCount },
          (_, i) => `a${i}: any`,
        ).join(", ");
        declare += `    function ${method}(${params}): any;\n`;
      }
      declare += `  }\n`;
    }

    declare += `}`;
    replacements.push({ start, end, text: declare });
  }

  // Default and named imports → declare stubs
  for (const imp of otherImports) {
    const lines: string[] = [];

    if (imp.defaultName && !definedNames.has(imp.defaultName)) {
      if (calledAsFunction.has(imp.defaultName)) {
        const argCount = maxCallArgs.get(imp.defaultName) ?? 0;
        const params = Array.from(
          { length: argCount },
          (_, i) => `a${i}: any`,
        ).join(", ");
        lines.push(`declare function ${imp.defaultName}(${params}): any;`);
      } else {
        lines.push(`declare const ${imp.defaultName}: any;`);
      }
    }

    if (imp.namedBindings) {
      for (const name of imp.namedBindings) {
        // Skip if the name is already defined as a function/variable/class in source
        if (definedNames.has(name)) continue;

        if (calledAsFunction.has(name)) {
          const argCount = maxCallArgs.get(name) ?? 0;
          const params = Array.from(
            { length: argCount },
            (_, i) => `a${i}: any`,
          ).join(", ");
          lines.push(`declare function ${name}(${params}): any;`);
        } else {
          lines.push(`declare const ${name}: any;`);
        }
      }
    }

    replacements.push({
      start: imp.start,
      end: imp.end,
      text: lines.length > 0 ? lines.join("\n") : `/* side-effect import removed */`,
    });
  }

  // Apply replacements in reverse order to preserve positions
  let result = source;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }

  return result;
}
