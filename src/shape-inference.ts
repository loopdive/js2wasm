/**
 * Shape inference pre-pass: scan source files for variables used as array-like objects.
 *
 * Detects patterns like:
 *   var obj: any = {};
 *   obj.length = 3;
 *   obj[0] = 10;
 *   Array.prototype.indexOf.call(obj, ...)
 *
 * These variables are inferred to have array-like shape and can be compiled
 * as WasmGC vec structs instead of externref/AnyValue.
 */
import ts from "typescript";

export interface InferredShape {
  /** Named fields set on the variable (e.g. "length") with inferred types */
  fields: Map<string, { type: "number" | "string" | "boolean" | "unknown" }>;
  /** Whether numeric indexing is used (obj[0] = x) */
  hasNumericIndexing: boolean;
  /** Type of values stored at numeric indices */
  numericValueType: "number" | "string" | "unknown";
  /** Whether the variable is used in Array.prototype.X.call(obj, ...) */
  usedInCallApply: boolean;
  /** Highest literal numeric index seen */
  maxNumericIndex: number;
}

/**
 * Collect shape information for module-level variables by walking the AST.
 * Returns a map from variable name to inferred shape.
 */
export function collectShapes(checker: ts.TypeChecker, sourceFile: ts.SourceFile): Map<string, InferredShape> {
  const shapes = new Map<string, InferredShape>();

  function getOrCreate(name: string): InferredShape {
    let shape = shapes.get(name);
    if (!shape) {
      shape = {
        fields: new Map(),
        hasNumericIndexing: false,
        numericValueType: "unknown",
        maxNumericIndex: -1,
        usedInCallApply: false,
      };
      shapes.set(name, shape);
    }
    return shape;
  }

  function inferTypeCategory(tsType: ts.Type): "number" | "string" | "boolean" | "unknown" {
    if (tsType.flags & ts.TypeFlags.NumberLike) return "number";
    if (tsType.flags & ts.TypeFlags.StringLike) return "string";
    if (tsType.flags & ts.TypeFlags.BooleanLike) return "boolean";
    return "unknown";
  }

  function visit(node: ts.Node): void {
    // Detect: obj.foo = expr (property assignment)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      const varName = node.left.expression.text;
      const propName = node.left.name.text;
      const valType = checker.getTypeAtLocation(node.right);
      const shape = getOrCreate(varName);
      shape.fields.set(propName, { type: inferTypeCategory(valType) });
    }

    // Detect: obj[numericLiteral] = expr (numeric index assignment)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      ts.isNumericLiteral(node.left.argumentExpression)
    ) {
      const varName = node.left.expression.text;
      const idx = parseInt(node.left.argumentExpression.text, 10);
      const valType = checker.getTypeAtLocation(node.right);
      const shape = getOrCreate(varName);
      shape.hasNumericIndexing = true;
      if (idx > shape.maxNumericIndex) shape.maxNumericIndex = idx;
      const valCategory = inferTypeCategory(valType);
      if (valCategory === "number" || valCategory === "string") {
        shape.numericValueType = valCategory;
      }
    }

    // Detect: Array.prototype.X.call(obj, ...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const methodAccess = node.expression.expression;
      // Check for Array.prototype.METHOD pattern
      if (
        ts.isPropertyAccessExpression(methodAccess.expression) &&
        ts.isIdentifier(methodAccess.expression.expression) &&
        methodAccess.expression.expression.text === "Array" &&
        methodAccess.expression.name.text === "prototype"
      ) {
        // First argument to .call() is the receiver
        if (node.arguments.length >= 1 && ts.isIdentifier(node.arguments[0]!)) {
          const varName = node.arguments[0]!.text;
          const shape = getOrCreate(varName);
          shape.usedInCallApply = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Filter: only keep variables that look like array-likes
  // (have both numeric indexing and a length field, or are used in call/apply)
  const result = new Map<string, InferredShape>();
  for (const [name, shape] of shapes) {
    const isArrayLike = shape.hasNumericIndexing && shape.fields.has("length");
    if (isArrayLike || (shape.usedInCallApply && shape.hasNumericIndexing)) {
      result.set(name, shape);
    }
  }

  return result;
}
